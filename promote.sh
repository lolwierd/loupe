#!/bin/bash
# Replace the running loupe with a checkout's committed tree. For working on loupe in one checkout while the service
# runs from another, so a half-made edit never reaches the daemon you review with.
#
#   ./promote.sh               copy this checkout's HEAD into the copy the service runs from
#   ./promote.sh --dry-run     list what would change, and touch nothing
#   ./promote.sh --ref REF     promote that commit instead (main, origin/main, a sha): this checkout's own files and
#                              branch are left as they are
#   ./promote.sh --from DIR    the checkout to promote from, when the script is not run from inside it
#   ./promote.sh --to DIR      copy into DIR instead (LOUPE_LIVE=DIR does the same)
#
# The live copy is the one the service runs: its LaunchAgent's WorkingDirectory (dev.$LOUPE_NAME.daemon, as install.sh
# writes it). The daemon takes new files by itself (serve --watch): it restarts when src/ changes and reloads open
# pages when web/ changes. If the live copy is the checkout itself, there is nothing to copy: git pull there is the
# update, and --ref fast-forwards it to that commit when it is clean and that commit is ahead of it.
#   - HEAD only: without --ref it refuses while the checkout has uncommitted or untracked files.
#   - Tracked files only (no .git, no node_modules, nothing stray), copied by content, so a file that is only newer on
#     disk is neither rewritten nor touched and does not restart the daemon for nothing. Files only the live copy has
#     are left as they are, except one deleted since the last promote, which goes.
#   - A restart cuts off any answer, brief, scene or file notes being written, so it refuses while one is.
#   - The live copy is backed up first, to $LOUPE_HOME/backups (~/.loupe/backups); npm install runs there when
#     package.json or package-lock.json changed. It records what it promoted, and from where, in the live copy
#     (.loupe-promoted, .loupe-source), which is how the running loupe knows when its source has moved on.
set -euo pipefail

dry=0 live=${LOUPE_LIVE:-} ref='' from=''
while [ $# -gt 0 ]; do
  case $1 in
    --dry-run) dry=1 ;;
    --to) live=${2:?--to needs a directory}; shift ;;
    --ref) ref=${2:?--ref needs a commit}; shift ;;
    --from) from=${2:?--from needs a checkout}; shift ;;
    -h|--help) sed -n '2,24p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "promote.sh: unknown argument $1 (--dry-run, --ref REF, --from DIR, --to DIR)" >&2; exit 2 ;;
  esac
  shift
done

SRC=$(git -C "${from:-$(dirname "$0")}" rev-parse --show-toplevel 2>/dev/null) || { echo "${from:-$(dirname "$0")} is not a git checkout of loupe: say which, --from DIR" >&2; exit 1; }
SRC=$(cd "$SRC" && pwd -P)
# git in the source checkout, with its hooks and its file monitor off: what this runs there is git's own work only
G() { git -c core.hooksPath=/dev/null -c core.fsmonitor=false -C "$SRC" "$@"; }
STATE=${LOUPE_HOME:-$HOME/.loupe}
PLIST="$HOME/Library/LaunchAgents/dev.${LOUPE_NAME:-loupe}.daemon.plist"
plist() { [ -f "$PLIST" ] && [ -x /usr/libexec/PlistBuddy ] && /usr/libexec/PlistBuddy -c "Print :$1" "$PLIST" 2>/dev/null || true; }
[ -n "$live" ] || live=$(plist WorkingDirectory)
[ -n "$live" ] || { echo "no service found ($PLIST): say where the running copy is, ./promote.sh --to DIR" >&2; exit 1; }
LIVE=$(cd "$live" 2>/dev/null && pwd -P) || { echo "$live does not exist" >&2; exit 1; }
[ -f "$LIVE/bin/loupe.mjs" ] || { echo "$LIVE is not a copy of loupe (no bin/loupe.mjs): not touching it" >&2; exit 1; }

NODE=$(plist ProgramArguments:0); [ -x "$NODE" ] || NODE=$(command -v node || true)
# what loupe is in the middle of, which the daemon's restart would cut off
busy() {
  [ -n "$NODE" ] || { echo "no node to check the daemon with"; return; }
  # the daemon knows best (what is on disk can be left over from a restart); if it does not answer, the files say
  local said
  if said=$(curl -sf --max-time 3 "http://127.0.0.1:${LOUPE_PORT:-4500}/api/busy" 2>/dev/null) && [ -n "$said" ]; then
    printf '%s' "$said" | "$NODE" -e 'let s="";process.stdin.on("data",(d)=>s+=d).on("end",()=>{try{for(const w of JSON.parse(s).busy||[])console.log(w)}catch{console.log("the daemon gave an answer that is not JSON")}})'
    return
  fi
  STATE="$STATE" "$NODE" -e '
    const fs = require("fs"), path = require("path"), ws = path.join(process.env.STATE, "ws");
    let dirs = []; try { dirs = fs.readdirSync(ws); } catch {}
    for (const id of dirs) {
      let d; try { d = JSON.parse(fs.readFileSync(path.join(ws, id, "review.json"), "utf8")); } catch { continue; }
      if (d.brief?.pending) console.log(`${id}: a brief is being written`);
      if (d.brief?.scene?.pending) console.log(`${id}: a scene is being drawn`);
      if (d.notes?.pending) console.log(`${id}: file notes are being written`);
      for (const c of Object.values(d.convs || {})) if ((c.messages || []).some((m) => m && m.pending)) { console.log(`${id}: an answer is being written`); break; }
    }'
}
# one promote at a time; whatever it unpacked goes with it
lock="$STATE/promote.lock" tmp=''
cleanup() { [ -z "$tmp" ] || rm -rf -- "$tmp" "$tmp.index"; rm -f -- "$lock/pid"; rmdir "$lock" 2>/dev/null || true; }
if [ $dry = 0 ]; then
  mkdir -p "$STATE"
  if ! mkdir "$lock" 2>/dev/null; then # held: by a promote still running, or left by one that was killed
    holder=$(cat "$lock/pid" 2>/dev/null || true)
    if [ -n "$holder" ] && kill -0 "$holder" 2>/dev/null; then echo "not promoted: another promote is running (pid $holder)" >&2; exit 1; fi
    rm -rf -- "$lock"; mkdir "$lock" || { echo "not promoted: cannot take $lock" >&2; exit 1; }
  fi
  echo $$ > "$lock/pid"
  trap cleanup EXIT
fi
deps_between() { G diff --name-only "$1" "$2" -- package.json package-lock.json; }

# The live copy is the checkout itself: nothing to copy. With --ref, a fast-forward to that commit.
if [ "$LIVE" = "$SRC" ]; then
  [ -n "$ref" ] || { echo "the running copy is this checkout itself ($LIVE): there is nothing to copy. To update it: git pull here"; exit 0; }
  to=$(G rev-parse --verify "$ref^{commit}") || { echo "no commit $ref in $SRC" >&2; exit 1; }
  at=$(G rev-parse HEAD)
  [ "$to" != "$at" ] || { echo "already at $(G log -1 --format=%h "$to")"; exit 0; }
  G merge-base --is-ancestor "$at" "$to" || { echo "not updated: $LIVE has commits $ref does not; pull or rebase there by hand" >&2; exit 1; }
  [ -z "$(G status --porcelain)" ] || { echo "not updated: $LIVE has uncommitted changes" >&2; exit 1; }
  [ $dry = 0 ] || { G log --format='  %h %s' "$at..$to"; echo "dry run: would fast-forward $LIVE to $(G log -1 --format=%h "$to")"; exit 0; }
  b=$(busy); [ -z "$b" ] || { printf '%s\nnot updated: wait for these to finish, then run this again\n' "$b" >&2; exit 1; }
  G merge --ff-only --quiet "$to"
  [ -z "$(deps_between "$at" "$to")" ] || (cd "$LIVE" && PATH="$(dirname "$NODE"):$PATH" npm install --no-audit --no-fund --loglevel=error)
  echo "updated $LIVE to $(G log -1 --format=%h "$to")"
  exit 0
fi

# What is copied: the working tree's tracked files at a clean HEAD, or a commit's own tree, unpacked through a
# throwaway index (every tracked file, as committed; the checkout's index and files are not touched)
if [ -z "$ref" ]; then
  dirty=$(G status --porcelain)
  if [ -n "$dirty" ]; then printf '%s\nnot promoted: commit or stash these in %s first\n' "$dirty" "$SRC" >&2; exit 1; fi
  sha=$(G rev-parse HEAD) TREE=$SRC
  files() { G ls-files -z; }
else
  sha=$(G rev-parse --verify "$ref^{commit}") || { echo "no commit $ref in $SRC" >&2; exit 1; }
  if [ $dry = 0 ]; then tmp=$(mktemp -d "${TMPDIR:-/tmp}/loupe-promote.XXXXXX"); else TREE=$SRC; fi
  if [ -n "$tmp" ]; then
    GIT_INDEX_FILE="$tmp.index" G read-tree "$sha"
    GIT_INDEX_FILE="$tmp.index" G checkout-index -a -f --prefix="$tmp/"
    TREE=$tmp
  fi
  files() { G ls-tree -r -z --name-only "$sha"; }
fi
short=$(G log -1 --format=%h "$sha")

# what was deleted since the last promote (recorded in the live copy), so the copy does not keep it
mark="$LIVE/.loupe-promoted" gone=()
last=$(head -n 1 "$mark" 2>/dev/null || true)
if [ -n "$last" ] && G cat-file -e "$last^{commit}" 2>/dev/null; then
  while IFS= read -r -d '' f; do [ -e "$LIVE/$f" ] && gone+=("$f"); done < <(G diff -z --name-only --diff-filter=D "$last" "$sha")
fi

if [ $dry = 1 ]; then
  if [ -n "$ref" ]; then # nothing unpacked: say what the commit changes against what was promoted last
    if [ -n "$last" ] && G cat-file -e "$last^{commit}" 2>/dev/null; then G diff --stat "$last" "$sha" | tail -n 30; else echo "(nothing recorded as promoted: every tracked file of $short)"; fi
  else
    files | rsync -anc --no-times --itemize-changes --from0 --files-from=- "$TREE/" "$LIVE/" | grep -v '^\.' || true  # a line starting . is left alone
  fi
  for f in ${gone[@]+"${gone[@]}"}; do echo "*deleting $f"; done
  echo "dry run: would promote $short to $LIVE"
  exit 0
fi

b=$(busy)
if [ -n "$b" ]; then printf '%s\nnot promoted: wait for these to finish, then run this again\n' "$b" >&2; exit 1; fi
deps=''
for f in package.json package-lock.json; do [ ! -f "$TREE/$f" ] || cmp -s "$TREE/$f" "$LIVE/$f" || deps=1; done

ts=$(date +%Y%m%d-%H%M%S) backup="$STATE/backups/live-$ts"
mkdir -p "$STATE/backups"
rsync -a --exclude node_modules "$LIVE/" "$backup/"
files | rsync -ac --no-times --from0 --files-from=- "$TREE/" "$LIVE/"
for f in ${gone[@]+"${gone[@]}"}; do rm -f -- "$LIVE/$f"; done
[ -z "$deps" ] || (cd "$LIVE" && PATH="$(dirname "$NODE"):$PATH" npm install --no-audit --no-fund --loglevel=error)
echo "$sha" > "$mark"
# where it came from: the repository's main checkout (a worktree comes and goes; its commits stay in the repository)
common=$(G rev-parse --path-format=absolute --git-common-dir 2>/dev/null || true)
home=$SRC; [ -z "$common" ] || [ "$(basename "$common")" != .git ] || home=$(cd "$common/.." && pwd -P)
echo "$home" > "$LIVE/.loupe-source"
echo "promoted $short to $LIVE (backup $backup)"
