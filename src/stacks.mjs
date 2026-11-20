// Stacks: the changes a change sits on and the ones built on it. In order of authority:
//   1. GitHub's own stacks (gh stack; REST repos/{o}/{r}/stacks?pull_request=N), an ordered list bottom to top;
//   2. the PR base chain (a PR whose base is another PR's branch), which can branch: two PRs on one base;
//   3. local branches whose tips are ancestors of this one (and have commits the trunk lacks), nearest first.
// Each entry says where it can be opened: the checkout that has the branch, else the PR.
import { git } from './util.mjs';
import * as GH from './github.mjs';

const cache = new Map(); // ws id -> { at, value }

async function checkouts(gitDir) {
  // Every worktree of the clone and the branch it has checked out: "this branch is open at <path>".
  const out = await git(gitDir, ['worktree', 'list', '--porcelain']).catch(() => '');
  const map = new Map();
  let wt = null;
  for (const line of out.split('\n')) {
    if (line.startsWith('worktree ')) wt = line.slice(9);
    else if (line.startsWith('branch refs/heads/') && wt) map.set(line.slice(18), wt);
  }
  return map;
}

// The local branch this checkout was built on: the nearest ref merged into HEAD that the trunk does not have.
export async function localParent(root, branch, trunk, at = 'HEAD') {
  if (!branch || branch === 'HEAD' || !trunk) return null;
  const out = await git(root, ['for-each-ref', '--format=%(refname:short)', '--merged', at, '--no-merged', trunk, 'refs/heads', 'refs/remotes/origin']).catch(() => '');
  const self = new Set([branch, `origin/${branch}`]);
  const cands = [...new Set(out.split('\n').filter(Boolean).filter((r) => !self.has(r) && !r.endsWith('/HEAD')))].slice(0, 25);
  let best = null;
  for (const c of cands) {
    const n = Number((await git(root, ['rev-list', '--count', `${c}..${at}`]).catch(() => '')).trim());
    if (!(n > 0)) continue;
    const local = c.startsWith('origin/') ? c.slice(7) : c;
    // Prefer the local branch name over its remote copy when both are equally near.
    if (!best || n < best.n || (n === best.n && !c.startsWith('origin/') && best.ref.startsWith('origin/'))) best = { ref: c, branch: local, n };
  }
  return best;
}
// The local branches built on this one.
async function localChildren(root, branch) {
  const out = await git(root, ['for-each-ref', '--format=%(refname:short)', '--contains', 'HEAD', 'refs/heads']).catch(() => '');
  return out.split('\n').filter((r) => r && r !== branch).slice(0, 10);
}

const prItem = (p) => ({ pr: p.number, branch: p.headRefName || p.head?.ref, title: p.title || '', state: String(p.state || '').toLowerCase(), draft: !!(p.isDraft ?? p.draft), merged: !!(p.mergedAt || p.merged_at) });

export async function stackFor(ws, { fresh = false } = {}) {
  const hit = cache.get(ws.id);
  if (!fresh && hit && Date.now() - hit.at < 120000) return hit.value;
  const value = await resolve(ws).catch((e) => ({ kind: 'none', items: [], error: e.message }));
  cache.set(ws.id, { at: Date.now(), value });
  return value;
}

async function resolve(ws) {
  const g = ws.github;
  const m = ws.meta;
  const gitDir = ws.gitDir;
  const co = await checkouts(gitDir);
  const here = { branch: m.branch, pr: g?.pr?.number || null, current: true };
  let kind = 'none', trunk = null, items = [];

  if (g?.pr && g.owner) {
    const { owner, repo, number } = g;
    // 1. GitHub's own stack.
    const stacks = await GH.ghJson(['api', `repos/${owner}/${repo}/stacks?pull_request=${number}`]).catch(() => []);
    const s = Array.isArray(stacks) ? stacks[0] : null;
    if (s?.pull_requests?.length) {
      kind = 'github'; trunk = s.base?.ref || null;
      const titles = new Map((await GH.ghJson(['pr', 'list', '--repo', `${owner}/${repo}`, '--state', 'all', '--limit', '200', '--json', 'number,title,headRefName']).catch(() => [])).map((p) => [p.number, p.title]));
      items = s.pull_requests.map((p) => ({ ...prItem(p), title: titles.get(p.number) || '', current: p.number === number }));
      return finish({ kind, trunk, items, stackNumber: s.number, url: `https://github.com/${owner}/${repo}/pull/${number}` });
    }
    // 2. The base chain of PRs: down to the trunk, and the PRs built on this one.
    const list = await GH.ghJson(['pr', 'list', '--repo', `${owner}/${repo}`, '--state', 'open', '--limit', '200', '--json', 'number,title,headRefName,baseRefName,isDraft,state']).catch(() => []);
    const byHead = new Map(list.map((p) => [p.headRefName, p]));
    const down = [];
    let base = g.pr.baseRefName, guard = 0;
    while (byHead.has(base) && guard++ < 10) { const p = byHead.get(base); down.unshift(prItem(p)); base = p.baseRefName; }
    trunk = base;
    const up = [];
    let tip = g.pr.headRefName; guard = 0;
    for (;;) {
      const kids = list.filter((p) => p.baseRefName === tip);
      if (!kids.length || guard++ > 10) break;
      up.push(...kids.map((k, i) => ({ ...prItem(k), sibling: i > 0 })));
      tip = kids[0].headRefName; // follow the first; siblings are drawn beside it
    }
    if (down.length || up.length) {
      kind = 'chain'; items = [...down, { ...prItem(g.pr), current: true }, ...up];
      // Built on a PR that is in a GitHub stack, but not in it itself yet: say which stack, so it can be added.
      const parent = down.at(-1);
      const ps = parent ? await GH.ghJson(['api', `repos/${owner}/${repo}/stacks?pull_request=${parent.pr}`]).catch(() => []) : [];
      if (Array.isArray(ps) && ps[0]?.number) return finish({ kind, trunk, items: items.map((i) => (i.current ? { ...i, notInStack: true } : i)), stackNumber: ps[0].number, parentStack: true });
      return finish({ kind, trunk, items });
    }
  }
  // 3. Local branches.
  if (ws.rec.kind === 'local') {
    const trunkRef = m.trunk || m.base;
    const chain = [];
    let b = m.branch, root = ws.rec.root, guard = 0;
    let parent = await localParent(root, b, trunkRef);
    const seen = new Set([b]);
    while (parent && !seen.has(parent.branch) && guard++ < 6) {
      seen.add(parent.branch);
      chain.unshift({ branch: parent.branch, ref: parent.ref });
      parent = await localParent(root, parent.branch, trunkRef, parent.ref).catch(() => null); // from that branch's own history
    }
    const kids = await localChildren(root, b);
    if (chain.length || kids.length) {
      kind = 'local'; trunk = String(trunkRef).replace(/^origin\//, '');
      items = [...chain, { ...here }, ...kids.map((k, i) => ({ branch: k, sibling: i > 0 }))];
      // The branch below may have a PR in a GitHub stack: a PR opened from here can go on top of it.
      const below = chain.at(-1);
      if (below && g?.owner) {
        const n = await GH.prForBranch(g.owner, g.repo, below.branch).catch(() => null);
        const ps = n ? await GH.ghJson(['api', `repos/${g.owner}/${g.repo}/stacks?pull_request=${n}`]).catch(() => []) : [];
        if (n) below.pr = n;
        if (Array.isArray(ps) && ps[0]?.number) return finish({ kind, trunk, items, stackNumber: ps[0].number, parentStack: true });
      }
      return finish({ kind, trunk, items });
    }
  }
  return finish({ kind: 'none', trunk, items: [] });

  function finish(v) {
    for (const it of v.items) {
      const path = co.get(it.branch);
      if (path) it.checkout = path;
      if (it.current) it.here = true;
    }
    return v;
  }
}
