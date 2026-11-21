// What the extension knows about URLs, settings and keys, with no browser API in it: the content script, the
// service worker and the settings page all load this one classic script, and the tests run it in a bare context.
(function (root) {
  'use strict';

  const DEFAULTS = Object.freeze({
    loupe: 'http://loupe.local', // where loupe answers
    shortcut: true,              // g then l on github.com
    autoOpen: false,             // open a pull request in loupe on landing
    autoOpenMode: 'replace',     // 'replace' the GitHub tab (when it was opened for this PR), or open 'beside' it
    autoOpenOwners: '',          // owners or owner/repo, comma or space separated; empty is everyone
  });

  // The first path segments on github.com that are GitHub's own pages, never an owner.
  const RESERVED = new Set(['about', 'account', 'apps', 'codespaces', 'collections', 'copilot', 'dashboard', 'enterprise',
    'enterprises', 'explore', 'features', 'issues', 'login', 'logout', 'marketplace', 'new', 'notifications', 'organizations',
    'orgs', 'pricing', 'pulls', 'search', 'security', 'sessions', 'settings', 'signup', 'site', 'sponsors', 'stars', 'topics',
    'trending', 'users']);

  const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
  const REPO = /^[\w.-]{1,100}$/;
  const SHA = /^[0-9a-f]{7,40}$/i;

  // A pull request named by a github.com URL, on any of its tabs: conversation, files, commits, checks.
  // /OWNER/REPO/pull/N/commits/SHA (and files/SHA) also names that one commit, which loupe reads as ?scope=SHA.
  function parsePr(href) {
    let u;
    try { u = new URL(href); } catch { return null; }
    if (u.protocol !== 'https:' || u.hostname !== 'github.com') return null;
    return parsePath(u.pathname);
  }
  function parsePath(pathname) {
    const parts = String(pathname).split('/').filter(Boolean);
    if (parts.length < 4 || parts[2] !== 'pull' || !/^[1-9]\d{0,9}$/.test(parts[3])) return null;
    const [owner, repo] = parts;
    if (!OWNER.test(owner) || !REPO.test(repo) || RESERVED.has(owner.toLowerCase())) return null;
    const pr = { owner, repo, number: Number(parts[3]), tab: parts[4] || 'conversation' };
    if (['commits', 'files', 'changes'].includes(parts[4]) && parts[5] && SHA.test(parts[5])) pr.commit = parts[5].toLowerCase();
    return pr;
  }
  const prKey = (pr) => `${pr.owner}/${pr.repo}#${pr.number}`.toLowerCase();

  // The address a person typed, as an origin: a scheme is added when missing, l.local (which only redirects) becomes
  // loupe.local, and GitHub itself is refused so nothing can open in a loop.
  function normalizeBase(input) {
    let s = String(input ?? '').trim();
    if (!s) s = DEFAULTS.loupe;
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = 'http://' + s;
    let u;
    try { u = new URL(s); } catch { return { ok: false, error: 'That is not an address.' }; }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return { ok: false, error: 'The address must start with http:// or https://.' };
    if (u.username || u.password) return { ok: false, error: 'The address cannot carry a user name or password.' };
    if (u.hostname === 'github.com' || u.hostname.endsWith('.github.com')) return { ok: false, error: 'That is GitHub, not loupe.' };
    if (u.hostname === 'l.local') u.hostname = 'loupe.local';
    return { ok: true, origin: u.origin };
  }
  const baseOf = (input) => { const b = normalizeBase(input); return b.ok ? b.origin : DEFAULTS.loupe; };

  // The pattern to ask the browser for: scheme and host. A pattern with no port covers every port.
  function permissionPattern(origin) {
    const u = new URL(origin);
    return `${u.protocol}//${u.hostname}/*`;
  }

  // Where a GitHub page opens in loupe: a pull request at its own path (the bare one, which loupe finds without
  // asking), a commit of it as ?scope=, and anything else at loupe's root.
  function loupeUrlFor(href, base) {
    const origin = baseOf(base);
    const pr = parsePr(href);
    if (!pr) return origin + '/';
    return origin + `/${pr.owner}/${pr.repo}/pull/${pr.number}` + (pr.commit ? `?scope=${pr.commit}` : '');
  }

  // A loupe URL that shows a pull request, from loupe's own tab.
  function parseLoupePr(href, base) {
    let u;
    try { u = new URL(href); } catch { return null; }
    if (u.origin !== baseOf(base)) return null;
    return parsePath(u.pathname);
  }

  // The allowlist: "acme, someone/tool" lets every repository of acme and one of someone's.
  function parseOwners(text) {
    return String(text || '').split(/[\s,]+/).map((s) => s.trim().replace(/^@/, '').replace(/^https?:\/\/github\.com\//i, '').replace(/\/+$/, '').toLowerCase()).filter(Boolean);
  }
  function ownerAllowed(pr, text) {
    const list = parseOwners(text);
    if (!list.length) return true;
    const owner = pr.owner.toLowerCase(), repo = `${owner}/${pr.repo.toLowerCase()}`;
    return list.some((e) => e === owner || e === repo);
  }

  // A key typed into something that takes text is not a shortcut. Check boxes, radios and buttons take no text,
  // so g l still works with one focused (the Viewed box on the files tab, say), as GitHub's own keys do.
  const NOT_TEXT = new Set(['button', 'checkbox', 'color', 'file', 'image', 'radio', 'range', 'reset', 'submit']);
  function isTyping(el) {
    if (!el || el.nodeType !== 1) return false;
    if (el.isContentEditable) return true;
    const tag = String(el.tagName || '').toLowerCase();
    if (tag === 'textarea' || tag === 'select') return true;
    if (tag === 'input') return !NOT_TEXT.has(String(el.type || 'text').toLowerCase());
    return false;
  }

  // g then l, within the time GitHub gives its own sequences. step() says what a key did: 'start' (a g),
  // 'done' (the l that completes it) or null.
  const MODIFIER_KEYS = new Set(['Shift', 'Control', 'Alt', 'Meta', 'CapsLock', 'AltGraph', 'Fn']);
  function createSequence(timeout = 1500) {
    let at = -Infinity;
    return {
      step(e, now) {
        if (MODIFIER_KEYS.has(e.key) || e.repeat || e.isComposing) return null;
        if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) { at = -Infinity; return null; }
        if (e.key === 'l' && now - at <= timeout) { at = -Infinity; return 'done'; }
        if (e.key === 'g') { at = now; return 'start'; }
        at = -Infinity;
        return null;
      },
      reset() { at = -Infinity; },
    };
  }

  root.loupeLink = Object.freeze({ DEFAULTS, parsePr, parsePath, prKey, normalizeBase, baseOf, permissionPattern, loupeUrlFor, parseLoupePr, parseOwners, ownerAllowed, isTyping, createSequence });
})(globalThis);
