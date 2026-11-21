#!/usr/bin/env bash
# Sets loupe up on this machine, start to finish: its dependencies, the `loupe` command, the service that keeps it
# running at http://loupe.local (and l.local), Claude Code's mod and skill, then `loupe doctor` checks every piece,
# the sign-ins included. Run it again any time: a step that is already done is left as it is.
#
#   ./install.sh                everything
#   ./install.sh --no-service   no LaunchAgent: run `loupe serve` yourself
#   ./install.sh --no-claude    leave Claude Code's plugins alone
set -euo pipefail
cd "$(dirname "$0")"
ROOT=$(pwd -P)
ORIG_PATH=$PATH
service=1 claude=1
for a in "$@"; do
  case $a in
    --no-service) service=0 ;;
    --no-claude) claude=0 ;;
    -h | --help) sed -n '2,8p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $a (see ./install.sh --help)" >&2; exit 2 ;;
  esac
done

if [ -t 1 ]; then B=$'\e[1m' D=$'\e[2m' G=$'\e[32m' R=$'\e[31m' Z=$'\e[0m'; else B='' D='' G='' R='' Z=''; fi
step() { printf '\n%s%s%s\n' "$B" "$1" "$Z"; }
ok() { printf '%s✓%s %s\n' "$G" "$Z" "$1"; }
note() { printf '%s%s%s\n' "$D" "$1" "$Z"; }
fail() { printf '%s✗%s %s\n' "$R" "$Z" "$1" >&2; exit 1; }

step "Node and git"
node_ok() { "$1" -e 'process.exit(+process.versions.node.split(".")[0] >= 22 ? 0 : 1)' >/dev/null 2>&1; }
NODE=$(command -v node || true)
if [ -z "$NODE" ] || ! node_ok "$NODE"; then
  # nvm often loads only in an interactive shell, so look for its Nodes by hand and take the newest that fits
  NODE=''
  for n in "${NVM_DIR:-$HOME/.nvm}"/versions/node/*/bin/node; do [ -x "$n" ] && node_ok "$n" && NODE=$n; done
fi
[ -n "$NODE" ] || fail "loupe needs Node 22 or newer: https://nodejs.org, or nvm install 22"
export PATH="$(dirname "$NODE"):$PATH"
ok "Node $("$NODE" -v)  $D$NODE$Z"
command -v git >/dev/null || fail "git is missing: xcode-select --install, or brew install git"
ok "git"

step "Dependencies"
npm install --no-audit --no-fund --loglevel=error
ok "npm install"

# Asks before replacing something that runs another copy of loupe (the command, the service): that is someone's choice.
# Without a terminal to ask in, it keeps what is there.
replace_ok() {
  [ -t 0 ] || { note "kept: $1"; return 1; }
  read -r -p "$1. Use this copy ($ROOT) instead? [y/N] " yn
  case $yn in [yY]*) return 0 ;; *) note "kept it"; return 1 ;; esac
}
real() { "$NODE" -e 'try { console.log(require("fs").realpathSync(process.argv[1])) } catch {}' "$1"; }

step "The loupe command"
BIN="$(npm prefix -g)/bin"
mine="$ROOT/bin/loupe.mjs" linked=1
for c in "$BIN/loupe" "$(PATH=$ORIG_PATH command -v loupe || true)"; do
  [ -n "$c" ] || continue
  r=$(real "$c")
  if [ -n "$r" ] && [ "$r" != "$mine" ] && [ $linked = 1 ]; then replace_ok "loupe ($c) runs $(dirname "$(dirname "$r")")" || linked=0; fi
done
if [ $linked = 1 ]; then
  npm link --no-audit --no-fund --loglevel=error >/dev/null 2>&1 ||
    fail "npm link could not write to $(npm prefix -g). Use a prefix you own (npm config set prefix ~/.local) and run this again"
  ok "loupe  $D$BIN/loupe$Z"
  case ":$ORIG_PATH:" in
    *":$BIN:"*) ;;
    *) note "  $BIN is not on your PATH: add it (export PATH=\"$BIN:\$PATH\" in your shell's profile) to type loupe" ;;
  esac
fi

step "The service"
PLIST="$HOME/Library/LaunchAgents/dev.${LOUPE_NAME:-loupe}.daemon.plist"
if [ $service = 0 ]; then
  note "skipped (--no-service): run loupe serve to start it"
elif [ "$(uname)" != Darwin ]; then
  note "no service on $(uname): run loupe serve (http://127.0.0.1:${LOUPE_PORT:-4500})"
else
  was=$( [ -f "$PLIST" ] && /usr/libexec/PlistBuddy -c 'Print :WorkingDirectory' "$PLIST" 2>/dev/null || true)
  if [ -z "$was" ] || [ "$was" = "$ROOT" ] || replace_ok "the service runs $was"; then "$NODE" bin/loupe.mjs service install; fi
fi

step "Claude Code"
if [ $claude = 0 ]; then
  note "skipped (--no-claude)"
elif ! command -v claude >/dev/null; then
  note "Claude Code is not installed. Answers need it: https://claude.com/claude-code, then run this again"
else
  have=$(claude plugin list 2>/dev/null | sed -n 's/.*❯ \(loupe@[^ ]*\).*/\1/p' | head -1)
  if [ -n "$have" ] && [ "$have" != loupe@loupe ]; then
    ok "the loupe mod is already installed as $have; left as it is"
  else
    claude plugin marketplace add "$ROOT" >/dev/null 2>&1 || claude plugin marketplace update loupe >/dev/null
    if [ "$have" = loupe@loupe ]; then claude plugin update loupe@loupe >/dev/null; else claude plugin install loupe@loupe --scope user >/dev/null; fi
    ok "the loupe mod and skill (loupe@loupe): /loupe in a session; they load in new sessions"
  fi
fi

step "Check"
doctor_args=()
[ $service = 1 ] || doctor_args+=(--no-service)
if "$NODE" bin/loupe.mjs doctor ${doctor_args[@]+"${doctor_args[@]}"}; then
  url=$("$NODE" -e "fetch('http://127.0.0.1:${LOUPE_PORT:-4500}/api/state').then((r) => r.json()).then((s) => console.log(s.display), () => {})")
  printf '\n%sloupe is ready%s at %s\n' "$B" "$Z" "${url:-http://127.0.0.1:${LOUPE_PORT:-4500}}"
  note "In a repository: loupe. A pull request: loupe <link>, or swap github.com for l.local in its link."
else
  printf '\n%sAlmost:%s fix the ✗ lines above, then run ./install.sh again (or just loupe doctor).\n' "$B" "$Z"
  exit 1
fi
