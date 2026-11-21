---
name: loupe
description: Open, find or fix loupe, the always-on local review desk at http://loupe.local where you read PRs, branches and uncommitted work and ask Claude or Codex about lines, read-only. Use when the user types /loupe, asks to open a PR, branch or repository "in loupe", to review this session's changes, where a workspace is, or why loupe misbehaves.
---

# loupe

One daemon serves every workspace at http://loupe.local (also http://127.0.0.1:4500), one URL per workspace. Its state
is in `~/.loupe`.

## Open something

Hand over the URL; do not open a browser unless asked.

```sh
loupe --no-open <PR link | owner/repo#123 | #123 in a clone | path>   # prints the URL
loupe --no-open --base <ref> <path>                                    # a checkout against another branch
loupe ls                                                               # workspaces, and what is left in each
```

In a Claude Code session the loupe mod does this by itself: the session's first edit in a repository opens it in
loupe, and home lists it under "Open here" with the session's name. `/loupe` prints the links for the repositories
the session edited, each with a chat linked to the session (a read-only fork). `/loupe live` lets the browser send
questions into the session itself; `/loupe off` stops it.

A GitHub pull request link with `github.com` swapped for `l.local` opens in loupe too. From a browser, the extension in
loupe's `extension/` folder (loaded unpacked) does it from GitHub itself: `g` then `l` on a pull request opens it in
loupe, and a pull request link's right-click menu has "Open link in loupe".

## What it writes by itself

- **File notes:** one or two lines above each file that needs them, saying its part in the change. They are written as
  a change opens, by the newest Haiku unless another is picked in ⌘K ("File notes model…"), and written again only for
  files that changed. The settings menu turns them off.
- **The brief** (the map and the guide) is written only when asked, unless "Write the brief when a PR opens" is on.

## Health

`loupe doctor` checks everything: git, gh and its sign-in, Claude Code's sign-in (and that loupe's own call to it is
signed in), Codex, the daemon, loupe.local and l.local, port 80, the service and this mod. `loupe status`,
`loupe service logs` and `loupe service restart` cover the rest. The daemon restarts itself when its own source
changes.

| Symptom | Cause, fix |
|---|---|
| `loupe.local` doesn't resolve | the daemon is down (it holds the mDNS records): `loupe service restart` |
| A PR stays on "Opening…" | gh is not signed in, or the fetch failed: the page shows the error; `gh auth status` |
| Answers fail with an auth error | the Claude Code login expired: run `claude`, then `/login` |
| Codex is missing from the picker | the Codex CLI is not signed in: `codex login` |

Claude inside loupe is read-only by construction (Read, Grep, Glob, a fixed-argument git tool, a guard on every tool
call, no repository settings), and Codex runs in its read-only sandbox. Every write to git or GitHub is previewed and
needs the user's click.
