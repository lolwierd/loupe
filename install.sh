#!/usr/bin/env bash
# Sets loupe up on this machine, start to finish: its dependencies, the `loupe` command, https if you want it, the
# service that keeps it running at http://loupe.local (and l.local), Claude Code's mod and skill, then `loupe doctor`
# checks every piece, the sign-ins included. Run it again any time: a step that is already done is left as it is. Run
# again in a checkout while the service runs another copy of loupe, it promotes this checkout's HEAD to that copy
# (promote.sh) and keeps the command and the mod on it, so the copy you review with is updated, not swapped.
#
#   ./install.sh                everything; asks whether to set up https, and whether to promote
#   ./install.sh --https        set up https without asking (mkcert: your password once, for its local CA)
#   ./install.sh --no-https     do not ask about https
#   ./install.sh --promote      promote to the copy the service runs without asking
#   ./install.sh --no-promote   do not promote; ask instead whether to move loupe to this checkout
#   ./install.sh --no-service   no LaunchAgent: run `loupe serve` yourself
#   ./install.sh --no-claude    leave Claude Code's plugins alone
set -euo pipefail
cd "$(dirname "$0")"
ROOT=$(pwd -P)
ORIG_PATH=$PATH
service=1 claude=1 https=ask promote=ask
for a in "$@"; do
  case $a in
    --no-service) service=0 ;;
    --no-claude) claude=0 ;;
    --https) https=yes ;;
    --no-https) https=no ;;
    --promote) promote=yes ;;
    --no-promote) promote=no ;;
    -h | --help) sed -n '2,14p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
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
  read -r -p "$1. Use this copy ($TARGET) instead? [y/N] " yn
  case $yn in [yY]*) return 0 ;; *) note "kept it"; return 1 ;; esac
}
real() { "$NODE" -e 'try { console.log(require("fs").realpathSync(process.argv[1])) } catch {}' "$1"; }

# The copy loupe runs from: this checkout, or, when the service already runs another copy and this checkout is a git
# checkout of its own, that copy, brought up to this checkout's committed HEAD by promote.sh (asked first; Enter says
# yes). Without a terminal to ask in it promotes only with --promote, and otherwise keeps what is there.
PLIST="$HOME/Library/LaunchAgents/dev.${LOUPE_NAME:-loupe}.daemon.plist"
LIVE=$( [ $service = 1 ] && [ "$(uname)" = Darwin ] && [ -f "$PLIST" ] && /usr/libexec/PlistBuddy -c 'Print :WorkingDirectory' "$PLIST" 2>/dev/null || true)
TARGET=$ROOT
if [ -n "$LIVE" ] && [ "$LIVE" != "$ROOT" ] && [ -f "$LIVE/bin/loupe.mjs" ] && [ $promote != no ] && git rev-parse --git-dir >/dev/null 2>&1; then
  step "Promote"
  what="$(git rev-parse --abbrev-ref HEAD) at $(git log -1 --format=%h)"
  if [ $promote = ask ]; then
    if [ -t 0 ]; then
      note "The service runs another copy of loupe, $LIVE: running this again updates it from this checkout."
      read -r -p "Promote $what to it? [Y/n] " yn
      case $yn in [nN]*) promote=no ;; *) promote=yes ;; esac
    else
      promote=no
      note "not promoted (no terminal to ask in): ./install.sh --promote, or ./promote.sh"
    fi
  fi
  if [ $promote = yes ]; then
    ./promote.sh || fail "not promoted (see above): the running loupe is as it was"
    TARGET=$LIVE
    ok "promoted $what  $D$LIVE$Z"
  fi
fi
[ "$TARGET" = "$LIVE" ] || promote=no

step "The loupe command"
BIN="$(npm prefix -g)/bin"
mine="$TARGET/bin/loupe.mjs" linked=1
for c in "$BIN/loupe" "$(PATH=$ORIG_PATH command -v loupe || true)"; do
  [ -n "$c" ] || continue
  r=$(real "$c")
  if [ -n "$r" ] && [ "$r" != "$mine" ] && [ $linked = 1 ]; then replace_ok "loupe ($c) runs $(dirname "$(dirname "$r")")" || linked=0; fi
done
if [ $linked = 1 ]; then
  (cd "$TARGET" && npm link --no-audit --no-fund --loglevel=error >/dev/null 2>&1) ||
    fail "npm link could not write to $(npm prefix -g). Use a prefix you own (npm config set prefix ~/.local) and run this again"
  ok "loupe  $D$BIN/loupe$Z"
  case ":$ORIG_PATH:" in
    *":$BIN:"*) ;;
    *) note "  $BIN is not on your PATH: add it (export PATH=\"$BIN:\$PATH\" in your shell's profile) to type loupe" ;;
  esac
fi

# https for loupe.local (and l.local): a certificate from mkcert's private CA in <state>/tls, read when the daemon starts
# (docs/HTTPS.md). It is asked before the service starts, so a new certificate is taken up with no restart. Without a
# terminal to ask in, or with --no-https, nothing here runs; the steps stay in docs/HTTPS.md.
step "https"
TLS="${LOUPE_HOME:-$HOME/.loupe}/tls" HOST="${LOUPE_NAME:-loupe}.local" made_tls=0
names=("$HOST"); [ "${LOUPE_NAME:-loupe}" = loupe ] && names+=(l.local)
if [ -f "$TLS/cert.pem" ] && [ -f "$TLS/key.pem" ]; then
  ok "a certificate is there: https://$HOST  $D$TLS$Z"
elif [ "$(uname)" != Darwin ]; then
  note "set up by hand off macOS, if you want it: docs/HTTPS.md"
else
  if [ $https = ask ]; then
    if [ -t 0 ]; then
      note "https serves https://$HOST with a certificate your browser trusts. It uses mkcert: a private certificate"
      note "authority made on this machine and added to the system keychain (your password, once; mkcert -uninstall"
      note "takes it out), and a certificate for ${names[*]} from it."
      read -r -p "Set up https? [y/N] " yn
      case $yn in [yY]*) https=yes ;; *) https=no ;; esac
    else
      https=no
    fi
  fi
  if [ $https = no ]; then
    note "no https: http://$HOST works as it is (./install.sh --https sets it up later)"
  elif ! command -v mkcert >/dev/null && ! { command -v brew >/dev/null && brew install mkcert >/dev/null; }; then
    note "https needs mkcert (brew install mkcert, or https://github.com/FiloSottile/mkcert); then ./install.sh --https"
  elif ! mkcert -install; then
    note "mkcert could not add its CA to the keychain; the steps are in docs/HTTPS.md"
  elif mkdir -p "$TLS" && chmod 700 "$TLS" && mkcert -cert-file "$TLS/cert.pem" -key-file "$TLS/key.pem" "${names[@]}" >/dev/null 2>&1; then
    made_tls=1
    ok "https for ${names[*]}  $D$TLS$Z"
  else
    note "mkcert could not make the certificate; the steps are in docs/HTTPS.md"
  fi
fi

step "The service"
if [ $service = 0 ]; then
  note "skipped (--no-service): run loupe serve to start it"
elif [ "$(uname)" != Darwin ]; then
  note "no service on $(uname): run loupe serve (http://127.0.0.1:${LOUPE_PORT:-4500})"
elif [ $promote = yes ]; then # it runs the copy just promoted to, and takes the new files by itself
  ok "runs $LIVE"
  [ $made_tls = 0 ] || { "$NODE" bin/loupe.mjs service restart >/dev/null && ok "restarted the service, so it takes the certificate"; }
else
  was=$LIVE
  if [ -z "$was" ] || [ "$was" = "$ROOT" ] || replace_ok "the service runs $was"; then
    "$NODE" bin/loupe.mjs service install
  elif [ $made_tls = 1 ]; then
    "$NODE" bin/loupe.mjs service restart >/dev/null && ok "restarted the service, so it takes the certificate"
  fi
fi
[ $made_tls = 1 ] && [ $service = 0 ] && note "loupe serve takes the certificate when it starts"

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
    claude plugin marketplace add "$TARGET" >/dev/null 2>&1 || claude plugin marketplace update loupe >/dev/null
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
