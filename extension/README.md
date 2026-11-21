# loupe for GitHub

A small Chromium extension (Manifest V3, plain JS, no build) that takes you from GitHub to loupe.

- **`g` then `l`** on github.com opens the page in loupe, in a new tab beside it. On a pull request (any of its tabs:
  conversation, files, commits, checks) that is the pull request; anywhere else, loupe at its root, which reopens the last change you had open. It takes the place of
  GitHub's own `g` `l` (labels); keys typed into a text field, or pressed with ⌘, ⌃, ⌥ or ⇧, are left alone.
- **Open pull requests in loupe automatically** (off until you turn it on): landing on a pull request on GitHub opens
  it in loupe, once per pull request until the browser quits.
- **The toolbar button** does what `g` `l` does, for the current tab. It has no key of its own; give it one at
  `chrome://extensions/shortcuts`.
- **Open link in loupe** on the right-click menu of any link to a pull request, on any page: Slack, mail, GitHub's
  notifications. The GitHub page never loads.

A commit link (`/pull/N/commits/SHA`) opens loupe at that commit (`?scope=SHA`). Everything else opens the pull
request's own path, `/OWNER/REPO/pull/N`, which is the path loupe finds an open pull request at without asking.

## Load it

1. Open `chrome://extensions` (in Helium, `helium://extensions`).
2. Turn on **Developer mode** (top right).
3. **Load unpacked**, and pick this `extension` folder.

After pulling a new version, press the reload arrow on the extension's card. GitHub tabs that were already open keep
GitHub's own `g` `l` until they are reloaded.

## Settings

Right-click the toolbar button, then **Options**. Changes are saved as you make them, in `chrome.storage.sync`.

| Setting | Default | |
|---|---|---|
| Address | `http://loupe.local` | Where loupe answers. **Check** reads loupe's `/api/state` and says what answered. `l.local` is saved as `loupe.local`, since it only redirects. |
| `g` then `l` | on | Off gives the keys back to GitHub. |
| Open pull requests automatically | off | Opening a pull request loupe has not seen fetches it into your clone and writes its brief, so this is yours to turn on. |
| Where | Replace the GitHub tab | See below. |
| Only for | empty (everyone) | Owners or `owner/repo`, separated by commas or spaces. |

**Replace or beside.** With Replace, a tab that was opened for the pull request (its history is that one page: a link
from Slack, mail or a notification) becomes loupe, so you do not collect a GitHub tab for every pull request. A tab
you were browsing GitHub in is never replaced: loupe opens beside it, and the page you came from stays. Replace
closes the GitHub tab and opens loupe in its place rather than sending the tab to loupe, because a GitHub tab sent to
loupe arrives marked as coming from another site, and loupe then asks before opening a pull request it has not seen.
So Back does not return to GitHub; loupe's own GitHub button does, and that pull request is not sent back to loupe,
since it already opened this session. Beside always keeps the GitHub tab.

A tab in the background (a restored session, a link opened behind) opens in loupe when you first look at it, so a
restored window does not open every pull request at once.

## Permissions

- `storage`: the settings, and the list of pull requests already opened this session.
- `contextMenus`: Open link in loupe.
- `https://github.com/*`: the content script, and reading the URL of a GitHub tab for the toolbar button.
- loupe's address, asked for only when you press **Check** or **Allow**, and only for local names (`*.local`,
  `localhost`, `127.0.0.1`, `[::1]`), since loupe answers only there. With it, the extension can read
  `/api/state`, and can see which pull requests your loupe tabs show, so one you open in loupe yourself is not sent
  back from GitHub when you follow loupe's GitHub link. Without it, everything else works.

## Tests

`npm test` at the top of the repository runs these with the rest: the URL rules, the real content script fed key
events, and the service worker with a fake `chrome`. `test/browser.test.mjs` drives real github.com pages with the
extension loaded, against a stand-in for loupe; it needs a browser that takes `--load-extension` (Chrome for Testing,
Chromium, Helium; branded Chrome does not) and the network, and is skipped otherwise:

```bash
LOUPE_EXT_CHROME="/path/to/Google Chrome for Testing" node --test extension/test/browser.test.mjs
```

## Not here, on purpose

- **A button beside the pull request's title.** GitHub's header is React with generated class names, and it would
  have to be put back after every in-page navigation: it would break quietly. `g` `l` and the toolbar button do the
  same without touching the page.
- **The same file or comment.** GitHub's links name a file as `#diff-<sha256 of its path>` and a thread as
  `#discussion_r<id>`. The extension cannot turn those into a path without reading GitHub's page; loupe could, since
  it has the file list and the threads. That belongs in loupe.
