// The service worker: it opens loupe tabs (for g l, the toolbar button and the link menu), and decides whether a pull
// request you landed on opens in loupe on its own. Tabs are always created here, never navigated from GitHub's page:
// a tab the extension creates reaches loupe as a typed address would, while a GitHub tab sent to loupe arrives
// marked cross-site, and loupe then asks before opening a pull request it has not seen.
importScripts('link.js');
const L = globalThis.loupeLink;

async function settings() {
  let got = {};
  try { got = await chrome.storage.sync.get(null); } catch { /* the defaults */ }
  const s = { ...L.DEFAULTS, ...got };
  s.base = L.baseOf(s.loupe);
  return s;
}

// ---------------------------------------------------------------- once per pull request per browser session
// Kept in storage.session, which outlives the worker going to sleep and is gone when the browser quits. Every open
// the extension makes is marked, and so is a pull request seen in a loupe tab, so following loupe's own "Open on
// GitHub" link does not bounce straight back.
const marking = new Set();
async function markOnce(key) {
  if (marking.has(key)) return false;
  marking.add(key);
  const id = 'opened:' + key;
  try {
    const got = await chrome.storage.session.get(id);
    if (got[id]) return false;
    await chrome.storage.session.set({ [id]: Date.now() });
  } catch { /* without session storage the in-memory set still holds for this worker's life */ }
  return true;
}
async function mark(href) {
  const pr = L.parsePr(href);
  if (pr) await markOnce(L.prKey(pr));
}

// ---------------------------------------------------------------- opening
function openBeside(tab, url) {
  const props = { url, active: true };
  if (tab && tab.id >= 0) { props.index = tab.index + 1; props.windowId = tab.windowId; props.openerTabId = tab.id; }
  return chrome.tabs.create(props);
}
async function openInPlace(tab, url) {
  const made = await chrome.tabs.create({ url, index: tab.index, windowId: tab.windowId, active: true });
  await chrome.tabs.remove(tab.id).catch(() => {});
  return made;
}
async function openHere(tab, href) {
  const s = await settings();
  await mark(href);
  return openBeside(tab, L.loupeUrlFor(href, s.base));
}

async function landed(tab, href, fresh) {
  const s = await settings();
  if (!s.autoOpen || !tab || tab.incognito) return null;
  const pr = L.parsePr(href);
  if (!pr || !L.ownerAllowed(pr, s.autoOpenOwners)) return null;
  if (!(await markOnce(L.prKey(pr)))) return null;
  const url = L.loupeUrlFor(href, s.base);
  if (s.autoOpenMode !== 'beside' && fresh && !tab.pinned) return openInPlace(tab, url);
  return openBeside(tab, url);
}

chrome.runtime.onMessage.addListener((msg, sender) => {
  if (sender.id !== chrome.runtime.id || !sender.tab || typeof msg?.url !== 'string') return;
  if (msg.type === 'open') openHere(sender.tab, msg.url);
  else if (msg.type === 'landed') landed(sender.tab, msg.url, msg.fresh === true);
});

// A loupe tab showing a pull request marks it too. Its URL is visible only once you have let the extension reach
// loupe's address (the settings page asks), so without that this does nothing.
chrome.tabs.onUpdated.addListener(async (tabId, change) => {
  if (!change.url) return;
  const s = await settings();
  const pr = L.parseLoupePr(change.url, s.base);
  if (pr) await markOnce(L.prKey(pr));
});

// ---------------------------------------------------------------- the toolbar button and the link menu
chrome.action.onClicked.addListener((tab) => openHere(tab, tab.url || ''));

const MENU = 'open-link-in-loupe';
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: MENU, title: 'Open link in loupe', contexts: ['link'], targetUrlPatterns: ['https://github.com/*/*/pull/*'] });
  });
});
chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== MENU || !L.parsePr(info.linkUrl || '')) return;
  openHere(tab, info.linkUrl);
});
