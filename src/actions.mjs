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
const ADD_THREAD = 'mutation($review:ID!,$path:String!,$line:Int!,$side:DiffSide!,$startLine:Int,$startSide:DiffSide,$body:String!){addPullRequestReviewThread(input:{pullRequestReviewId:$review,path:$path,line:$line,side:$side,startLine:$startLine,startSide:$startSide,body:$body}){thread{id comments(first:1){nodes{id databaseId body createdAt url author{login}}}}}}';
const DROP_COMMENT = 'mutation($id:ID!){deletePullRequestReviewComment(input:{id:$id}){pullRequestReview{id}}}';
const SUBMIT = 'mutation($review:ID!,$event:PullRequestReviewEvent!,$body:String){submitPullRequestReview(input:{pullRequestReviewId:$review,event:$event,body:$body}){pullRequestReview{id url commit{oid}}}}';
const gql = (query, vars) => {
  const argv = ['api', 'graphql', '-f', `query=${query}`];
  for (const [k, v] of Object.entries(vars)) if (v !== null && v !== undefined) argv.push(typeof v === 'number' ? '-F' : '-f', `${k}=${v}`);
  return gh(argv).then((x) => JSON.parse(x || '{}'));
};
const where = (c) => `${c.path} ${c.startLine && c.startLine !== c.line ? `lines ${c.startLine}–${c.line}` : `line ${c.line}`}`;

// What a review write is checked against, read fresh in one request: the PR's head and state, your latest verdict, and
// your pending review (its id and its comments). Nothing else the page shows is needed to send it, so no full refresh
// (a second or two, more on a stacked PR) waits in front of the write. The answer is only compared with what the
// dialog showed, never copied into loupe's copy: a difference refuses the write and starts the full read, which brings
// the page what changed (its diff, its threads) before anything can be sent on it.
const seenComments = (comments) => JSON.stringify((comments || []).map((c) => [c.nodeId, c.body, c.path, c.line, c.startLine, !!c.outdated]));
async function freshReviewTarget(ws, guard) {
  const t = sameTarget(ws, guard);
  // and, on a checkout, which branch it is on now (loupe's copy of the PR can still be the last branch's)
  const [fresh, branch] = await Promise.all([GH.pendingReview(t.owner, t.repo, t.number).catch(() => null),
    ws.rec.kind === 'local' ? g(ws, ['symbolic-ref', '--short', '-q', 'HEAD']).then((x) => x.trim(), () => '') : null]);
  sameTarget(ws, guard); // the page may have moved to another PR while that was read
  if (target(ws).number !== t.number) throw fail('this would now go to another PR: look again');
  if (!fresh) throw fail('GitHub could not confirm your pending review: try again');
  const moved = (why) => { ws.fetchGithub(true).catch(() => {}); return fail(why); };
  if (branch !== null && t.pr.headRefName && branch !== t.pr.headRefName) throw moved('this checkout is on another branch now: look again');
  if (fresh.state && fresh.state !== 'OPEN') throw moved(`#${t.number} is ${fresh.state.toLowerCase()} now`);
  if (guard.head && fresh.head && fresh.head !== guard.head) throw moved('the PR has new commits since the preview: look again');
  // a retargeted PR keeps its head but compares against another branch: what you read (and where a line can go) moved.
  // The branch the preview pinned, not loupe's copy (a refresh may have seen the retarget already); its tip moving
  // (new commits on main) changes nothing you read.
  if (guard.base && fresh.base && fresh.base !== guard.base) throw moved('the PR\'s base branch changed since the preview: look again');
  if ('review' in guard && (guard.review ?? null) !== (fresh.review?.id ?? null)) throw moved('your pending review changed on GitHub since the preview: look at it again');
  if ('comments' in guard && guard.comments !== seenComments(fresh.review?.comments)) throw moved('your pending review\'s comments changed on GitHub since the preview: look at them again');
  if (guard.event && guard.event !== 'COMMENT' && fresh.viewerReview?.head === guard.head && fresh.viewerReview?.event === guard.event) {
    throw moved(guard.event === 'APPROVE' ? 'you already approved this commit' : 'you already requested changes on this commit');
  }
  return { t, fresh };
}
// After a write: what it changed goes into loupe's copy of the PR at once and the page is told (it reads that copy on
// the answer), and the full read follows behind the answer instead of in front of it.
// Each change is idempotent: a read that finished in the moment between the write and this may already hold it.
function landed(ws, change, t) {
  ws.ghWrites = (ws.ghWrites || 0) + 1; // a read already under way began before this write: its answer is not kept
  const same = !t || (ws.github?.number === t.number && ws.github?.owner === t.owner && ws.github?.repo === t.repo); // the page may be on another PR by now
  if (change && ws.github && same) ws.github = { ...ws.github, ...change(ws.github) };
  ws.emit('github', {});
  ws.fetchGithub(true).catch(() => {});
}

const review = {
  modal: true,
  async preview(ws, { event, body = '' }) {
    const t = target(ws);
    if (!Object.hasOwn(EVENTS, event)) throw fail('choose Comment, Request changes or Approve', 400);
    if (t.pr.state !== 'OPEN') throw fail(`#${t.number} is ${t.pr.state.toLowerCase()}`);
    if (event !== 'COMMENT' && t.pr.viewerIsAuthor) throw fail('GitHub does not let you approve or request changes on your own pull request');
    const head = t.pr.headRefOid;
    if (ws.rec.kind === 'pr' && ((ws.meta?.headFull && head && ws.meta.headFull !== head) || (ws.meta?.base && t.pr.baseRefName && ws.meta.base !== t.pr.baseRefName))) throw fail('the PR has moved: wait for its diff to load, then look again');
    if (head && t.pr.viewerReview?.head === head && t.pr.viewerReview.event === event) {
      throw fail(event === 'APPROVE' ? 'you already approved this commit' : 'you already requested changes on this commit');
    }
    if (ws.github.pendingError) await ws.fetchGithub(true).catch(() => {}); // one fresh read before refusing
    if (ws.github.pendingError) throw fail('GitHub could not confirm your pending review: try again');
    const pend = ws.github.pending;
    const comments = pend?.comments || [];
    if (event !== 'APPROVE' && !body.trim() && !comments.length) throw fail(`GitHub needs a summary for ${EVENTS[event]}: write one above`, 400);
    return {
      title: `${event === 'APPROVE' ? 'Approve' : `${EVENTS[event]} on`} ${t.full}`,
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
      guard: { head, repo: `${t.owner}/${t.repo}`, number: t.number, summary: body.trim(), event, base: t.pr.baseRefName || null, comments: seenComments(comments), review: pend?.id || null },
    };
  },
  async run(ws, payload, guard) {
    const { t } = await freshReviewTarget(ws, guard);
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
    // sent: no pending review any more, its comments are ordinary threads, and your verdict is on the head it went to
    landed(ws, (g) => ({
      pending: null,
      threads: (g.threads || []).map((th) => (th.pending ? { ...th, pending: false, comments: th.comments.map((c) => ({ ...c, pending: false })) } : th)),
      // a verdict GitHub gave no commit for replaces the one before, as the saved verdict above does
      pr: { ...g.pr, ...(payload.event !== 'COMMENT' ? { viewerReview: head ? { event: payload.event, head, at: Date.now() } : null } : {}) },
    }), t);
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
    return { title: `Add to your review of ${t.full}`, where: 'on GitHub, pending: only you see it until you submit the review', confirm: 'Add', items: [`At ${where(place)}: “${clip(payload.body, 200)}”`], guard: { repo: `${t.owner}/${t.repo}`, number: t.number, head: t.pr.headRefOid, base: t.pr.baseRefName || null } };
  },
  async run(ws, payload, guard) {
    const { t, fresh } = await freshReviewTarget(ws, guard);
    if (!String(payload.body || '').trim()) throw fail('write the comment first', 400);
    const place = await commentPlace(ws, t, payload);
    let id = fresh.review?.id; // the pending review GitHub holds now, begun here or on GitHub
    if (!id) {
      const prId = fresh.prId || ws.github.prId;
      const d = await gql(ADD_REVIEW, { pr: prId, commit: guard.head });
      if (d.errors?.length) throw fail(`GitHub would not start a review: ${clip(d.errors[0].message, 300)}`, 502);
      id = d.data?.addPullRequestReview?.pullRequestReview?.id;
      if (!id) throw fail('GitHub did not return a pending review', 502);
    }
    const d = await gql(ADD_THREAD, { review: id, path: place.path, line: place.line, side: place.side, startLine: place.startLine, startSide: place.startLine ? place.side : null, body: String(payload.body).trim() });
    if (d.errors?.length) throw fail(`GitHub refused the comment: ${clip(d.errors[0].message, 300)}`, 502);
    const th = d.data?.addPullRequestReviewThread?.thread;
    if (!th?.id) throw fail('GitHub did not return the comment thread', 502);
    // the comment, pending, where you put it: in your pending review and as a thread at its lines
    const c = th.comments?.nodes?.[0];
    landed(ws, (g) => {
      if (!c) return {};
      const who = c.author?.login || g.pr?.viewer, at = c.createdAt || new Date().toISOString();
      const mine = { id: c.databaseId, nodeId: c.id, body: c.body, path: place.path, line: place.line, startLine: place.startLine, outdated: false, at, author: who };
      // the review GitHub confirmed (a discarded one's text and comments stay out of it), with this comment once
      return {
        pending: { id, body: fresh.review?.id === id ? fresh.review.body || '' : '', comments: [...(fresh.review?.id === id ? fresh.review.comments : []).filter((x) => x.nodeId !== c.id), mine] },
        threads: [...(g.threads || []).filter((x) => x.id !== th.id), { id: th.id, resolved: false, outdated: false, canResolve: false, canUnresolve: false, canReply: false, path: place.path, line: place.line, startLine: place.startLine, side: place.side === 'LEFT' ? 'old' : 'new', pending: true,
          comments: [{ id: c.databaseId, nodeId: c.id, author: who, body: c.body, at, url: c.url, pending: true }] }],
      };
    }, t);
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
    const { t, fresh } = await freshReviewTarget(ws, guard);
    if (!(fresh.review?.comments || []).some((c) => c.nodeId === nodeId)) { ws.fetchGithub(true).catch(() => {}); throw fail('that comment is not in your pending review on GitHub any more'); }
    await this.preview(ws, { nodeId });
    const d = await gql(DROP_COMMENT, { id: nodeId });
    if (d.errors?.length) throw fail(`GitHub would not delete it: ${clip(d.errors[0].message, 300)}`, 502);
    landed(ws, (g) => ({
      pending: g.pending ? { ...g.pending, comments: g.pending.comments.filter((c) => c.nodeId !== nodeId) } : g.pending,
      threads: (g.threads || []).map((th) => { const comments = th.comments.filter((c) => c.nodeId !== nodeId); return { ...th, comments, pending: comments.some((c) => c.pending) }; }).filter((th) => th.comments.length),
    }), t);
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
    landed(ws, (g) => (g.pr && !(g.pr.timeline || []).some((x) => x.url && x.url === r.html_url) ? { pr: { ...g.pr, timeline: [...(g.pr.timeline || []), { kind: 'comment', id: r.node_id || String(r.id), author: r.user?.login || g.pr.viewer, body: r.body ?? String(body).trim(), at: r.created_at || new Date().toISOString(), url: r.html_url }] } } : {}), t);
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
    landed(ws, (g) => ({ threads: (g.threads || []).map((th) => (th.comments[0]?.id === commentId && !th.comments.some((x) => x.id === r.id)
      ? { ...th, comments: [...th.comments, { id: r.id, nodeId: r.node_id, author: r.user?.login || g.pr?.viewer, body: r.body ?? String(body).trim(), at: r.created_at || new Date().toISOString(), url: r.html_url }] } : th)) }), t);
    return { message: 'Replied on GitHub.', url: r.html_url };
  },
};
const RESOLVE = 'mutation($id:ID!){resolveReviewThread(input:{threadId:$id}){thread{isResolved}}}';
const UNRESOLVE = 'mutation($id:ID!){unresolveReviewThread(input:{threadId:$id}){thread{isResolved}}}';
const resolve = {
  async preview(ws, { threadId, resolved }) {
    const th = (ws.github?.threads || []).find((x) => x.id === threadId);
    if (!th) throw fail('that thread is not on the PR any more');
    if (th.resolved === resolved) throw fail(resolved ? 'that thread is already resolved' : 'that thread is already open');
    if (resolved ? !th.canResolve : !th.canUnresolve) throw fail(`GitHub does not let you ${resolved ? 'resolve' : 'reopen'} that thread`);
    const t = target(ws);
    return { title: `${resolved ? 'Resolve' : 'Reopen'} the thread on ${th.path}`, where: 'on GitHub', confirm: resolved ? 'Resolve' : 'Reopen', items: [], guard: { repo: `${t.owner}/${t.repo}`, number: t.number } };
  },
  // No read in front of it: resolving a thread that is already resolved (or reopening an open one) changes nothing on
  // GitHub, and GitHub's answer says where the thread now stands.
  async run(ws, { threadId, resolved }, guard) {
    const t = sameTarget(ws, guard);
    await this.preview(ws, { threadId, resolved });
    const out = JSON.parse(await gh(['api', 'graphql', '-f', `query=${resolved ? RESOLVE : UNRESOLVE}`, '-f', `id=${threadId}`]) || '{}');
    if (out.errors?.length) throw fail(`GitHub refused: ${clip(out.errors[0].message, 300)}`, 502);
    const now = out.data?.[resolved ? 'resolveReviewThread' : 'unresolveReviewThread']?.thread?.isResolved;
    if (typeof now !== 'boolean') throw fail('GitHub did not confirm the thread\'s state: look at it on GitHub', 502);
    landed(ws, (g) => ({ threads: (g.threads || []).map((th) => (th.id === threadId ? { ...th, resolved: now, canResolve: !now, canUnresolve: now } : th)) }), t);
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
  const def = (ws.meta?.trunk || '').replace(/^origin\//, '') || 'main';
  const comparison = ws.meta?.base || def;
  const [headText, branchText, upstreamText, baseRef] = await Promise.all([
    g(ws, ['rev-parse', '--verify', '--quiet', 'HEAD']).catch(() => ''),
    g(ws, ['rev-parse', '--abbrev-ref', 'HEAD']).catch(() => ''),
    g(ws, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']).catch(() => ''),
    // Git can expand checkout shorthand to a branch name even in symbolic mode.
    comparison === '@' || comparison.includes('@{') ? ''
      : g(ws, ['rev-parse', '--verify', '--symbolic-full-name', '--end-of-options', comparison]).catch(() => ''),
  ]);
  const head = headText.trim() || null;
  const branch = branchText.trim() || 'HEAD';
  const upstream = branch === 'HEAD' ? null : upstreamText.trim() || null;
  const remoteRef = upstream || `origin/${branch}`;
  const [remoteText, destText, remoteShaText, wip] = await Promise.all([
    upstream ? g(ws, ['config', `branch.${branch}.remote`]).catch(() => '') : '',
    upstream ? g(ws, ['config', `branch.${branch}.merge`]).catch(() => '') : '',
    g(ws, ['rev-parse', '--verify', '--quiet', `${remoteRef}^{commit}`]).catch(() => ''),
    head ? changedFiles(ws.rec.root, { old: head, new: WORKTREE }) : [],
  ]);
  const remote = remoteText.trim() || 'origin';
  const dest = destText.trim() || `refs/heads/${branch}`;
  const remoteSha = remoteShaText.trim() || null;
  let ahead = 0, behind = 0;
  if (remoteSha && head) {
    const [b, a] = (await g(ws, ['rev-list', '--left-right', '--count', `${remoteSha}...${head}`]).catch(() => '0\t0')).trim().split(/\s+/).map(Number);
    ahead = a || 0; behind = b || 0;
  } else if (head && ws.meta?.base) ahead = Number((await g(ws, ['rev-list', '--count', `${ws.meta.base}..${head}`]).catch(() => '0')).trim()) || 0;
  let template = '';
  for (const f of ['.github/pull_request_template.md', '.github/PULL_REQUEST_TEMPLATE.md', 'docs/pull_request_template.md', 'pull_request_template.md']) {
    try { template = fsShip.readFileSync(pathShip.join(ws.rec.root, f), 'utf8').slice(0, 6000); break; } catch { /* next */ }
  }
  const pr = ws.github?.pr && ws.github.pr.headRefName === branch ? ws.github.pr : null;
  const base = /^refs\/(?:heads\/|remotes\/[^/]+\/)(.+)$/.exec(baseRef.trim())?.[1] || '';
  return {
    branch, onDefault: branch === def || branch === 'HEAD', defaultBranch: def, upstream, remote, dest, remoteRef, remoteSha, ahead, behind, head,
    base, wipFiles: wip,
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
    await ws.sync(true);
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
    if (diverged && st.ahead === 0) throw fail(`${st.remoteRef} already contains this commit: pull the branch first`);
    if (diverged && !force) return { title: `Push ${st.branch}`, where: `to ${to}`, confirm: 'Push', needsForce: true, items: [], warnings: [`${st.remoteRef} has ${st.behind} commit${st.behind === 1 ? '' : 's'} your branch does not (a rebase or an amend). Pushing means overwriting them.`], guard };
    if (!diverged && st.ahead === 0 && st.remoteSha) throw fail(`${st.branch} is already up to date on ${st.remoteRef}`);
    // the commits that go: the ones no ref of that remote has, as this checkout last fetched it (a ref deleted there
    // and not pruned here still counts); only shown, so a failed read shows the route alone
    const not = [st.head, '--not', `--remotes=${st.remote}`];
    const sending = Number((await g(ws, ['rev-list', '--count', ...not]).catch(() => '')).trim()) || 0;
    const going = (await g(ws, ['log', '--format=%h%x09%s', '-n', '13', ...not]).catch(() => '')).split('\n').filter(Boolean).map((l) => { const [sha, ...rest] = l.split('\t'); return { sha, subject: rest.join('\t') }; });
    return {
      // the route above says where; the footer only what else comes of it
      title: `${diverged ? 'Overwrite' : 'Push'} ${st.branch}`, where: st.upstream ? `to ${st.remote}, as ${st.branch} already tracks` : `to ${st.remote}, and ${st.branch} tracks it from now on`, confirm: diverged ? 'Overwrite' : 'Push', tone: diverged ? 'danger' : 'primary',
      route: { from: st.branch, to: `${st.remote}/${st.dest.replace(/^refs\/heads\//, '')}`, fresh: !st.remoteSha, sending }, commits: going,
      items: [`${st.ahead} commit${st.ahead === 1 ? '' : 's'} ${st.remoteSha ? `onto ${st.remoteRef}` : 'as a new branch'}`, ...(diverged ? [`Replaces ${st.remoteRef} (${st.remoteSha.slice(0, 7)}) only if it is still exactly that: a lease on that commit`] : [])],
      warnings: diverged ? [`${st.behind} commit${st.behind === 1 ? '' : 's'} on the remote will be gone.`] : [],
      guard,
    };
  },
  async run(ws, payload, guard) {
    const st = await shipState(local(ws));
    if (st.onDefault) throw fail(`refusing to push ${st.branch} from here`);
    for (const k of ['head', 'branch', 'remote', 'dest', 'remoteSha']) if (st[k] !== guard?.[k]) throw fail('the branch, its remote or its upstream moved since the preview: look again');
    if (st.remoteSha && st.ahead === 0) throw fail('the remote already contains this commit');
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

// the open pull requests from this repository's own branch of that name (a fork can have a branch of the same name)
async function openPrsFor(owner, repo, branch) {
  const list = JSON.parse(await gh(['pr', 'list', '--repo', `${owner}/${repo}`, '--head', branch, '--state', 'open', '--limit', '100', '--json', 'number,isCrossRepository,headRepositoryOwner']) || '[]');
  return list.filter((p) => !p.isCrossRepository && (!p.headRepositoryOwner?.login || p.headRepositoryOwner.login.toLowerCase() === owner.toLowerCase()));
}
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
    if (!into || into.startsWith('-') || into === ws.meta?.baseFull) throw fail('name the base branch', 400);
    return {
      title: `Open a ${draft ? 'draft ' : ''}pull request on ${st.repo}`, where: `from ${st.branch} into ${into}, as you on GitHub`, confirm: draft ? 'Open draft' : 'Open',
      items: [`“${clip(title, 140)}”`, body.trim() ? `Description: ${clip(body, 200)}` : 'No description'], warnings: [], guard: { head: st.head, branch: st.branch, remoteSha: st.remoteSha, base: into, repo: st.repo },
    };
  },
  async run(ws, payload, guard) {
    // the one thing GitHub must say now: whether this branch already has an open pull request (not a full refresh)
    const [owner, repo] = String(guard?.repo || '').split('/');
    // the remote loupe reads the checkout's PR from (origin, else the first), as the preview did, read again now
    const remotes = (await g(local(ws), ['remote', '-v']).catch(() => '')).split('\n');
    const line = remotes.find((l) => l.startsWith('origin\t')) || remotes[0] || '';
    const origin = GH.githubRepoOf(line.split(/\s+/)[1]);
    if (!origin || `${origin.owner}/${origin.repo}`.toLowerCase() !== String(guard?.repo || '').toLowerCase()) throw fail('this checkout\'s remote is not the repository you previewed: look again');
    const open = owner && repo ? await openPrsFor(owner, repo, guard.branch).catch(() => null) : null;
    if (!open) throw fail('GitHub could not confirm whether this branch already has a pull request: try again');
    if (open.length) throw fail(`#${open[0].number} is already open for ${guard.branch}`);
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
    const repo = ws.github?.repoFull;
    if (!repo) throw fail('this checkout has no GitHub remote');
    const stacks = await GH.ghJson(['api', `repos/${repo}/stacks?pull_request=${Number(pr)}`]);
    const existing = stacks.find((s) => s.pull_requests?.some((p) => p.number === Number(pr)));
    if (existing) throw fail(`#${pr} is already in stack #${existing.number}`);
    return { title: `Add #${pr} to GitHub stack #${stackNumber}`, where: `on GitHub (${repo})`, confirm: 'Add to stack', items: [`#${pr} goes on top of the stack`], warnings: [], guard: { repo, stackNumber: Number(stackNumber), pr: Number(pr) } };
  },
  async run(ws, { stackNumber, pr }, guard) {
    const pv = await this.preview(ws, { stackNumber, pr });
    if (Object.keys(pv.guard).some((k) => pv.guard[k] !== guard?.[k])) throw fail('the stack or pull request changed since the preview: look again');
    await exec(BIN.gh, ['stack', 'link', String(Number(stackNumber)), String(Number(pr))], { cwd: ws.rec.root || ws.gitDir, timeout: 120000 });
    return { message: `#${pr} is in stack #${stackNumber} now.` };
  },
};

Object.assign(ACTIONS, { commit, push, openpr, stacklink });
