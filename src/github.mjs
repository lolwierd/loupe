// GitHub, through the gh CLI and its login: a pull request's details, checks, reviews and review threads, and the
// pull request (if any) behind a local branch. Reads here; the writes are in actions.mjs, each behind a confirm.
import path from 'node:path';
import { BIN, STATE_DIR } from './config.mjs';
import { run, JsonFile } from './util.mjs';

const gh = (argv, opts = {}) => {
  if (!BIN.gh) return Promise.reject(new Error('gh is not installed'));
  return run(BIN.gh, argv, { timeout: 60000, ...opts });
};
export const ghJson = async (argv, opts) => JSON.parse(await gh(argv, opts));

let viewerP = null;
export const viewer = () => (viewerP ||= gh(['api', 'user', '--jq', '.login']).then((s) => s.trim()).catch((e) => { viewerP = null; throw e; }));

// Kept for as long as loupe runs, once read. A read that failed is asked again a minute later: kept, it would leave the
// repository's default branch unknown until loupe restarted, and asked at once, a sync that needs it would wait on gh
// failing every time.
const repoSettings = new Map(); // owner/repo -> { value, failedAt }
const SETTINGS_RETRY_MS = 60000;
export function mergeSettings(owner, repo) {
  const k = `${owner}/${repo}`, hit = repoSettings.get(k);
  if (hit && !(hit.failedAt && Date.now() - hit.failedAt >= SETTINGS_RETRY_MS)) return hit.value;
  const entry = { value: null, failedAt: 0 };
  entry.value = ghJson(['repo', 'view', k, '--json', 'squashMergeAllowed,mergeCommitAllowed,rebaseMergeAllowed,deleteBranchOnMerge,defaultBranchRef'])
    .catch(() => { entry.failedAt = Date.now(); return null; });
  repoSettings.set(k, entry);
  return entry.value;
}

const PR_FIELDS = 'number,title,body,author,state,isDraft,url,baseRefName,headRefName,headRefOid,baseRefOid,reviewDecision,mergeStateStatus,mergeable,statusCheckRollup,latestReviews,reviewRequests,reviews,comments,labels,assignees,additions,deletions,changedFiles,createdAt,updatedAt,mergedAt,closedAt,isCrossRepository';

// One check, as the page draws it: its name, where it stands, and a link.
function check(c) {
  const name = c.name || c.context || 'check';
  const state = (c.conclusion || c.state || c.status || '').toUpperCase();
  const kind = ['SUCCESS', 'NEUTRAL', 'SKIPPED'].includes(state) ? (state === 'SUCCESS' ? 'pass' : 'skip')
    : ['FAILURE', 'ERROR', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE'].includes(state) ? 'fail' : 'run';
  return { name, kind, state: state.toLowerCase().replace(/_/g, ' '), url: c.detailsUrl || c.targetUrl || null, workflow: c.workflowName || null };
}

export function viewerReview(reviews, login) {
  if (!login) return null;
  const latest = reviews.filter((r) => r.author?.login?.toLowerCase() === login.toLowerCase()
    && ['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED'].includes(r.state))
    .sort((a, b) => Date.parse(a.submittedAt) - Date.parse(b.submittedAt)).at(-1);
  if (!latest?.commit?.oid || latest.state === 'DISMISSED') return null;
  return { event: latest.state === 'APPROVED' ? 'APPROVE' : 'REQUEST_CHANGES', head: latest.commit.oid, at: Date.parse(latest.submittedAt) };
}

export async function pullRequest(owner, repo, number) {
  const [pr, me] = await Promise.all([ghJson(['pr', 'view', String(number), '--repo', `${owner}/${repo}`, '--json', PR_FIELDS]), viewer().catch(() => null)]);
  const checks = (pr.statusCheckRollup || []).map(check);
  // The timeline: conversation comments and submitted reviews, oldest first. A review with no text and no
  // verdict worth showing (a COMMENTED review that only holds inline comments) is folded into one line.
  const timeline = [
    ...(pr.comments || []).map((c) => ({ kind: 'comment', id: c.id, author: c.author?.login, body: c.body, at: c.createdAt, url: c.url })),
    ...(pr.reviews || []).filter((r) => r.state !== 'PENDING' && (r.body?.trim() || r.state === 'APPROVED' || r.state === 'CHANGES_REQUESTED'))
      .map((r) => ({ kind: 'review', id: r.id, author: r.author?.login, body: r.body, state: r.state, at: r.submittedAt, url: r.url || null })),
  ].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const latest = new Map();
  for (const r of pr.latestReviews || []) latest.set(r.author?.login, r.state);
  const reviewers = [
    ...[...latest].map(([login, state]) => ({ login, state: state.toLowerCase().replace(/_/g, ' ') })),
    ...(pr.reviewRequests || []).map((r) => ({ login: r.login || r.name || r.slug, state: 'requested', team: !r.login })).filter((r) => !latest.has(r.login)),
  ];
  return {
    number: pr.number, title: pr.title, body: pr.body, author: pr.author?.login, state: pr.state, isDraft: pr.isDraft, url: pr.url,
    baseRefName: pr.baseRefName, headRefName: pr.headRefName, headRefOid: pr.headRefOid, baseRefOid: pr.baseRefOid,
    reviewDecision: pr.reviewDecision, mergeStateStatus: pr.mergeStateStatus, mergeable: pr.mergeable,
    labels: (pr.labels || []).map((l) => l.name), additions: pr.additions, deletions: pr.deletions, changedFiles: pr.changedFiles,
    createdAt: pr.createdAt, updatedAt: pr.updatedAt, mergedAt: pr.mergedAt, closedAt: pr.closedAt, crossRepo: pr.isCrossRepository,
    checks, checkSummary: { pass: checks.filter((c) => c.kind === 'pass').length, fail: checks.filter((c) => c.kind === 'fail').length, run: checks.filter((c) => c.kind === 'run').length, skip: checks.filter((c) => c.kind === 'skip').length },
    reviewers, timeline, viewer: me, viewerReview: viewerReview(pr.reviews || [], me), viewerIsAuthor: !!me && me === pr.author?.login,
    assignees: (pr.assignees || []).map((a) => a.login).filter(Boolean),
    viewerIsAssignee: !!me && (pr.assignees || []).some((a) => a.login === me),
  };
}

// Review threads, with whether each is resolved or outdated: what the REST comments list can't say.
const THREADS = `query($o:String!,$r:String!,$n:Int!,$after:String){repository(owner:$o,name:$r){pullRequest(number:$n){
  reviewThreads(first:100,after:$after){pageInfo{hasNextPage endCursor} nodes{id isResolved isOutdated viewerCanResolve viewerCanUnresolve viewerCanReply path line startLine originalLine originalStartLine diffSide startDiffSide
    comments(first:100){nodes{id databaseId body author{login} createdAt url state}}}}}}}`;
export async function reviewThreads(owner, repo, number) {
  const out = [];
  let after = null;
  for (let page = 0; page < 10; page++) {
    const argv = ['api', 'graphql', '-f', `query=${THREADS}`, '-f', `o=${owner}`, '-f', `r=${repo}`, '-F', `n=${number}`];
    if (after) argv.push('-f', `after=${after}`);
    const d = await ghJson(argv);
    const t = d.data?.repository?.pullRequest?.reviewThreads;
    if (!t) break;
    for (const n of t.nodes) {
      out.push({
        id: n.id, resolved: n.isResolved, outdated: n.isOutdated, canResolve: n.viewerCanResolve, canUnresolve: n.viewerCanUnresolve, canReply: n.viewerCanReply,
        path: n.path, line: n.line ?? n.originalLine, startLine: n.startLine ?? n.originalStartLine, side: n.diffSide === 'LEFT' ? 'old' : 'new',
        comments: (n.comments?.nodes || []).map((c) => ({ id: c.databaseId, nodeId: c.id, author: c.author?.login, body: c.body, at: c.createdAt, url: c.url, pending: c.state === 'PENDING' })),
        pending: (n.comments?.nodes || []).some((c) => c.state === 'PENDING'),
      });
    }
    if (!t.pageInfo.hasNextPage) break;
    after = t.pageInfo.endCursor;
  }
  return out;
}

// An image from outside GitHub shows the way GitHub shows it, through its image proxy (camo): the page loads images
// only from GitHub, and the proxy keeps whoever posted one from learning who reads it. Only GitHub can sign a proxy
// address, so they are read from the PR's comments as GitHub renders them, where each image carries the address it was
// written with beside the proxy's. Asked only when some text has an outside image the last answer did not cover.
export const GITHUB_IMAGE = /^https:\/\/(github\.com|([\w-]+\.)+githubusercontent\.com)\//i; // the page's img-src, exactly
export function outsideImages(texts) {
  const out = new Set();
  for (const t of texts) {
    for (const m of String(t || '').matchAll(/(?:!\[[^\]]*\]\(\s*<?|\b(?:src|srcset)\s*=\s*["']?)(https:\/\/[^\s)"'<>]+)/gi)) {
      if (!GITHUB_IMAGE.test(m[1])) out.add(m[1].replace(/&amp;/g, '&'));
    }
  }
  return out;
}
const entity = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" };
const unescape = (s) => s.replace(/&(amp|lt|gt|quot|#39);/g, (m, k) => entity[k]);
// written address -> proxy address, from GitHub's HTML
export function proxiedImages(html) {
  const out = {};
  for (const [tag] of String(html || '').matchAll(/<(?:img|source)\b[^>]*>/gi)) {
    const written = /\sdata-canonical-src="([^"]*)"/i.exec(tag)?.[1];
    const proxy = /\s(?:src|srcset)="(https:\/\/camo\.githubusercontent\.com\/[^"\s]*)"/i.exec(tag)?.[1];
    if (written && proxy) out[unescape(written)] = unescape(proxy);
  }
  return out;
}
const RENDERED = `query($o:String!,$r:String!,$n:Int!){repository(owner:$o,name:$r){pullRequest(number:$n){bodyHTML
  comments(last:100){nodes{bodyHTML}} reviews(last:100){nodes{bodyHTML comments(first:50){nodes{bodyHTML}}}}}}}`;
export async function imageProxies(owner, repo, number, texts, known = {}) {
  const want = [...outsideImages(texts)];
  if (want.every((u) => u in known)) return Object.fromEntries(want.map((u) => [u, known[u]]));
  const d = await ghJson(['api', 'graphql', '-f', `query=${RENDERED}`, '-f', `o=${owner}`, '-f', `r=${repo}`, '-F', `n=${number}`]);
  const pr = d.data?.repository?.pullRequest;
  if (!pr) return {};
  const html = [pr.bodyHTML, ...(pr.comments?.nodes || []).map((c) => c.bodyHTML),
    ...(pr.reviews?.nodes || []).flatMap((r) => [r.bodyHTML, ...(r.comments?.nodes || []).map((c) => c.bodyHTML)])];
  // one GitHub did not proxy (past the first hundred comments, or a URL written oddly) is kept as null, so it is not
  // asked about again every minute
  return { ...Object.fromEntries(want.map((u) => [u, null])), ...proxiedImages(html.join('\n')) };
}

// Your review on a PR that is started but not submitted (GitHub keeps one per person): its comments are drafts only
// you can see. loupe adds to it and submits it, so a review begun on GitHub and one begun here are the same review.
const DRAFT_COMMENTS = 'pageInfo{hasNextPage endCursor} nodes{id databaseId body path line startLine originalLine originalStartLine outdated createdAt author{login}}';
const PENDING = `query($o:String!,$r:String!,$n:Int!,$after:String){viewer{login} repository(owner:$o,name:$r){pullRequest(number:$n){id headRefOid baseRefName baseRefOid state
  latestOpinionatedReviews(first:100){nodes{author{login} state submittedAt commit{oid}}}
  reviews(first:20,states:PENDING,after:$after){pageInfo{hasNextPage endCursor} nodes{id viewerDidAuthor body
    comments(first:100){${DRAFT_COMMENTS}}}}}}}`;
const MORE_DRAFT_COMMENTS = `query($id:ID!,$after:String!){node(id:$id){... on PullRequestReview{
  comments(first:100,after:$after){${DRAFT_COMMENTS}}}}}`;

export async function pendingReview(owner, repo, number) {
  const argv = ['api', 'graphql', '-f', `query=${PENDING}`, '-f', `o=${owner}`, '-f', `r=${repo}`, '-F', `n=${number}`];
  const next = (connection) => {
    if (!Array.isArray(connection?.nodes) || !connection.pageInfo) throw new Error('GitHub did not return pending reviews');
    if (!connection.pageInfo.hasNextPage) return null;
    if (!connection.pageInfo.endCursor) throw new Error('GitHub did not return the next page of pending reviews');
    return connection.pageInfo.endCursor;
  };
  let pr, review, me = null, after = null;
  do {
    const d = await ghJson(after ? [...argv, '-f', `after=${after}`] : argv);
    pr = d.data?.repository?.pullRequest;
    me ||= d.data?.viewer?.login || null;
    if (d.errors?.length || !pr?.id) throw new Error('GitHub did not return pending reviews');
    after = next(pr.reviews);
    review = pr.reviews.nodes.find((r) => r.viewerDidAuthor);
  } while (!review && after);
  // the PR's head, base and state and your latest verdict come with it, so one read is enough to check a write against
  // (actions.mjs). The verdict is read as pullRequest's is: your latest approval or request for changes (a comment-only
  // review after one does not hide it), none once dismissed.
  const verdict = viewerReview(pr.latestOpinionatedReviews?.nodes || [], me);
  const about = { prId: pr.id, head: pr.headRefOid || null, base: pr.baseRefName || null, state: pr.state || null, viewerReview: verdict };
  if (!review) return { ...about, review: null };

  let page = review.comments;
  const comments = [];
  for (;;) {
    after = next(page);
    for (const c of page.nodes) comments.push({ id: c.databaseId, nodeId: c.id, body: c.body, path: c.path, line: c.line ?? c.originalLine, startLine: c.startLine ?? c.originalStartLine, outdated: c.outdated, at: c.createdAt, author: c.author?.login });
    if (!after) break;
    const d = await ghJson(['api', 'graphql', '-f', `query=${MORE_DRAFT_COMMENTS}`, '-f', `id=${review.id}`, '-f', `after=${after}`]);
    if (d.errors?.length) throw new Error('GitHub did not return pending comments');
    page = d.data?.node?.comments;
  }
  return { ...about, review: { id: review.id, body: review.body || '', comments } };
}

// The pull request behind a local branch, if one is open (or the newest closed one).
export async function prForBranch(owner, repo, branch) {
  if (!branch || branch === 'HEAD') return null;
  const list = (await ghJson(['pr', 'list', '--repo', `${owner}/${repo}`, '--head', branch, '--state', 'all', '--limit', '10', '--json', 'number,state,headRefOid,updatedAt,headRepositoryOwner,headRepository,isCrossRepository']))
    // Only a PR from this repository's own branch: a fork can have a branch of the same name.
    .filter((p) => !p.isCrossRepository && (!p.headRepositoryOwner?.login || p.headRepositoryOwner.login.toLowerCase() === owner.toLowerCase()));
  const pick = list.find((p) => p.state === 'OPEN') || list.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))[0];
  return pick ? pick.number : null;
}

export function githubRepoOf(url) {
  const m = /github\.com[:/]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/i.exec(String(url || '').trim());
  return m ? { owner: m[1], repo: m[2] } : null;
}

// The inbox, sorted by whose move it is. One GraphQL search each for "review requested from me" and "mine", with
// each PR's review decision and check state, so home can say "your move" or "waiting on others" and why.
const SEARCH = `query($q:String!){viewer{login} search(query:$q,type:ISSUE,first:40){nodes{... on PullRequest{number title url isDraft updatedAt
  additions deletions changedFiles headRefName baseRefName
  repository{nameWithOwner} author{login __typename} reviewDecision commits(last:1){nodes{commit{statusCheckRollup{state}}}}}}}}`;
// The last whole answer is kept on disk as well, with whose it is (the login its searches ran as), so home has it at once
// after a restart (every update restarts loupe, and the page reloads with it) while a new one is read, once gh is known
// to be signed in as the same person. Home is told when a read brings an answer other than one its tabs were given.
const INBOX = new JsonFile(path.join(STATE_DIR, 'inbox.json'), null);
const inboxShape = (v) => JSON.stringify([v?.prs, v?.error]);
let kept = Array.isArray(INBOX.data?.value?.prs) && INBOX.data.who ? INBOX.data : null; // the last run's, not yet checked
let keptShape = kept ? inboxShape(kept.value) + kept.who : null;
let inboxCache = null, inboxBusy = false, inboxReading = null;
let inboxSeq = 0, inboxApplied = 0; // reads in the order they began: one that began earlier never replaces a later one
const served = new Set(); // what home's tabs were given since they were last told
const serve = (v) => { served.add(inboxShape(v)); return v; };
const inboxWatchers = new Set();
export function onInboxChanged(fn) { inboxWatchers.add(fn); return () => inboxWatchers.delete(fn); }
export async function inbox(fresh = false) {
  if (!fresh && !inboxCache && kept) {
    const k = kept, me = await viewer().catch(() => null);
    if (kept === k) kept = null; // checked once
    if (!inboxCache && me && me.toLowerCase() === String(k.who).toLowerCase()) inboxCache = { at: k.at, value: k.value };
  }
  // Home never waits on GitHub once it has asked once: past two minutes it gets the last answer and a refresh starts.
  if (!fresh && inboxCache) {
    if (Date.now() - inboxCache.at > 120000 && !inboxBusy && !inboxReading) { inboxBusy = true; inbox(true).catch(() => {}).finally(() => { inboxBusy = false; }); }
    return serve(inboxCache.value);
  }
  if (!fresh && inboxReading) return inboxReading.then(serve); // nothing to show yet: the read under way (the one at boot)
  const read = readInbox();
  inboxReading = read;
  const done = () => { if (inboxReading === read) inboxReading = null; };
  read.then(done, done);
  return fresh ? read : read.then(serve);
}
async function readInbox() {
  const seq = ++inboxSeq;
  const q = (query) => ghJson(['api', 'graphql', '-f', `query=${SEARCH}`, '-f', `q=${query}`])
    .then((d) => (d.data?.search ? { nodes: d.data.search.nodes || [], login: d.data.viewer?.login || null } : null)).catch(() => null);
  const found = await Promise.all([q('is:pr is:open review-requested:@me archived:false'), q('is:pr is:open author:@me archived:false'), q('is:pr is:open assignee:@me archived:false')]);
  const [review, mine, assigned] = found.map((r) => r?.nodes ?? null);
  if (seq < inboxApplied && inboxCache) return inboxCache.value; // a read begun after this one has already answered
  inboxApplied = seq;
  // whose it is: the one login all three searches ran as (gh switched accounts mid-read: nobody's, and it is not kept)
  const logins = new Set(found.filter(Boolean).map((r) => r.login));
  // searches that came back as different people: two accounts' rows, none of them kept
  if (logins.size > 1) return inboxCache?.value || { prs: [], error: 'gh changed accounts while home was read: look again', at: Date.now() };
  const me = logins.size === 1 ? [...logins][0] : null;
  const mineAssigned = new Set((assigned || []).map((p) => `${p.repository?.nameWithOwner}#${p.number}`));
  const row = (p, whose) => {
    const checks = p.commits?.nodes?.[0]?.commit?.statusCheckRollup?.state || null; // SUCCESS FAILURE ERROR PENDING EXPECTED
    const bot = p.author?.__typename === 'Bot' || /\[bot\]$/.test(p.author?.login || '');
    let move, stage;
    if (whose === 'review') { move = 'you'; stage = 'review requested'; }
    else if (whose === 'assigned') { move = 'them'; stage = p.isDraft ? 'assigned to you · draft' : checks === 'FAILURE' || checks === 'ERROR' ? 'assigned to you · checks failing' : 'assigned to you'; }
    else if (p.reviewDecision === 'CHANGES_REQUESTED') { move = 'you'; stage = 'changes requested'; }
    else if (checks === 'FAILURE' || checks === 'ERROR') { move = 'you'; stage = 'checks failing'; }
    else if (p.reviewDecision === 'APPROVED') { move = 'you'; stage = checks === 'PENDING' ? 'approved · checks running' : 'approved · ready to merge'; }
    else { move = 'them'; stage = p.isDraft ? 'draft' : checks === 'PENDING' ? 'checks running' : 'waiting on review'; }
    return { repo: p.repository?.nameWithOwner, number: p.number, title: p.title, author: p.author?.login, bot, updatedAt: p.updatedAt, isDraft: p.isDraft, url: p.url, checks, decision: p.reviewDecision, move, stage, whose, add: p.additions ?? null, del: p.deletions ?? null, files: p.changedFiles ?? null, head: p.headRefName || null, base: p.baseRefName || null, assigned: mineAssigned.has(`${p.repository?.nameWithOwner}#${p.number}`) };
  };
  const value = {
    // one row per PR: a review request wins, then yours, then one you are only assigned to
    prs: [...(review || []).map((p) => row(p, 'review')), ...(mine || []).map((p) => row(p, 'mine')), ...(assigned || []).map((p) => row(p, 'assigned'))]
      .filter((r, i, all) => all.findIndex((x) => x.repo === r.repo && x.number === r.number) === i),
    error: review === null && mine === null ? 'GitHub search failed (is gh signed in?)' : null, at: Date.now(),
  };
  inboxCache = { at: Date.now(), value };
  // A read that failed, or found only part (a search that failed drops its rows), is neither what home opens with next
  // time nor a reason to redraw it now: it shows when home next asks.
  if (review !== null && mine !== null && assigned !== null) {
    const shape = inboxShape(value);
    if (me && shape + me !== keptShape) {
      try { INBOX.data = { ...inboxCache, who: me }; INBOX.flush(); keptShape = shape + me; } catch { /* a full disk: kept in memory only */ }
    }
    if ([...served].some((x) => x !== shape)) { served.clear(); for (const fn of inboxWatchers) { try { fn(); } catch { /* a watcher's own trouble */ } } }
  }
  return value;
}
