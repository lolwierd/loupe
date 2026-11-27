// Stacks: the changes a change sits on and the ones built on it. In order of authority:
//   1. GitHub's own stacks (gh stack; REST repos/{o}/{r}/stacks?pull_request=N);
//   2. PRs based on each other, which can branch;
//   3. commits off the trunk, including local branch creation records.
// An entry opens its checkout when there is one, else its PR.
import { git } from './util.mjs';
import * as GH from './github.mjs';

const cache = new WeakMap();
const localPrefix = 'refs/heads/';
const remotePrefix = 'refs/remotes/origin/';
// Reading a missing object in a partial clone must not fetch it behind the stack reader's back.
const offline = { env: { GIT_NO_LAZY_FETCH: '1' } };
const read = (root, args, opts) => git(root, args, { ...offline, ...opts }).catch(() => '');
const lines = (out) => out.split('\n').filter(Boolean);
const branchOf = (ref) => ref.replace(/^(refs\/heads\/|refs\/remotes\/origin\/)/, '');

export async function localTrunk(root) {
  const remote = (await read(root, ['symbolic-ref', 'refs/remotes/origin/HEAD'])).trim();
  for (const ref of new Set([remote, remotePrefix + 'main', remotePrefix + 'master', localPrefix + 'main', localPrefix + 'master'])) {
    if (ref && (await read(root, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])).trim()) return ref;
  }
  return 'HEAD';
}

export async function stackSnapshot(root) {
  // A new branch or worktree changes the stack even when the checkout's HEAD and diff haven't moved.
  const [refs, worktrees] = await Promise.all([
    read(root, ['for-each-ref', '--format=%(refname)%09%(objectname)%09%(symref)', localPrefix, remotePrefix]),
    read(root, ['worktree', 'list', '--porcelain', '-z']),
  ]);
  return { refs, worktrees, key: refs + '\0' + worktrees };
}

function checkouts(worktrees) {
  const map = new Map();
  let wt, ref;
  for (const field of worktrees.split('\0')) {
    if (!field) {
      if (wt && ref) map.set(ref, wt);
      wt = ref = null;
    } else if (field.startsWith('worktree ')) wt = field.slice(9);
    else if (field.startsWith('branch ')) ref = field.slice(7);
    else if (field.startsWith('prunable')) wt = null;
  }
  return map;
}

async function localGraph(root, trunk, refs) {
  const branches = new Map(lines(refs).map((line) => line.split('\t')).filter(([, , symref]) => !symref));
  const resolveRef = (name) => {
    if (branches.has(name)) return name;
    // A short tracking ref can have the same spelling as a local branch.
    if (name?.startsWith('origin/') && branches.has('refs/remotes/' + name)) return 'refs/remotes/' + name;
    const local = localPrefix + name;
    return branches.has(local) ? local : name;
  };
  const trunkRef = resolveRef(trunk);
  if (!trunkRef) return null;
  const trunkSha = (await read(root, ['rev-parse', '--verify', '--quiet', `${trunkRef}^{commit}`])).trim();
  if (!trunkSha) return null;
  const out = await read(root, ['rev-list', '--first-parent', '--parents', '--branches', '--remotes=origin', '--not', trunkSha]);
  const parents = new Map(lines(out).map((line) => line.split(' ', 2)));
  const logs = new Map(), histories = new Map(), integrated = new Map(), trunkPatches = new Map(), choices = new Map();
  let headLog;
  const reflogDate = (selector) => selector?.slice(selector.lastIndexOf('@{'));
  const log = (ref) => {
    if (!logs.has(ref)) logs.set(ref, read(root, ['reflog', 'show', '--date=raw', '--format=%H%x09%gD%x09%gs', ref]).then(lines));
    return logs.get(ref);
  };
  const sources = new Map();
  const source = (ref) => {
    if (!sources.has(ref)) sources.set(ref, creation(ref));
    return sources.get(ref);
  };
  const creation = async (ref) => {
    const entry = (await log(ref)).at(-1);
    const [sha, selector, action] = entry?.split('\t') || [];
    let from = /^branch: Created from (.+)$/.exec(action || '')?.[1];
    if (!from) return {};
    if (from === 'HEAD') {
      // checkout -b records HEAD. Look for its checkout entry from any worktree of the clone.
      headLog ||= read(root, ['reflog', 'show', '--all', '--date=raw', '--format=%gD%x09%H%x09%gs']).then(lines);
      const matches = (await headLog).map((line) => line.split('\t'))
        .filter(([head, at, msg]) => /(?:^|\/)HEAD@\{/.test(head) && at === sha && reflogDate(head) === reflogDate(selector) && msg.endsWith(` to ${branchOf(ref)}`))
        .map(([, , msg]) => /^checkout: moving from (.+) to /.exec(msg)?.[1]).filter(Boolean);
      from = new Set(matches).size === 1 ? matches[0] : null;
    }
    if (!from) return { sha, ref: null };
    const local = localPrefix + from;
    const named = branches.has(local) ? local : resolveRef(from);
    return { sha, ref: branches.has(named) ? named : null };
  };
  const history = (tip) => {
    if (!histories.has(tip)) {
      const chain = new Map();
      for (let at = tip; parents.has(at); at = parents.get(at)) chain.set(at, chain.size);
      histories.set(tip, chain);
    }
    return histories.get(tip);
  };
  const landed = (tip) => {
    if (!integrated.has(tip)) integrated.set(tip, (async () => {
      if (!parents.has(tip)) return true; // in the trunk's history: landed by a merge, or never off it
      const cherry = lines(await read(root, ['cherry', trunkSha, tip]));
      if (cherry.length && cherry.every((line) => line.startsWith('- '))) {
        // cherry skips merge commits, which can have changes of their own.
        const merges = await read(root, ['rev-list', '--merges', `${trunkSha}..${tip}`]);
        if (!merges.trim()) return true;
      }
      // A squash of several commits has one patch on the trunk. Compare the whole change since the fork with the trunk
      // commits since then that touch the same files (a squash touches exactly those), at most 50 of them: reading every
      // trunk patch since an old fork took tens of seconds in a large repository.
      const fork = (await read(root, ['merge-base', trunkSha, tip])).trim();
      if (!fork) return false;
      const files = lines(await read(root, ['diff', '--no-ext-diff', '--no-renames', '--name-only', fork, tip]));
      if (!files.length || files.length > 200) return false;
      const patch = await read(root, ['diff', '--no-ext-diff', '--no-renames', fork, tip]);
      const id = patch && (await read(root, ['patch-id', '--verbatim'], { input: patch })).split(' ')[0];
      if (!id) return false;
      const key = fork + '\0' + files.join('\0');
      if (!trunkPatches.has(key)) trunkPatches.set(key, (async () => {
        // the trunk's first-parent commits since the fork that touch the files, newest first (the first-parent diff of a
        // merge counts as its patch)
        const commits = await read(root, ['log', '--first-parent', '--diff-merges=first-parent', '--no-ext-diff', '--no-renames', '-p', '-n', '50', `${fork}..${trunkSha}`, '--', ...files]);
        const ids = commits && await read(root, ['patch-id', '--verbatim'], { input: commits });
        return new Set(lines(ids || '').map((line) => line.split(' ')[0]));
      })());
      return (await trunkPatches.get(key)).has(id);
    })());
    return integrated.get(tip);
  };

  const parentOf = (ref) => {
    if (!choices.has(ref)) choices.set(ref, findParent(ref));
    return choices.get(ref);
  };
  async function findParent(ref) {
    const tip = branches.get(ref);
    if (!tip || !parents.has(tip) || branchOf(ref) === branchOf(trunkRef)) return null;
    const chain = history(tip);
    const eligible = (other) => branchOf(other) !== branchOf(ref) && branchOf(other) !== branchOf(trunkRef);
    let created = await source(ref);
    // A creation chain between equal tips has to end somewhere to establish their order.
    if (created.sha === tip) {
      const seen = new Set([ref]);
      let at = created.ref;
      while (branches.get(at) === tip && !seen.has(at)) {
        seen.add(at);
        const edge = await source(at);
        at = edge.sha === tip ? edge.ref : null;
      }
      if (seen.has(at)) created = {};
    }
    const floor = chain.get(created.sha);
    const cut = floor !== undefined && !await landed(created.sha) ? created.sha : null;
    const choice = (other, sha) => ({ ref: other, branch: branchOf(other), base: branches.get(other) === sha ? other : sha, sha });
    const unnamed = (sha, candidates = []) => ({ ref: null, branch: null, base: sha, sha, candidates });
    const byDistance = new Map();
    if (cut) byDistance.set(floor, []);
    for (const [other, sha] of branches) {
      const n = chain.get(sha);
      if (!eligible(other) || !(n > 0 || sha === cut) || (cut && n > floor)) continue;
      if (!byDistance.has(n)) byDistance.set(n, []);
      byDistance.get(n).push(other);
    }
    if (!byDistance.size || await landed(tip)) return null;

    const name = branchOf(created.ref || '');
    for (const [, refs] of [...byDistance].sort(([a], [b]) => a - b)) {
      const sha = branches.get(refs[0]) || cut;
      if (await landed(sha)) continue;
      const possible = new Map();
      for (const other of refs) {
        const origin = await source(other);
        // A child left at the cut point doesn't become its parent's base.
        if (origin.sha === sha && origin.ref && branchOf(origin.ref) === branchOf(ref)) continue;
        const branch = branchOf(other);
        if (!possible.has(branch)) possible.set(branch, choice(other, sha));
      }
      // A parent that moved can still name the cut when its history or reflog proves it.
      if (sha === cut && created.ref && eligible(created.ref) && !possible.has(name)) {
        const otherTip = branches.get(created.ref);
        const otherHistory = history(otherTip);
        if ((tip === cut || otherTip === tip || !otherHistory.has(tip))
          && (otherHistory.has(cut) || (await log(created.ref)).some((entry) => entry.startsWith(cut + '\t')))) {
          possible.set(name, choice(created.ref, cut));
        }
      }
      const named = possible.get(name);
      if (named || possible.size === 1) return named || possible.values().next().value;
      if (possible.size > 1) return cut ? unnamed(sha, [...possible.keys()]) : null;
    }
    return cut ? unnamed(cut) : null;
  }

  return { branches, trunkRef, trunkSha, history, landed, log, parentOf };
}

export async function localParent(root, branch, trunk, snapshot) {
  if (!branch || branch === 'HEAD') return null;
  const graph = await localGraph(root, trunk, (snapshot || await stackSnapshot(root)).refs);
  return graph?.parentOf(localPrefix + branch) ?? null;
}

const prItem = (p) => ({
  pr: p.number, branch: p.headRefName || p.head_ref || p.head?.ref, title: p.title || '',
  state: String(p.state || '').toLowerCase(), draft: !!(p.isDraft ?? p.draft),
  merged: !!(p.mergedAt || p.merged_at || p.merged || String(p.state).toLowerCase() === 'merged'),
  crossRepo: !!(p.isCrossRepository ?? p.crossRepo ?? (p.head?.repo?.full_name && p.base?.repo?.full_name && p.head.repo.full_name !== p.base.repo.full_name)),
});

const prFields = 'number,title,headRefName,baseRefName,headRefOid,baseRefOid,isDraft,state,isCrossRepository,mergedAt';
const prList = (repo, state, limit, extra = [], fields = prFields) => GH.ghJson(['pr', 'list', '--repo', repo, '--state', state, '--limit', String(limit), '--json', fields, ...extra]);
const openPRLimit = 1000;

// The recently merged PRs into a trunk, shared for a few seconds by every read that asks (a head start and its use).
const mergedReads = new Map();
function mergedPRs(repo, trunk) {
  const key = repo + '\0' + trunk, hit = mergedReads.get(key);
  if (hit && Date.now() - hit.at < 10000) return hit.value;
  const value = prList(repo, 'merged', 200, ['--base', trunk], prFields + ',mergeCommit').catch(() => []);
  mergedReads.set(key, { at: Date.now(), value });
  return value;
}

async function listClosedPRs(repo, head) {
  // gh paginates to --limit. A full result can have another relevant PR beyond it.
  for (let limit = 201; ; limit *= 2) {
    const list = await prList(repo, 'closed', limit, ['--head', head]);
    if (list.length < limit) return list;
  }
}

async function githubStack(repo, number) {
  const stacks = await GH.ghJson(['api', `repos/${repo}/stacks?pull_request=${number}`]).catch(() => []);
  return Array.isArray(stacks) ? stacks.find((s) => s.pull_requests?.some((p) => p.number === number)) : null;
}

function prGraph(repo, open, trunk) {
  // Past the cap the list is a sample, and a sample proves nothing: not which PR a branch has, nor that a base has
  // none. So loupe infers no PR stack from it, as when the list cannot be read; GitHub's own stacks and the local
  // branches still show. (Three rounds of patching the cases a cut-off list gets wrong ended here.)
  if ((open || []).length >= openPRLimit) open = null;
  const list = open || [];
  const byHead = new Map(), byBase = new Map();
  for (const p of list) {
    if (!byBase.has(p.baseRefName)) byBase.set(p.baseRefName, []);
    byBase.get(p.baseRefName).push(p);
    if (p.isCrossRepository) continue;
    if (!byHead.has(p.headRefName)) byHead.set(p.headRefName, []);
    byHead.get(p.headRefName).push(p);
  }
  const fromBranch = (branch, oid) => {
    const matches = byHead.get(branch);
    return matches?.length === 1 ? matches[0] : null;
  };
  const openParent = (p) => p?.baseRefName && p.baseRefName !== trunk ? fromBranch(p.baseRefName, p.baseRefOid) : null;
  const byTip = new Map();
  for (const p of list) {
    if (!isOid(p.headRefOid)) continue;
    if (!byTip.has(p.headRefOid)) byTip.set(p.headRefOid, []);
    byTip.get(p.headRefOid).push(p);
  }
  // A unique name in a complete list survives new local commits or a rebase. An alternate name needs an exact,
  // unambiguous head match.
  const changeFor = (branch, oid) => fromBranch(branch, oid)
    || (!byHead.has(branch) && byTip.get(oid)?.length === 1 ? byTip.get(oid)[0] : null);
  const historic = new Map();
  const previous = (p) => {
    const base = p.baseRefName;
    if (!base || base === trunk) return null;
    if (byHead.has(base)) return openParent(p);
    // If the open read succeeded and showed no PR for this base, a closed PR with the exact head can explain it.
    if (!open || !isOid(p.baseRefOid)) return null;
    if (!historic.has(base)) historic.set(base, listClosedPRs(repo, base).catch(() => []));
    return historic.get(base).then((prs) => prs.find((old) => !old.isCrossRepository && old.headRefOid === p.baseRefOid && old.state === 'CLOSED'));
  };
  const below = async (p, seen) => {
    const items = [];
    let parent = await previous(p);
    while (parent && !seen.has(parent.number)) {
      seen.add(parent.number);
      items.unshift(prItem(parent));
      p = parent;
      parent = await previous(p);
    }
    // A release branch with no PR underneath is the base of that stack. A cycle has no such boundary.
    return { items, trunk: (parent ? trunk : p.baseRefName || trunk) || null };
  };
  const above = (p, seen) => {
    const queue = [{ p, sibling: false }], items = [];
    for (let i = 0; i < queue.length; i++) {
      const { p: next, sibling } = queue[i];
      const item = prItem(next);
      if (i) items.push({ ...item, sibling });
      if (item.crossRepo || !item.branch || item.branch === trunk) continue;
      const kids = (byBase.get(item.branch) || []).filter((kid) => !seen.has(kid.number));
      kids.forEach((kid, j) => { seen.add(kid.number); queue.push({ p: kid, sibling: j > 0 }); });
    }
    return items;
  };
  return { list, trunk, fromBranch, changeFor, openParent, below, above };
}

const commitPRLimit = 250;
const commitBatchSize = 25;
const commitFields = 'number headRefOid commits(last: 100) { nodes { commit { oid } } }';
const commitReads = new Map();

function commitQuery(repo, fields) {
  const [owner, name] = repo.split('/');
  const query = `query StackCommits($owner: String!, $name: String!) {
    repository(owner: $owner, name: $name) { ${fields} }
  }`;
  return GH.ghJson(['api', 'graphql', '-f', `query=${query}`, '-f', `owner=${owner}`, '-f', `name=${name}`])
    .then((data) => data.errors?.length ? null : data.data?.repository).catch(() => null);
}

const commitKey = (number, oid) => number + ':' + oid;
function rememberCommits(histories, p) {
  if (isOid(p?.headRefOid) && Array.isArray(p.commits?.nodes)) {
    histories.set(commitKey(p.number, p.headRefOid), p.commits.nodes.map((n) => n?.commit?.oid).filter(Boolean).reverse());
  }
}

function startCommitLists(repo) {
  let reads = commitReads.get(repo);
  if (reads) return reads;
  reads = { histories: new Map(), pending: new Map() };
  commitReads.set(repo, reads);
  // On a cold read, the PR numbers arrive too late for a second trip. Read both ends of the same ordered
  // connection in one query alongside the open list. Together they cover up to 200 open PRs.
  const open = 'states: OPEN, orderBy: {field: CREATED_AT, direction: DESC}';
  reads.bootstrap = commitQuery(repo, `
    newest: pullRequests(${open}, first: 100) { nodes { ${commitFields} } }
    oldest: pullRequests(${open}, last: 100) { nodes { ${commitFields} } }
  `).then((r) => {
    if (!r) return null;
    const prs = [...(r.newest?.nodes || []), ...(r.oldest?.nodes || [])];
    for (const p of prs) rememberCommits(reads.histories, p);
    return new Set(prs.map((p) => p?.number));
  });
  reads.bootstrap.then((covered) => {
    reads.bootstrap = null;
    if (!covered) commitReads.delete(repo);
  });
  return reads;
}

async function openCommitLists(repo, reads, bootstrap, missing) {
  if (!missing.size) return new Map();
  const covered = await bootstrap;
  const { histories, pending } = reads;
  const unknown = [...missing].filter(([n, oid]) => !histories.has(commitKey(n, oid))
    && !covered?.has(n) && !pending.has(commitKey(n, oid)));
  // One failed trip is enough. Likewise, if a head moved while we read it, try on the next read.
  if (!bootstrap || covered) {
    for (let i = 0; i < unknown.length; i += commitBatchSize) {
      const batch = unknown.slice(i, i + commitBatchSize);
      const request = commitQuery(repo, batch.map(([n]) => `pr${n}: pullRequest(number: ${n}) { ${commitFields} }`).join('\n'))
        .then((result) => {
          for (const [n, oid] of batch) {
            const p = result?.['pr' + n];
            if (p?.number === n && p.headRefOid === oid) rememberCommits(histories, p);
            pending.delete(commitKey(n, oid));
          }
        });
      for (const [n, oid] of batch) pending.set(commitKey(n, oid), request);
    }
  }
  await Promise.all(new Set([...missing].map(([n, oid]) => pending.get(commitKey(n, oid))).filter(Boolean)));
  return new Map([...missing].map(([n, oid]) => [n, histories.get(commitKey(n, oid))]));
}

const isOid = (oid) => /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(oid);
const prKey = (number) => '#' + number;
function prAtCut(cut, prs) {
  const matches = prs.filter((p) => !p.isCrossRepository && p.state === 'OPEN'
    && p.headRefOid === cut.sha && cut.candidates.includes(p.headRefName));
  return matches.length === 1 ? matches[0] : null;
}

async function addCommitStack(root, kind, m, pr, repo, chain, stack, snapshot, refs, local, commitLists) {
  const trunk = chain.trunk;
  if (pr?.state === 'CLOSED' || (kind === 'local' && (!trunk || !m.branch || m.branch === 'HEAD' || m.branch === trunk))) return stack;
  const namespace = kind === 'pr' && pr ? `refs/loupe/pr/${pr.number}/` : null;
  const head = kind === 'pr'
    ? m.headFull || (namespace && (await read(root, ['rev-parse', '--verify', '--quiet', namespace + 'head'])).trim()) || pr?.headRefOid
    : refs.get(localPrefix + m.branch);
  if (!isOid(head)) return stack;
  const trunkRefs = [
    ...(namespace ? [namespace + 'trunk', ...(trunk && pr.baseRefName === trunk ? [namespace + 'base'] : [])] : []),
    ...(trunk ? [remotePrefix + trunk, localPrefix + trunk] : []),
  ];
  let trunkSha;
  for (const ref of trunkRefs) {
    trunkSha = refs.get(ref) || (await read(root, ['rev-parse', '--verify', '--quiet', ref])).trim();
    if (trunkSha) break;
  }
  if (!trunkSha) return stack;

  const own = lines(await read(root, ['rev-list', '--topo-order', `${trunkSha}..${head}`]));
  // No stack can be inferred from a tip on trunk, even if every open PR has that commit.
  if (!own.length) return stack;
  const ownSet = new Set(own);
  const open = chain.list.filter((p) => p.number !== pr?.number && p.state === 'OPEN' && isOid(p.headRefOid));
  const oids = [...new Set(open.map((p) => p.headRefOid))];
  const objects = oids.length ? await read(root, ['cat-file', '--batch-check=%(objectname) %(objecttype)'], { input: oids.join('\n') + '\n' }) : '';
  const available = new Set(lines(objects).filter((line) => line.endsWith(' commit')).map((line) => line.split(' ')[0]));
  const missing = new Map(chain.list.slice(0, commitPRLimit)
    .filter((p) => p.number !== pr?.number && isOid(p.headRefOid) && !available.has(p.headRefOid))
    .map((p) => [p.number, p.headRefOid]));
  const [remoteHistory, merged, history] = await Promise.all([
    commitLists?.(missing) || new Map(),
    trunk ? mergedPRs(repo, trunk) : [],
    read(root, ['rev-list', '--topo-order', '--parents', '--stdin'], {
      input: [head, ...new Set([...refs.values(), ...available]), '^' + trunkSha].join('\n') + '\n',
    }),
  ]);
  const parents = new Map(lines(history).map((line) => {
    const [oid, ...prev] = line.split(' ');
    return [oid, prev];
  }));
  const order = new Map([...parents.keys()].map((oid, i) => [oid, i]));

  const nodes = new Map(), atTip = new Map(), branchCopies = new Map();
  function add(key, oid, item, p) {
    const node = { key, oid, item, p };
    nodes.set(key, node);
    if (!atTip.has(oid)) atTip.set(oid, []);
    atTip.get(oid).push(node);
    return node;
  }
  // The old head must still be in this change, and Git must confirm the merge landed in trunk.
  // An ordinary merge puts the old head on trunk too, so it won't be in ownSet.
  const landed = await Promise.all(merged.filter((p) => ownSet.has(p.headRefOid) && isOid(p.mergeCommit?.oid))
    .map((p) => git(root, ['merge-base', '--is-ancestor', p.mergeCommit.oid, trunkSha], offline).then(() => p, () => null)));
  for (const p of [...open, ...landed.filter(Boolean)]) add(prKey(p.number), p.headRefOid, prItem(p), p);
  const here = add(pr ? prKey(pr.number) : localPrefix + m.branch, head, pr ? prItem(pr) : { branch: m.branch }, pr);
  for (const [ref, oid] of refs) {
    const branch = branchOf(ref);
    if (!parents.has(oid) || branch === trunk) continue;
    const p = chain.changeFor(branch, oid);
    const alias = p && nodes.get(prKey(p.number));
    const copy = branch + '\0' + oid;
    if (!branchCopies.has(copy)) branchCopies.set(copy, alias || nodes.get(ref) || add(ref, oid, { branch, ref }));
  }
  const nodeForRow = (item) => {
    if (item.current) return here;
    if (item.pr) return nodes.get(prKey(item.pr));
    const ref = item.ref || localPrefix + item.branch;
    return branchCopies.get(item.branch + '\0' + refs.get(ref));
  };

  const histories = new Map();
  function commitsOf(node) {
    const { oid, p } = node;
    if (!parents.has(oid)) return remoteHistory.get(p?.number) || [];
    if (!histories.has(oid)) {
      const seen = new Set(), pending = [oid];
      while (pending.length) {
        const at = pending.pop();
        if (seen.has(at) || !parents.has(at)) continue;
        seen.add(at);
        pending.push(...parents.get(at));
      }
      histories.set(oid, [...seen].sort((a, b) => order.get(a) - order.get(b)));
    }
    return histories.get(oid);
  }

  let localTree = local && local.trunkSha === trunkSha ? Promise.resolve(local) : null;
  const refFor = (node) => {
    if (node.item.crossRepo) return null;
    const branch = node.item.branch;
    return [node.item.ref, localPrefix + branch, remotePrefix + branch].find((ref) => refs.get(ref) === node.oid);
  };
  const choices = new Map();
  async function parentOf(node) {
    if (choices.has(node)) return choices.get(node);
    const result = await findParent(node);
    choices.set(node, result);
    return result;
  }
  async function findParent(node) {
    if (node.item.merged) return null;
    // A declared base wins for descendants too, including those discovered through another arm.
    const declared = chain.openParent(node.p);
    if (declared && nodes.has(prKey(declared.number))) return { node: nodes.get(prKey(declared.number)), byCommits: false };
    const ref = refFor(node);
    let named;
    const getNamed = () => {
      if (!ref) return null;
      localTree ||= localGraph(root, trunkSha, snapshot.refs);
      return named ||= localTree.then((tree) => tree?.parentOf(ref));
    };
    const sameChange = (other) => other.key === node.key
      || (!other.item.crossRepo && !node.item.crossRepo && other.item.branch === node.item.branch);
    for (const oid of [node.oid, ...commitsOf(node).filter((oid) => oid !== node.oid)]) {
      // A remote PR's list is relative to its base. Only heads known off trunk can anchor a match.
      const group = (atTip.get(oid) || []).filter((other) => !sameChange(other)
        && (parents.has(oid) || remoteHistory.get(other.p?.number)?.includes(oid))
        && (node.p || other.p || ref));
      if (!group.length) continue;
      if (oid === node.oid || !node.p && group.some((other) => !other.p) || group.length > 1) {
        const cut = await getNamed();
        const namedPR = cut?.sha === oid && cut.candidates?.length ? prAtCut(cut, chain.list) : null;
        const matches = cut?.sha === oid ? group.filter((other) => cut.ref
          ? refFor(other) === cut.ref || (!other.item.crossRepo && other.item.branch === cut.branch)
          : namedPR && other.p?.number === namedPR.number) : [];
        const matched = matches.length === 1 ? matches[0] : matches.find((other) => !other.p);
        if (matched) return { node: matched, byCommits: true };
        if (cut?.sha === oid && cut.candidates?.length) return null;
        // Branch-to-branch ordering retains the reflog, first-parent and patch-equivalence rules.
        if (oid === node.oid) continue;
        const prs = group.filter((other) => other.p || node.p);
        if (prs.length === 1 && group.length === 1) return { node: prs[0], byCommits: true };
        if (group.length > 1) return null;
        continue;
      }
      return { node: group[0], byCommits: true };
    }
    return null;
  }

  const rows = stack.items.length ? [...stack.items] : [{ ...here.item, current: true }];
  let bottom = nodeForRow(rows[0]);
  const seen = new Set(rows.map((row) => nodeForRow(row)?.key || (row.pr && prKey(row.pr))));
  seen.add(here.key);
  const added = (node, byCommits) => ({
    ...node.item, ...(byCommits && { byCommits, oid: node.oid }), ...(stack.kind === 'github' && { notInStack: true }),
  });
  const currentIndex = rows.findIndex((row) => row.current);
  const above = rows.slice(currentIndex).map(nodeForRow).filter(Boolean);
  // A PR head can sit between two local branches even when its own branch isn't in this clone.
  // Preserve the local fallback (including rewritten cuts) unless Git proves a nearer PR.
  if (stack.kind === 'local') {
    for (let i = currentIndex; i > 0; i--) {
      if (!rows[i - 1].byCommits) continue;
      const node = nodeForRow(rows[i]), existing = nodeForRow(rows[i - 1]);
      if (!node || !existing) continue;
      const history = commitsOf(node);
      const boundary = history.indexOf(existing.oid);
      if (boundary < 0) continue;
      const extra = [];
      for (let edge = await parentOf(node); edge?.byCommits; edge = await parentOf(edge.node)) {
        const distance = history.indexOf(edge.node.oid);
        if (!edge.node.p || edge.node.item.merged || seen.has(edge.node.key) || distance < 0 || distance >= boundary) break;
        seen.add(edge.node.key);
        extra.unshift(added(edge.node, true));
      }
      rows.splice(i, 0, ...extra);
    }
  }
  // The bottom of a declared chain can itself be based on an undeclared change.
  while (bottom) {
    const edge = await parentOf(bottom);
    if (!edge || seen.has(edge.node.key)) break;
    bottom = edge.node;
    seen.add(bottom.key);
    rows.unshift(added(bottom, edge.byCommits));
  }
  const children = new Map(), remaining = [];
  for (const node of nodes.values()) {
    if (seen.has(node.key) || node.item.merged) continue;
    remaining.push(node);
    // Only a change that carries this one's head, or names another PR's branch as its base, can be built on it (a
    // grandchild carries the head too). Asking every open PR for its parent read the whole history once per PR: tens
    // of seconds in a large repository.
    if (!chain.openParent(node.p) && !commitsOf(node).includes(here.oid)) continue;
    const edge = await parentOf(node);
    if (!edge) continue;
    if (!children.has(edge.node.key)) children.set(edge.node.key, []);
    children.get(edge.node.key).push({ node, byCommits: edge.byCommits });
  }
  const append = (node, byCommits, sibling) => {
    seen.add(node.key);
    rows.push({ ...added(node, byCommits), sibling });
    above.push(node);
  };
  for (let i = 0; i < above.length; i++) {
    const parent = above[i];
    for (const [j, { node, byCommits }] of (children.get(parent.key) || []).entries()) {
      if (!seen.has(node.key)) append(node, byCommits, j > 0);
    }
  }
  // A PR may declare a base on another line and still carry this change. Keep that evidence
  // in this direction too, while branch-only edges still use the local graph's first-parent rule.
  for (const parent of above) {
    for (const node of remaining) {
      if (seen.has(node.key) || parent.oid === node.oid || (!parent.p && !node.p)) continue;
      if (!parent.item.crossRepo && !node.item.crossRepo && parent.item.branch === node.item.branch) continue;
      if (commitsOf(node).includes(parent.oid)) append(node, true, false);
    }
  }
  return rows.length < 2 ? stack : { ...stack, kind: stack.kind === 'none' ? 'commits' : stack.kind, trunk: stack.trunk || trunk || null, items: rows };
}

// What of a PR a stack is drawn from: a refresh that only changed its conversation, reviews or checks keeps the stack
// it had (each GitHub refresh made a new PR object, and every stack was read again, a second or more each time)
const STACK_PR = ['number', 'state', 'isDraft', 'title', 'headRefName', 'headRefOid', 'baseRefName', 'baseRefOid', 'mergedAt', 'crossRepo', 'isCrossRepository', 'url'];
const stackFields = (pr) => (pr ? STACK_PR.map((k) => pr[k] ?? null) : null);
// The stack the page's Overview asks for. A checkout waits for GitHub's read, which says what PR its branch has. A PR
// has its own record, so its stack is read from that while GitHub's read runs: its answer lands as a 'github' event,
// and the page asks for the stack again then.
export async function pageStack(ws, { fresh = false } = {}) {
  const github = ws.fetchGithub().catch(() => {});
  if (ws.rec.kind !== 'pr') await github;
  return stackFor(ws, { fresh });
}

export async function stackFor(ws, { fresh = false, snapshot, meta = ws.meta, github = ws.github, commits = true } = {}) {
  if (!meta) return { kind: 'none', items: [] };
  snapshot ||= await stackSnapshot(ws.gitDir);
  const { branch, headFull, trunk, base } = meta;
  const fetched = commits && ws.rec.kind === 'pr' && ws.rec.number
    ? await read(ws.gitDir, ['for-each-ref', '--format=%(objectname)', `refs/loupe/pr/${ws.rec.number}/`]) : '';
  const key = JSON.stringify([snapshot.key, branch, headFull, trunk, base, fetched, github?.owner, github?.repo, stackFields(github?.pr), ws.rec.pr]);
  let entries = cache.get(ws);
  if (!entries) cache.set(ws, entries = new Map());
  if (fresh && commits) entries.delete(false);
  const hit = entries.get(commits);
  if (!fresh && hit?.key === key && Date.now() - hit.at < 120000) return hit.value;
  // Share a read for the same state. A slower old request cannot replace a newer cache entry.
  const value = resolve(ws, snapshot, meta, github, commits).catch((e) => ({ kind: 'none', items: [], error: e.message }));
  entries.set(commits, { key, at: Date.now(), value });
  return value;
}

async function resolve(ws, snapshot, m, github, commits) {
  const { gitDir } = ws;
  // The GitHub refresh can lag a checkout, and a branch name can outlive its closed PR.
  const oldPR = github?.pr && github.pr.state !== 'OPEN' && m.headFull && github.pr.headRefOid !== m.headFull;
  let g = ws.rec.kind === 'local' && github?.pr && (github.pr.headRefName !== m.branch || oldPR)
    ? { ...github, pr: null } : github;
  if (commits && ws.rec.kind === 'pr' && !g?.pr && ws.rec.pr) {
    g = { owner: ws.rec.owner, repo: ws.rec.repo, pr: { number: ws.rec.number, ...ws.rec.pr } };
  }
  const repo = g?.owner && `${g.owner}/${g.repo}`;
  const co = checkouts(snapshot.worktrees);
  const refs = new Map(lines(snapshot.refs).map((line) => line.split('\t')).filter(([, , symref]) => !symref));
  const trunkName = m.trunk && m.trunk !== 'the trunk'
    ? m.trunk.replace(/^(refs\/remotes\/origin\/|refs\/heads\/|origin\/)/, '')
    : null;
  let graph, local, commitLists;
  function prHistory() {
    graph ||= (async () => {
      const [list, settings] = await Promise.all([
        // A full result can omit other PRs with the same branch name, so links require matching head OIDs.
        // If no open PR for the base appears in the list, a closed PR with the exact head still qualifies.
        prList(repo, 'open', openPRLimit).catch(() => null),
        trunkName ? null : GH.mergeSettings(g.owner, g.repo),
      ]);
      let trunk = trunkName || settings?.defaultBranchRef?.name;
      if (!trunk && commits) {
        const ref = await localTrunk(gitDir);
        if (ref !== 'HEAD') trunk = branchOf(ref);
      }
      return prGraph(repo, list, trunk);
    })();
    return graph;
  }
  // GitHub's reads take a second or two each in a large repository: the open PRs (and, for a change with commits of
  // its own, the recently merged ones) start now, beside the stacks call, instead of one after another
  if (repo && commits) {
    prHistory().catch(() => {});
    const tip = ws.rec.kind === 'pr' ? m.headFull || g.pr?.headRefOid : refs.get(localPrefix + m.branch);
    if (isOid(tip)) {
      const reads = startCommitLists(repo), bootstrap = reads.bootstrap;
      commitLists = (missing) => openCommitLists(repo, reads, bootstrap, missing);
    }
    if (m.commits?.length) {
      if (trunkName) mergedPRs(repo, trunkName).catch(() => {});
      else if (ws.rec.kind === 'pr' && g.pr?.baseRefName) {
        // When the fetched base is the trunk, its name is already in the PR. Start that read without repo settings.
        const namespace = `refs/loupe/pr/${g.pr.number}/`;
        read(gitDir, ['rev-parse', '--verify', '--quiet', namespace + 'trunk']).then((sha) => {
          if (sha.trim() && sha.trim() === g.pr?.baseRefOid) return mergedPRs(repo, g.pr.baseRefName);
        }).catch(() => {});
      }
    }
    if (ws.rec.kind === 'local' && !g.pr && tip) {
      const chain = await prHistory();
      local = await localGraph(gitDir, m.trunk || m.base, snapshot.refs);
      const cut = await local?.parentOf(localPrefix + m.branch);
      // At a recorded cut, an equal PR head may be the parent. It doesn't make this checkout that PR.
      const current = cut?.sha === tip ? chain.fromBranch(m.branch) : chain.changeFor(m.branch, tip);
      if (current) g = { ...g, pr: current };
    }
  }

  if (repo && g.pr) {
    const number = g.pr.number;
    const s = await githubStack(repo, number);
    if (s) {
      // The open read is already underway. Only published stacks with historical entries need another read.
      const open = commits ? (await prHistory()).list : [];
      const known = new Set([number, ...open.map((p) => p.number)]);
      const recent = s.pull_requests.some((p) => !known.has(p.number))
        ? await prList(repo, 'all', 200).catch(() => []) : [];
      const list = [...open, ...recent];
      const details = new Map(list.map((p) => [p.number, p]));
      details.set(number, g.pr);
      const items = await Promise.all(s.pull_requests.map(async (p) => {
        // The stack can contain a PR older than the recent list, including a closed or fork PR.
        const detail = details.get(p.number) || await GH.ghJson(['pr', 'view', String(p.number), '--repo', repo, '--json', prFields]).catch(() => null);
        const item = prItem(p), extra = detail && prItem(detail);
        return { ...item, branch: item.branch || extra?.branch, title: extra?.title || item.title,
          state: item.state || extra?.state, draft: item.draft || !!extra?.draft, merged: item.merged || !!extra?.merged,
          crossRepo: item.crossRepo || !!extra?.crossRepo, current: p.number === number };
      }));
      return finish({ kind: 'github', trunk: s.base?.ref || trunkName, items, stackNumber: s.number, url: `https://github.com/${repo}/pull/${number}` });
    }
    const chain = await prHistory(), seen = new Set([number]);
    const { items: down, trunk } = await chain.below(g.pr, seen);
    const up = chain.above(g.pr, seen);
    if (down.length || up.length) {
      const parent = down.at(-1);
      const ps = parent ? await githubStack(repo, parent.pr) : null;
      return finish({ kind: 'chain', trunk, items: [...down, { ...prItem(g.pr), current: true, ...(ps && { notInStack: true }) }, ...up],
        ...(ps && { stackNumber: ps.number, parentStack: true }) });
    }
  }

  if (ws.rec.kind === 'local' && m.branch && m.branch !== 'HEAD') {
    local ||= await localGraph(gitDir, m.trunk || m.base, snapshot.refs);
    const ref = localPrefix + m.branch, tip = local?.branches.get(ref);
    if (tip && branchOf(local.trunkRef) !== m.branch && !await local.landed(tip)) {
      const namedParent = async (ref) => {
        const cut = await local.parentOf(ref);
        if (!cut?.candidates?.length || !repo) return cut;
        const p = prAtCut(cut, (await prHistory()).list);
        if (!p) return cut;
        const branch = p.headRefName;
        const parentRef = [remotePrefix + branch, localPrefix + branch].find((ref) => refs.get(ref) === cut.sha);
        return { ...cut, branch, ref: parentRef };
      };
      const down = [], seen = new Set([m.branch]);
      for (let p = await namedParent(ref); p?.ref && !seen.has(p.branch); p = await namedParent(p.ref)) {
        seen.add(p.branch);
        down.unshift({ branch: p.branch, ref: p.ref });
      }

      // A descendant has the current tip or one of its old tips on its first-parent line. Keep only edges that
      // agree with the parent that descendant would show when opened on its own.
      const oldTips = new Set([tip, ...(await local.log(ref)).map((entry) => entry.split('\t')[0])]);
      const children = new Map();
      for (const [other, sha] of local.branches) {
        if (seen.has(branchOf(other))) continue;
        if (![...local.history(sha).keys()].some((at) => oldTips.has(at))) continue;
        const p = await namedParent(other);
        if (!p?.ref) continue;
        if (!children.has(p.ref)) children.set(p.ref, []);
        children.get(p.ref).push(other);
      }
      const up = [], queue = [ref];
      for (const next of queue) {
        for (const [i, child] of (children.get(next) || []).entries()) {
          const branch = branchOf(child);
          if (seen.has(branch)) continue;
          seen.add(branch);
          up.push({ branch, ref: child, sibling: i > 0 });
          queue.push(child);
        }
      }

      if (down.length || up.length) {
        let trunk = branchOf(local.trunkRef);
        if (repo) {
          const chain = await prHistory();
          const namedPR = (item) => chain.fromBranch(item.branch, refs.get(item.ref));
          const first = down.findLastIndex(namedPR);
          if (first >= 0) {
            // Replace only the history below the first PR. Local-only changes between it and this checkout stay.
            const p = namedPR(down[first]);
            const used = new Set(down.slice(first).map((item) => namedPR(item)?.number));
            if (g.pr) used.add(g.pr.number);
            const history = await chain.below(p, used);
            down.splice(0, first + 1, ...history.items, { ...prItem(p), ref: down[first].ref });
            trunk = history.trunk || trunk;
          }
          for (const item of [...down, ...up]) {
            const p = namedPR(item);
            if (p) Object.assign(item, prItem(p));
          }
        }
        const below = down.at(-1);
        const ps = below?.pr ? await githubStack(repo, below.pr) : null;
        const here = g?.pr ? prItem(g.pr) : { branch: m.branch };
        return finish({ kind: 'local', trunk, items: [...down.map((row) => row.ref ? { ...row, byCommits: true } : row),
          { ...here, current: true }, ...up.map((row) => ({ ...row, byCommits: true }))],
          ...(ps && { stackNumber: ps.number, parentStack: true }) });
      }
    }
  }
  return finish({ kind: 'none', trunk: trunkName, items: [] });

  async function finish(v) {
    if (commits && repo) {
      const chain = await prHistory();
      const seen = new Set(v.items.filter((it) => it.pr).map((it) => it.pr));
      const items = [];
      for (const it of v.items) {
        if (it.pr) { items.push(it); continue; }
        const ref = it.ref || localPrefix + it.branch;
        const oid = refs.get(ref);
        const cut = local && await local.parentOf(ref);
        const p = cut?.sha === oid ? chain.fromBranch(it.branch) : chain.changeFor(it.branch, oid);
        if (!p) { items.push(it); continue; }
        if (seen.has(p.number)) continue;
        seen.add(p.number);
        items.push({ ...it, ...prItem(p) });
      }
      v.items = items;
      // A missing GitHub source leaves whatever the declared stack and local graph already proved.
      v = await addCommitStack(gitDir, ws.rec.kind, m, g.pr, repo, chain, v, snapshot, refs, local, commitLists).catch(() => v);
    }
    // A backup at a rewritten branch's old tip is a copy of that work. An unchanged child at an
    // ordinary cut point can still be a real child, so look only at tips that fell out of the branch's line.
    const copies = new Set(v.items.filter((it) => !it.pr && !it.current).map((it) => refs.get(it.ref || localPrefix + it.branch)).filter(Boolean));
    if (copies.size) {
      local ||= await localGraph(gitDir, v.trunk || m.trunk || m.base, snapshot.refs);
      const oldTips = new Set();
      if (local) await Promise.all(v.items.map(async (it) => {
        if (it.crossRepo) return;
        const ref = localPrefix + (it.current && ws.rec.kind === 'local' ? m.branch : it.branch);
        const tip = refs.get(ref);
        if (!tip) return;
        const history = local.history(tip);
        for (const entry of await local.log(ref)) {
          const oid = entry.split('\t')[0];
          if (oid !== tip && copies.has(oid) && !history.has(oid)) oldTips.add(oid);
        }
      }));
      v.items = v.items.filter((it) => it.pr || it.current || !oldTips.has(refs.get(it.ref || localPrefix + it.branch)));
    }
    // Keep both refs in the graph. For display, keep the current row first, then prefer parents over children.
    // On the same side of the current change, prefer the local copy.
    const branches = new Map();
    let aboveCurrent = false;
    for (const it of v.items) {
      if (it.current) aboveCurrent = true;
      if (it.pr) continue;
      const priority = it.current ? 2 : aboveCurrent ? 0 : 1;
      const other = branches.get(it.branch);
      if (!other || priority > other.priority || (priority === other.priority
        && other.item.ref?.startsWith(remotePrefix) && !it.ref?.startsWith(remotePrefix))) {
        branches.set(it.branch, { item: it, priority });
      }
    }
    v.items = v.items.filter((it) => it.pr || branches.get(it.branch)?.item === it);
    if (v.items.length < 2 && v.kind !== 'github' && v.kind !== 'none') v = { kind: 'none', trunk: v.trunk, items: [] };
    for (const it of v.items) {
      // A fork can use the same branch name as this clone without having a checkout here.
      const local = localPrefix + it.branch;
      const differentCopy = (it.ref?.startsWith(remotePrefix) && refs.get(it.ref) !== refs.get(local))
        || (it.byCommits && it.pr && it.oid && it.oid !== refs.get(local));
      const checkout = it.crossRepo || differentCopy ? null : co.get(local);
      if (checkout) it.checkout = checkout;
      if (it.current) it.here = true;
    }
    return { ...v, repo };
  }
}
