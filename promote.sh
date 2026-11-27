#!/bin/bash
# Replace the running loupe with this checkout's committed tree. For working on loupe in one checkout while the service
# runs from another, so a half-made edit never reaches the daemon you review with.
#
#   ./promote.sh             copy this checkout's HEAD into the copy the service runs from
#   ./promote.sh --dry-run   list what would change, and touch nothing
#   ./promote.sh --to DIR    copy into DIR instead (LOUPE_LIVE=DIR does the same)
#
# The live copy is the one the service runs: its LaunchAgent's WorkingDirectory (dev.$LOUPE_NAME.daemon, as install.sh
# writes it). If that is this checkout, there is nothing to copy: git pull here is the update. The daemon takes new
# files by itself (serve --watch): it restarts when src/ changes and reloads open pages when web/ changes.
#   - HEAD only: it refuses while this checkout has uncommitted or untracked files, so "promoted <hash>" is true.
#   - Tracked files only (no .git, no node_modules, nothing stray), copied by content, so a file that is only newer on
#     disk is neither rewritten nor touched and does not restart the daemon for nothing. Files only the live copy has
#     are left as they are, except one this checkout deleted since the last promote, which goes.
#   - A restart cuts off any answer, brief, scene or file notes being written, so it refuses while one is.
#   - The live copy is backed up first, to $LOUPE_HOME/backups (~/.loupe/backups); npm install runs there when
#     package.json or package-lock.json changed.
set -euo pipefail

dry=0 live=${LOUPE_LIVE:-}
while [ $# -gt 0 ]; do
  case $1 in
    --dry-run) dry=1 ;;
    --to) live=${2:?--to needs a directory}; shift ;;
    -h|--help) sed -n '2,18p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "promote.sh: unknown argument $1 (--dry-run, --to DIR)" >&2; exit 2 ;;
  esac
  shift
done

SRC=$(git -C "$(dirname "$0")" rev-parse --show-toplevel)
STATE=${LOUPE_HOME:-$HOME/.loupe}
PLIST="$HOME/Library/LaunchAgents/dev.${LOUPE_NAME:-loupe}.daemon.plist"
plist() { [ -f "$PLIST" ] && [ -x /usr/libexec/PlistBuddy ] && /usr/libexec/PlistBuddy -c "Print :$1" "$PLIST" 2>/dev/null || true; }
[ -n "$live" ] || live=$(plist WorkingDirectory)
[ -n "$live" ] || { echo "no service found ($PLIST): say where the running copy is, ./promote.sh --to DIR" >&2; exit 1; }
LIVE=$(cd "$live" 2>/dev/null && pwd -P) || { echo "$live does not exist" >&2; exit 1; }
[ -f "$LIVE/bin/loupe.mjs" ] || { echo "$LIVE is not a copy of loupe (no bin/loupe.mjs): not touching it" >&2; exit 1; }
if [ "$LIVE" = "$(cd "$SRC" && pwd -P)" ]; then
  echo "the running copy is this checkout itself ($LIVE): there is nothing to copy. To update it: git pull here"
  exit 0
fi

dirty=$(git -C "$SRC" status --porcelain)
if [ -n "$dirty" ]; then printf '%s\nnot promoted: commit or stash these in %s first\n' "$dirty" "$SRC" >&2; exit 1; fi
head=$(git -C "$SRC" rev-parse HEAD) short=$(git -C "$SRC" log -1 --format=%h)

# what this checkout deleted since the last promote (recorded in the live copy), so the copy does not keep it
mark="$LIVE/.loupe-promoted" gone=()
last=$(cat "$mark" 2>/dev/null || true)
if [ -n "$last" ] && git -C "$SRC" cat-file -e "$last^{commit}" 2>/dev/null; then
  while IFS= read -r -d '' f; do [ -e "$LIVE/$f" ] && gone+=("$f"); done < <(git -C "$SRC" diff -z --name-only --diff-filter=D "$last" HEAD)
fi
deps=$(git -C "$SRC" ls-files -z package.json package-lock.json | rsync -anc --no-times --from0 --files-from=- --out-format=%n "$SRC/" "$LIVE/")

if [ $dry = 1 ]; then
  git -C "$SRC" ls-files -z | rsync -anc --no-times --itemize-changes --from0 --files-from=- "$SRC/" "$LIVE/" | grep -v '^\.' || true  # a line starting . is left alone
  for f in ${gone[@]+"${gone[@]}"}; do echo "*deleting $f"; done
  [ -n "$deps" ] && echo "then npm install in $LIVE"
  echo "dry run: would promote $short to $LIVE"
  exit 0
fi

NODE=$(plist ProgramArguments:0); [ -x "$NODE" ] || NODE=$(command -v node || true)
[ -n "$NODE" ] || { echo "no node to check the daemon with" >&2; exit 1; }
busy=$(STATE="$STATE" "$NODE" -e '
  const fs = require("fs"), path = require("path"), ws = path.join(process.env.STATE, "ws");
  let dirs = []; try { dirs = fs.readdirSync(ws); } catch {}
  for (const id of dirs) {
    let d; try { d = JSON.parse(fs.readFileSync(path.join(ws, id, "review.json"), "utf8")); } catch { continue; }
    if (d.brief?.pending) console.log(`${id}: a brief is being written`);
    if (d.brief?.scene?.pending) console.log(`${id}: a scene is being drawn`);
    if (d.notes?.pending) console.log(`${id}: file notes are being written`);
    for (const c of Object.values(d.convs || {})) if ((c.messages || []).some((m) => m && m.pending)) { console.log(`${id}: an answer is being written`); break; }
  }')
if [ -n "$busy" ]; then printf '%s\nnot promoted: wait for these to finish, then run this again\n' "$busy" >&2; exit 1; fi

ts=$(date +%Y%m%d-%H%M%S) backup="$STATE/backups/live-$ts"
mkdir -p "$STATE/backups"
rsync -a --exclude node_modules "$LIVE/" "$backup/"
git -C "$SRC" ls-files -z | rsync -ac --no-times --from0 --files-from=- "$SRC/" "$LIVE/"
for f in ${gone[@]+"${gone[@]}"}; do rm -f -- "$LIVE/$f"; done
[ -n "$deps" ] && (cd "$LIVE" && PATH="$(dirname "$NODE"):$PATH" npm install --no-audit --no-fund --loglevel=error)
echo "$head" > "$mark"
echo "promoted $short to $LIVE (backup $backup)"
