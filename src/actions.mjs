// Every write loupe makes, in one shape: preview(ws, payload) says exactly what will be sent and where, against which
// state (the guard); run(ws, payload, guard) checks the guard still holds, does it, and says what happened. The page
// shows the preview in a confirm for the actions that warrant one; small ones (a reply, a resolve) show it in the
// composer itself. GitHub goes through gh, its body as JSON on stdin so no text is ever parsed as a flag.
import { BIN } from './config.mjs';
import { run as exec, uid } from './util.mjs';
import * as GH from './github.mjs';
import { readAt, WORKTREE, changedFiles } from './git.mjs';
import { git as gitRun } from './util.mjs';
import { contentKey } from './workspaces.mjs';
import fsShip from 'node:fs';
import pathShip from 'node:path';

const gh = (argv, input) => exec(BIN.gh, argv, { timeout: 90000, input: input === undefined ? undefined : JSON.stringify(input) });
const ghPost = (path, body) => gh(['api', '-X', 'POST', path, '--input', '-'], body).then((t) => (t.trim() ? JSON.parse(t) : {}));
const fail = (message, status = 409) => Object.assign(new Error(message), { status });
const clip = (s, n = 140) => { const t = String(s || '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t; };

// The PR an action on this workspace targets: the PR itself, or the one a checkout's branch has.
function target(ws) {
  const g = ws.github;
  if (!g?.pr) throw fail(ws.rec.kind === 'pr' ? 'GitHub has not been read yet; try again in a moment' : 'this branch has no pull request on GitHub');
  return { owner: g.owner, repo: g.repo, number: g.number, pr: g.pr, full: `${g.owner}/${g.repo}#${g.number}` };
}

// ------------------------------------------------------------------ a review

const EVENTS = { APPROVE: 'Approve', REQUEST_CHANGES: 'Request changes', COMMENT: 'Comment' };
const sameTarget = (ws, guard) => { const t = target(ws); if (guard?.repo !== `${t.owner}/${t.repo}` || guard?.number !== t.number) throw fail(`this would now go to ${t.full}, not the PR you previewed: look again`); return t; };
// The lines a review comment can go on: GitHub takes one only inside a hunk of the PR's diff at its head, on the side it
// names, with a range inside one hunk. On a checkout, only while it is at the PR's head and the file has no
// uncommitted edits (else the line numbers would point elsewhere).
async function commentPlace(ws, t, { path, line, startLine, side }) {
  if (t.pr.state !== 'OPEN') throw fail(`#${t.number} is ${t.pr.state.toLowerCase()}`);
  if (!Number.isInteger(line) || line < 1 || (startLine != null && (!Number.isInteger(startLine) || startLine < 1 || startLine > line))) throw fail('pick a valid line range');
  if (ws.rec.kind === 'pr' && ws.meta?.headFull !== t.pr.headRefOid) throw fail('the PR has new commits: refresh its diff before commenting');
  if (ws.rec.kind === 'local') {
    await ws.sync(true);
    if (ws.meta.headFull !== t.pr.headRefOid) throw fail(`this checkout is not at #${t.number}'s head (${t.pr.headRefOid.slice(0, 7)}): pull or push first, or comment from the PR's page`);
    if ((ws.meta.wipPaths || []).includes(path)) throw fail('this file has uncommitted edits, so its lines are not the PR\'s: comment from the PR\'s page');
  }
  const scope = ws.rec.kind === 'pr' ? 'all' : 'branch';
  const d = await ws.hunks(scope, path).catch(() => null);
  if (!d) throw fail('the PR does not change that file');
  const inHunk = (n) => d.hunks.find((h) => (side === 'old' ? n >= h.oldStart && n < h.oldStart + h.oldLines : n >= h.newStart && n < h.newStart + h.newLines));
  const h = inHunk(Number(line));
  if (!h) throw fail('GitHub takes comments only on lines in the diff: pick lines inside a hunk');
  if (startLine && Number(startLine) !== Number(line) && inHunk(Number(startLine)) !== h) throw fail('a comment\'s lines have to be in one hunk');
  return { path, line: Number(line), startLine: startLine && Number(startLine) < Number(line) ? Number(startLine) : null, side: side === 'old' ? 'LEFT' : 'RIGHT' };
}
const ADD_REVIEW = 'mutation($pr:ID!,$commit:GitObjectID!){addPullRequestReview(input:{pullRequestId:$pr,commitOID:$commit}){pullRequestReview{id}}}';
const ADD_THREAD = 'mutation($review:ID!,$path:String!,$line:Int!,$side:DiffSide!,$startLine:Int,$startSide:DiffSide,$body:String!){addPullRequestReviewThread(input:{pullRequestReviewId:$review,path:$path,line:$line,side:$side,startLine:$startLine,startSide:$startSide,body:$body}){thread{id}}}';
const DROP_COMMENT = 'mutation($id:ID!){deletePullRequestReviewComment(input:{id:$id}){pullRequestReview{id}}}';
const SUBMIT = 'mutation($review:ID!,$event:PullRequestReviewEvent!,$body:String){submitPullRequestReview(input:{pullRequestReviewId:$review,event:$event,body:$body}){pullRequestReview{id url commit{oid}}}}';
const gql = (query, vars) => {
  const argv = ['api', 'graphql', '-f', `query=${query}`];
  for (const [k, v] of Object.entries(vars)) if (v !== null && v !== undefined) argv.push(typeof v === 'number' ? '-F' : '-f', `${k}=${v}`);
  return gh(argv).then((x) => JSON.parse(x || '{}'));
};
const where = (c) => `${c.path} ${c.startLine && c.startLine !== c.line ? `lines ${c.startLine}–${c.line}` : `line ${c.line}`}`;

async function freshReviewTarget(ws, guard) {
  const fresh = await ws.fetchGithub(true).catch(() => null);
  if (!fresh?.pr || fresh.stale || fresh.pendingError) throw fail('GitHub could not confirm your pending review: try again');
  const t = sameTarget(ws, guard);
  if (guard.head && t.pr.headRefOid !== guard.head) throw fail('the PR has new commits since the preview: look again');
  return t;
}

const review = {
  modal: true,
  async preview(ws, { event, body = '' }) {
    const t = target(ws);
    if (!Object.hasOwn(EVENTS, event)) throw fail('choose Comment, Request changes or Approve', 400);
    if (t.pr.state !== 'OPEN') throw fail(`#${t.number} is ${t.pr.state.toLowerCase()}`);
    if (event !== 'COMMENT' && t.pr.viewerIsAuthor) throw fail('GitHub does not let you approve or request changes on your own pull request');
    const head = t.pr.headRefOid;
    if (ws.github.pendingError) await ws.fetchGithub(true).catch(() => {}); // one fresh read before refusing
    if (ws.github.pendingError) throw fail('GitHub could not confirm your pending review: try again');
    const pend = ws.github.pending;
    const comments = pend?.comments || [];
    if (event !== 'APPROVE' && !body.trim() && !comments.length) throw fail(`GitHub needs a summary for ${EVENTS[event]}: write one above`, 400);
    return {
      title: `${EVENTS[event]} ${t.full}`,
      where: `on GitHub, as ${t.pr.viewer || 'you'}`,
      confirm: EVENTS[event],
      tone: event === 'APPROVE' ? 'primary' : event === 'REQUEST_CHANGES' ? 'danger' : '',
      items: [
        ...(body.trim() ? [`Summary: “${clip(body, 200)}”`] : []),
        ...comments.map((c) => `At ${where(c)}: “${clip(c.body, 160)}”`),
        ...(!comments.length && !body.trim() ? ['No summary and no comments on lines: an approval on its own.'] : []),
      ],
      warnings: comments.filter((c) => c.outdated).map((c) => `${where(c)} is outdated: the PR moved after you wrote it.`),
      // what the confirm showed: the summary and the pending comments, so a comment added elsewhere since is seen first
      guard: { head, repo: `${t.owner}/${t.repo}`, number: t.number, summary: body.trim(), event, comments: JSON.stringify(comments.map((c) => [c.nodeId, c.body, c.path, c.line, c.startLine, !!c.outdated])), review: pend?.id || null },
    };
  },
  async run(ws, payload, guard) {
    const t = await freshReviewTarget(ws, guard);
    const pv = await this.preview(ws, payload);
    if (pv.guard.summary !== guard.summary || pv.guard.event !== guard.event || pv.guard.comments !== guard.comments || pv.guard.review !== guard.review) throw fail('your review changed since the preview (a comment added or removed): look again, then submit');
    const body = payload.body?.trim() || null;
    // head: the commit GitHub gave the review. A review sent here is on the head the preview pinned; a pending one is on
    // the commit it began on, which only GitHub's answer says (none, if it does not: then no verdict is kept)
    let url = t.pr.url, head = guard.review ? null : guard.head;
    if (guard.review) {
      const d = await gql(SUBMIT, { review: guard.review, event: payload.event, body });
      if (d.errors?.length) throw fail(`GitHub refused the review: ${clip(d.errors[0].message, 300)}`, 502);
      const sent = d.data?.submitPullRequestReview?.pullRequestReview;
      if (!sent?.id) throw fail('GitHub did not confirm review submission', 502);
      url = sent.url || url; head = sent.commit?.oid || head;
    } else {
      const req = { commit_id: guard.head, event: payload.event };
      if (body) req.body = body;
      try { const r = await ghPost(`repos/${t.owner}/${t.repo}/pulls/${t.number}/reviews`, req); url = r.html_url || url; head = r.commit_id || head; }
      catch (e) { throw fail(`GitHub refused the review: ${clip(`${e.stderr || ''} ${e.message}`.replace(/\s+/g, ' '), 300)}`, 502); }
    }
    const n = ws.github.pending?.comments?.length || 0;
    // your verdict, with the head it was given on (the one you read and the preview pinned): the page prints it on the
    // pull request, and can say when the head has moved on past it
    if (payload.event !== 'COMMENT' && ws.review?.data) { // a newer verdict replaces the last; one without a named commit clears it
      if (head) ws.review.data.verdict = { event: payload.event, head, repo: `${t.owner}/${t.repo}`, number: t.number, at: Date.now() };
      else delete ws.review.data.verdict;
      ws.review.save(); ws.emit('review', { verdict: ws.review.data.verdict || null });
    }
    await ws.fetchGithub(true).catch(() => {});
    ws.emit('github', {});
    return { message: `${EVENTS[payload.event]} sent to ${t.full}${n ? ` with ${n} comment${n === 1 ? '' : 's'} on lines` : ''}.`, url, event: payload.event, head };
  },
};

// A comment on lines joins your pending review on GitHub (started here if there is none). Only you see it until the
// review is submitted, here or on GitHub.
const reviewcomment = {
  async preview(ws, payload) {
    const t = target(ws);
    if (!String(payload.body || '').trim()) throw fail('write the comment first', 400);
    const place = await commentPlace(ws, t, payload);
    return { title: `Add to your review of ${t.full}`, where: 'on GitHub, pending: only you see it until you submit the review', confirm: 'Add', items: [`At ${where(place)}: “${clip(payload.body, 200)}”`], guard: { repo: `${t.owner}/${t.repo}`, number: t.number, head: t.pr.headRefOid } };
  },
  async run(ws, payload, guard) {
    const t = await freshReviewTarget(ws, guard);
    if (!String(payload.body || '').trim()) throw fail('write the comment first', 400);
    const place = await commentPlace(ws, t, payload);
    let id = ws.github.pending?.id;
    if (!id) {
      const prId = ws.github.prId || (await GH.pendingReview(t.owner, t.repo, t.number)).prId;
      const d = await gql(ADD_REVIEW, { pr: prId, commit: guard.head });
      if (d.errors?.length) throw fail(`GitHub would not start a review: ${clip(d.errors[0].message, 300)}`, 502);
      id = d.data?.addPullRequestReview?.pullRequestReview?.id;
      if (!id) throw fail('GitHub did not return a pending review', 502);
    }
    const d = await gql(ADD_THREAD, { review: id, path: place.path, line: place.line, side: place.side, startLine: place.startLine, startSide: place.startLine ? place.side : null, body: String(payload.body).trim() });
    if (d.errors?.length) throw fail(`GitHub refused the comment: ${clip(d.errors[0].message, 300)}`, 502);
    if (!d.data?.addPullRequestReviewThread?.thread?.id) throw fail('GitHub did not return the comment thread', 502);
    await ws.fetchGithub(true).catch(() => {});
    ws.emit('github', {});
    return { message: `Added to your pending review of ${t.full}.` };
  },
};
// Taking a comment back out of your pending review.
const dropcomment = {
  async preview(ws, { nodeId }) {
    const t = target(ws);
    const c = (ws.github.pending?.comments || []).find((x) => x.nodeId === nodeId);
    if (!c) throw fail('that comment is not in your pending review any more');
    return { title: `Delete your pending comment at ${where(c)}`, where: 'on GitHub', confirm: 'Delete', tone: 'danger', items: [`“${clip(c.body, 200)}”`], guard: { repo: `${t.owner}/${t.repo}`, number: t.number } };
  },
  async run(ws, { nodeId }, guard) {
    await freshReviewTarget(ws, guard);
    await this.preview(ws, { nodeId });
    const d = await gql(DROP_COMMENT, { id: nodeId });
    if (d.errors?.length) throw fail(`GitHub would not delete it: ${clip(d.errors[0].message, 300)}`, 502);
    await ws.fetchGithub(true).catch(() => {});
    ws.emit('github', {});
    return { message: 'Deleted from your pending review.' };
  },
};

// ------------------------------------------------------------------ the small GitHub writes
const comment = {
  async preview(ws, { body }) {
    const t = target(ws);
    if (!String(body || '').trim()) throw fail('write the comment first', 400);
    return { title: `Comment on ${t.full}`, where: `on GitHub, as ${t.pr.viewer || 'you'}`, confirm: 'Comment', items: [`“${clip(body, 300)}”`], guard: { repo: `${t.owner}/${t.repo}`, number: t.number } };
  },
  async run(ws, { body }, guard) {
    const t = sameTarget(ws, guard);
    const r = await ghPost(`repos/${t.owner}/${t.repo}/issues/${t.number}/comments`, { body: String(body).trim() });
    await ws.fetchGithub(true).catch(() => {});
    return { message: `Commented on ${t.full}.`, url: r.html_url };
  },
};
const reply = {
  async preview(ws, { commentId, body }) {
    const t = target(ws);
    const th = (ws.github.threads || []).find((x) => x.comments[0]?.id === commentId);
    if (!th) throw fail('that thread is not on the PR any more');
    if (!String(body || '').trim()) throw fail('write the reply first', 400);
    return { title: `Reply on ${th.path}`, where: `on GitHub, as ${t.pr.viewer || 'you'}`, confirm: 'Reply', items: [`“${clip(body, 300)}”`], guard: { repo: `${t.owner}/${t.repo}`, number: t.number } };
  },
  async run(ws, { commentId, body }, guard) {
    const t = sameTarget(ws, guard);
    await this.preview(ws, { commentId, body });
    const r = await ghPost(`repos/${t.owner}/${t.repo}/pulls/${t.number}/comments/${Number(commentId)}/replies`, { body: String(body).trim() });
    await ws.fetchGithub(true).catch(() => {});
    return { message: 'Replied on GitHub.', url: r.html_url };
  },
};
const RESOLVE = 'mutation($id:ID!){resolveReviewThread(input:{threadId:$id}){thread{isResolved}}}';
const UNRESOLVE = 'mutation($id:ID!){unresolveReviewThread(input:{threadId:$id}){thread{isResolved}}}';
const resolve = {
  async preview(ws, { threadId, resolved }) {
    const th = (ws.github?.threads || []).find((x) => x.id === threadId);
    if (!th) throw fail('that thread is not on the PR any more');
    if (resolved ? !th.canResolve : !th.canUnresolve) throw fail(`GitHub does not let you ${resolved ? 'resolve' : 'reopen'} that thread`);
    const t = target(ws);
    return { title: `${resolved ? 'Resolve' : 'Reopen'} the thread on ${th.path}`, where: 'on GitHub', confirm: resolved ? 'Resolve' : 'Reopen', items: [], guard: { repo: `${t.owner}/${t.repo}`, number: t.number } };
  },
  async run(ws, { threadId, resolved }, guard) {
    sameTarget(ws, guard);
    await this.preview(ws, { threadId, resolved });
    await gh(['api', 'graphql', '-f', `query=${resolved ? RESOLVE : UNRESOLVE}`, '-f', `id=${threadId}`]);
    await ws.fetchGithub(true).catch(() => {});
    return { message: resolved ? 'Resolved on GitHub.' : 'Reopened on GitHub.' };
  },
};

export const ACTIONS = { review, reviewcomment, dropcomment, comment, reply, resolve };
export { uid };

// ------------------------------------------------------------------ shipping a checkout: commit, push, open the PR

const g = (ws, argv, opts = {}) => gitRun(ws.rec.root, argv, opts);
const local = (ws) => { if (ws.rec.kind !== 'local') throw fail('commit and push from the checkout, not the PR page'); return ws; };

// Where the branch stands, read from git now, never from the page's cache: the head, the branch, where a push goes
// (the upstream it tracks, else origin/<branch>) and how far apart they are.
export async function shipState(ws) {
  local(ws);
  const head = (await g(ws, ['rev-parse', '--verify', '--quiet', 'HEAD']).catch(() => '')).trim() || null;
  const branch = (await g(ws, ['rev-parse', '--abbrev-ref', 'HEAD']).catch(() => '')).trim() || 'HEAD';
  const def = (ws.meta?.trunk || '').replace(/^origin\//, '') || 'main';
  const upstream = branch === 'HEAD' ? null : (await g(ws, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']).catch(() => '')).trim() || null;
  const remote = (upstream && (await g(ws, ['config', `branch.${branch}.remote`]).catch(() => '')).trim()) || 'origin';
  const dest = (upstream && (await g(ws, ['config', `branch.${branch}.merge`]).catch(() => '')).trim()) || `refs/heads/${branch}`;
  const remoteRef = upstream || `origin/${branch}`;
  const remoteSha = (await g(ws, ['rev-parse', '--verify', '--quiet', `${remoteRef}^{commit}`]).catch(() => '')).trim() || null;
  let ahead = 0, behind = 0;
  if (remoteSha && head) {
    const [b, a] = (await g(ws, ['rev-list', '--left-right', '--count', `${remoteSha}...${head}`]).catch(() => '0\t0')).trim().split(/\s+/).map(Number);
    ahead = a || 0; behind = b || 0;
  } else if (head && ws.meta?.base) ahead = Number((await g(ws, ['rev-list', '--count', `${ws.meta.base}..${head}`]).catch(() => '0')).trim()) || 0;
  const wip = head ? await changedFiles(ws.rec.root, { old: head, new: WORKTREE }) : [];
  let template = '';
  for (const f of ['.github/pull_request_template.md', '.github/PULL_REQUEST_TEMPLATE.md', 'docs/pull_request_template.md', 'pull_request_template.md']) {
    try { template = fsShip.readFileSync(pathShip.join(ws.rec.root, f), 'utf8').slice(0, 6000); break; } catch { /* next */ }
  }
  const pr = ws.github?.pr && ws.github.pr.headRefName === branch ? ws.github.pr : null;
  return {
    branch, onDefault: branch === def || branch === 'HEAD', defaultBranch: def, upstream, remote, dest, remoteRef, remoteSha, ahead, behind, head,
    base: (ws.meta?.base || def).replace(/^origin\//, ''), wipFiles: wip,
    wip: wip.map((f) => ({ path: f.path, status: f.untracked ? 'A' : f.status, untracked: !!f.untracked, added: f.added, deleted: f.deleted, oldPath: f.oldPath })),
    pr: pr ? { number: pr.number, state: pr.state, url: pr.url, isDraft: pr.isDraft } : null,
    repo: ws.github?.repoFull || ws.github?.repo || null, template,
  };
}
export const shipOut = (st) => { const { wipFiles, ...rest } = st; return rest; };

const commit = {
  modal: true,
  async preview(ws, { paths = [], message = '', amend = false, branch: newBranch = '' }) {
    const st = await shipState(local(ws));
    const pick = st.wipFiles.filter((f) => paths.includes(f.path) || (f.oldPath && paths.includes(f.oldPath)));
    if (!pick.length && !amend) throw fail('pick at least one file to commit', 400);
    if (!message.trim()) throw fail('write the commit message first', 400);
    if (!st.head && amend) throw fail('there is no commit to amend');
    const warnings = [];
    if (st.onDefault && !newBranch.trim()) warnings.push(`You are on ${st.branch}: the commit goes straight onto it. Name a new branch to commit there instead.`);
    if (amend && st.remoteSha && st.ahead === 0) warnings.push('The last commit is already on the remote: after amending, pushing has to overwrite it.');
    const hooks = fsShip.existsSync(pathShip.join(ws.rec.root, '.git', 'hooks', 'pre-commit')) || (await g(ws, ['config', 'core.hooksPath']).catch(() => '')).trim();
    if (hooks) warnings.push('The repository\'s commit hooks run, as they would in a terminal.');
    const [subject, ...rest] = message.trim().split('\n');
    return {
      title: `${amend ? 'Amend the last commit' : `Commit ${pick.length} file${pick.length === 1 ? '' : 's'}`} on ${newBranch.trim() || st.branch}`,
      where: `in ${ws.rec.root}`, confirm: amend ? 'Amend' : 'Commit',
      items: [`“${clip(subject, 120)}”${rest.join('').trim() ? ' + body' : ''}`, ...(newBranch.trim() ? [`On a new branch ${newBranch.trim()}, from ${st.branch}`] : []), ...pick.map((f) => `${f.untracked ? 'new ' : f.status === 'D' ? 'delete ' : ''}${f.path}  +${f.added} −${f.deleted}`)],
      warnings,
      // The files as you saw them, on the branch you saw: if either changes before you confirm, the commit is refused.
      guard: { head: st.head, branch: st.branch, files: contentKey(pick), paths: pick.flatMap((f) => (f.oldPath ? [f.oldPath, f.path] : [f.path])) },
    };
  },
  async run(ws, payload, guard) {
    const pv = await this.preview(ws, payload);
    if (pv.guard.head !== guard?.head || pv.guard.branch !== guard?.branch || pv.guard.files !== guard?.files) throw fail('the files or the branch changed since the preview: look again, then commit');
    const nb = String(payload.branch || '').trim();
    if (nb) {
      if (!/^[\w./-]+$/.test(nb) || nb.startsWith('-') || nb.includes('..') || nb.endsWith('.lock')) throw fail(`"${nb}" is not a branch name`, 400);
      await g(ws, ['switch', '-c', nb]);
    }
    const paths = guard.paths;
    // Only the picked paths: anything you or a session had already staged stays staged, uncommitted.
    if (paths.length) await g(ws, ['add', '-A', '--', ...paths]);
    // --only: the commit holds exactly these paths (or, amending with none, only the new message).
    const argv = ['commit', '--only', ...(payload.amend ? ['--amend'] : []), '-F', '-', ...(paths.length ? ['--', ...paths] : [])];
    let out;
    try { out = await g(ws, argv, { input: payload.message.trim() + '\n', timeout: 10 * 60 * 1000 }); }
    catch (e) { throw fail(`git commit failed${/hook/i.test(e.stderr) ? ' in a hook' : ''}: ${clip(e.stderr || e.message, 400)}`, 422); }
    ws.version++; await ws.sync(true);
    return { message: `Committed ${ws.meta.head}: ${clip(payload.message.split('\n')[0], 80)}`, output: clip(out, 400) };
  },
};

const push = {
  modal: true,
  async preview(ws, { force = false }) {
    const st = await shipState(local(ws));
    if (st.onDefault) throw fail(`refusing to push ${st.branch} from here: commit onto a branch first`);
    if (!st.head) throw fail('nothing to push yet');
    const to = `${st.remote} ${st.dest.replace(/^refs\/heads\//, '')}`;
    const guard = { head: st.head, branch: st.branch, remote: st.remote, dest: st.dest, remoteSha: st.remoteSha };
    const diverged = st.behind > 0;
    if (diverged && !force) return { title: `Push ${st.branch}`, where: `to ${to}`, confirm: 'Push', needsForce: true, items: [], warnings: [`${st.remoteRef} has ${st.behind} commit${st.behind === 1 ? '' : 's'} your branch does not (a rebase or an amend). Pushing means overwriting them.`], guard };
    if (!diverged && st.ahead === 0 && st.remoteSha) throw fail(`${st.branch} is already up to date on ${st.remoteRef}`);
    return {
      title: `${diverged ? 'Overwrite' : 'Push'} ${st.branch}`, where: `to ${to}${st.upstream ? '' : ', and track it'}`, confirm: diverged ? 'Overwrite' : 'Push', tone: diverged ? 'danger' : 'primary',
      items: [`${st.ahead} commit${st.ahead === 1 ? '' : 's'} ${st.remoteSha ? `onto ${st.remoteRef}` : 'as a new branch'}`, ...(diverged ? [`Replaces ${st.remoteRef} (${st.remoteSha.slice(0, 7)}) only if it is still exactly that: a lease on that commit`] : [])],
      warnings: diverged ? [`${st.behind} commit${st.behind === 1 ? '' : 's'} on the remote will be gone.`] : [],
      guard,
    };
  },
  async run(ws, payload, guard) {
    const st = await shipState(local(ws));
    if (st.onDefault) throw fail(`refusing to push ${st.branch} from here`);
    for (const k of ['head', 'branch', 'remote', 'dest', 'remoteSha']) if (st[k] !== guard?.[k]) throw fail('the branch, its remote or its upstream moved since the preview: look again');
    // The exact destination the preview named; an overwrite only with a lease on the exact commit it showed.
    // The local branch ref (so -u can track it), checked a moment ago to be at the previewed commit.
    const argv = ['push', ...(st.upstream ? [] : ['-u']), st.remote, `refs/heads/${st.branch}:${st.dest}`];
    if (st.behind > 0) { if (!payload.force) throw fail('this push overwrites the remote: confirm it as an overwrite'); argv.splice(1, 0, `--force-with-lease=${st.dest}:${guard.remoteSha}`); }
    try { await g(ws, argv, { timeout: 5 * 60 * 1000 }); }
    catch (e) { throw fail(`git push failed: ${clip(e.stderr || e.message, 400)}`, 422); }
    ws.fetchGithub(true).catch(() => {});
    return { message: `Pushed ${st.branch} to ${st.remote}${st.behind > 0 ? ' (overwrote it, with a lease)' : ''}.` };
  },
};

const openpr = {
  modal: true,
  async preview(ws, { title = '', body = '', base = '', draft = true }) {
    const st = await shipState(local(ws));
    if (!st.repo) throw fail('this checkout has no GitHub remote');
    if (st.pr && st.pr.state === 'OPEN') throw fail(`#${st.pr.number} is already open for ${st.branch}`);
    if (st.onDefault) throw fail(`${st.branch} is the default branch: commit onto a branch first`);
    // The PR shows what the remote has, so the remote must be exactly what you reviewed here.
    if (!st.remoteSha || st.remoteSha !== st.head) throw fail(st.behind > 0 ? `${st.remoteRef} has commits this checkout does not: pull them and look first` : 'push the branch first, so GitHub has what the PR shows');
    if (!title.trim()) throw fail('write a title', 400);
    const into = String(base || st.base).replace(/^origin\//, '').trim();
    if (!into || into.startsWith('-')) throw fail('name the base branch', 400);
    return {
      title: `Open a ${draft ? 'draft ' : ''}pull request on ${st.repo}`, where: `from ${st.branch} into ${into}, as you on GitHub`, confirm: draft ? 'Open draft' : 'Open',
      items: [`“${clip(title, 140)}”`, body.trim() ? `Description: ${clip(body, 200)}` : 'No description'], warnings: [], guard: { head: st.head, branch: st.branch, remoteSha: st.remoteSha, base: into, repo: st.repo },
    };
  },
  async run(ws, payload, guard) {
    const pv = await this.preview(ws, payload);
    for (const k of ['head', 'branch', 'remoteSha', 'base', 'repo']) if (pv.guard[k] !== guard?.[k]) throw fail('the branch moved since the preview: look again');
    const out = await exec(BIN.gh, ['pr', 'create', '--repo', guard.repo, '--head', guard.branch, '--base', guard.base, `--title=${payload.title.trim()}`, '--body-file', '-', ...(payload.draft === false ? [] : ['--draft'])], { cwd: ws.rec.root, input: payload.body || '', timeout: 120000 });
    const url = out.trim().split('\n').pop();
    await ws.fetchGithub(true).catch(() => {});
    return { message: `Opened ${url}`, url };
  },
};

// Adding a new PR on top of a GitHub stack: gh stack link with PR numbers (with branch names it would push).
const stacklink = {
  modal: true,
  async preview(ws, { stackNumber, pr }) {
    if (!Number(stackNumber) || !Number(pr)) throw fail('which stack and which PR?', 400);
    return { title: `Add #${pr} to GitHub stack #${stackNumber}`, where: `on GitHub (${ws.github?.repoFull || ''})`, confirm: 'Add to stack', items: [`#${pr} goes on top of the stack`], warnings: [], guard: {} };
  },
  async run(ws, { stackNumber, pr }) {
    await exec(BIN.gh, ['stack', 'link', String(Number(stackNumber)), String(Number(pr))], { cwd: ws.rec.root || ws.gitDir, timeout: 120000 });
    return { message: `#${pr} is in stack #${stackNumber} now.` };
  },
};

Object.assign(ACTIONS, { commit, push, openpr, stacklink });
