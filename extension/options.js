// The settings page. Every change is saved as it is made (chrome.storage.sync); the address is saved once it reads as
// an address. Access to loupe's address is asked for only from a click (Check, or Allow), never on load.
const L = globalThis.loupeLink;
const $ = (id) => document.getElementById(id);
let current = { ...L.DEFAULTS };

const save = (key, value) => { current[key] = value; return chrome.storage.sync.set({ [key]: value }); };
const status = (tone, text) => { const el = $('status'); el.dataset.tone = tone; el.textContent = text; };

function hasAccess(origin) {
  return chrome.permissions.contains({ origins: [L.permissionPattern(origin)] }).catch(() => false);
}
// Called straight from a click, before anything is awaited, so the browser can show its prompt. An address outside
// the local names the manifest lists (loupe.local, localhost, 127.0.0.1) cannot be asked for: that comes back as null.
function askAccess(origin) {
  try { return chrome.permissions.request({ origins: [L.permissionPattern(origin)] }).catch(() => null); }
  catch { return Promise.resolve(null); }
}

async function check(origin, access) {
  status('wait', `Asking ${origin}…`);
  if (!access) {
    // No access: a request that cannot be read still says whether anything is there.
    try {
      await fetch(origin + '/api/state', { mode: 'no-cors', cache: 'no-store', credentials: 'omit', signal: AbortSignal.timeout(4000) });
      status('warn', access === null
        ? `Something answers at ${origin}, but the extension can read only a local address (loupe.local, localhost, 127.0.0.1), so it cannot tell whether this is loupe.`
        : `Something answers at ${origin}. Allow access when Check asks, to see whether it is loupe.`);
    } catch { status('bad', `Nothing answers at ${origin}.`); }
    return;
  }
  let r;
  try { r = await fetch(origin + '/api/state', { cache: 'no-store', credentials: 'omit', signal: AbortSignal.timeout(4000) }); }
  catch { return status('bad', `Nothing answers at ${origin}. Is loupe's daemon running? (loupe status)`); }
  if (r.status === 421 && /^loupe answers only/.test(await r.text().catch(() => ''))) {
    return status('warn', `loupe is there, but it answers only to its own names: use loupe.local or 127.0.0.1.`);
  }
  const j = r.ok ? await r.json().catch(() => null) : null;
  if (!j || typeof j.version !== 'string' || !('workspaces' in j)) return status('warn', `Something answers at ${origin}, but it is not loupe (HTTP ${r.status}).`);
  const open = Array.isArray(j.workspaces) ? j.workspaces.length : 0;
  status('ok', `loupe ${j.version} answers at ${origin}, with ${open} ${open === 1 ? 'change' : 'changes'} open.`);
}

// ---------------------------------------------------------------- drawing
const MODE_HINT = {
  replace: 'A tab opened for the pull request (a link from Slack, email or a notification) becomes loupe. A tab you were browsing GitHub in stays, and loupe opens beside it.',
  beside: 'loupe opens in a new tab next to the GitHub tab, which stays.',
};
function drawAuto() {
  const on = current.autoOpen;
  $('auto-options').setAttribute('aria-disabled', String(!on));
  for (const el of $('auto-options').querySelectorAll('button, input')) el.disabled = !on;
  const mode = current.autoOpenMode === 'beside' ? 'beside' : 'replace';
  for (const b of $('mode').querySelectorAll('button')) b.setAttribute('aria-pressed', String(b.dataset.mode === mode));
  $('mode-hint').textContent = MODE_HINT[mode];
  drawAccess();
}
async function drawAccess() {
  const origin = L.baseOf(current.loupe);
  $('access').hidden = !current.autoOpen || (await hasAccess(origin));
}

// ---------------------------------------------------------------- events
$('address-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const b = L.normalizeBase($('address').value);
  $('address').setAttribute('aria-invalid', String(!b.ok));
  if (!b.ok) return status('bad', b.error);
  $('address').value = b.origin;
  const asked = askAccess(b.origin);
  status('wait', `Asking for access to ${b.origin}…`);
  await save('loupe', b.origin);
  await check(b.origin, await asked);
  drawAccess();
});
$('address').addEventListener('change', () => {
  const b = L.normalizeBase($('address').value);
  $('address').setAttribute('aria-invalid', String(!b.ok));
  if (!b.ok) return status('bad', b.error);
  $('address').value = b.origin;
  if (b.origin !== current.loupe) { save('loupe', b.origin); status('', ''); drawAccess(); }
});
$('shortcut').addEventListener('change', (e) => save('shortcut', e.target.checked));
$('autoOpen').addEventListener('change', (e) => { save('autoOpen', e.target.checked); drawAuto(); });
$('mode').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-mode]');
  if (!b) return;
  save('autoOpenMode', b.dataset.mode);
  drawAuto();
});
$('owners').addEventListener('change', (e) => {
  const text = L.parseOwners(e.target.value).join(', ');
  e.target.value = text;
  save('autoOpenOwners', text);
});
$('allow').addEventListener('click', async () => {
  const origin = L.baseOf(current.loupe);
  const access = await askAccess(origin);
  drawAccess();
  if (access) check(origin, true);
});
$('keys').addEventListener('click', () => chrome.tabs.create({ url: 'chrome://extensions/shortcuts' }));

(async function load() {
  try { current = { ...L.DEFAULTS, ...(await chrome.storage.sync.get(null)) }; } catch { /* the defaults */ }
  const origin = L.baseOf(current.loupe);
  $('address').value = origin;
  $('shortcut').checked = current.shortcut;
  $('autoOpen').checked = current.autoOpen;
  $('owners').value = current.autoOpenOwners;
  drawAuto();
  // Allowed before: read loupe's state now, with no prompt.
  if (await hasAccess(origin)) check(origin, true);
})();
