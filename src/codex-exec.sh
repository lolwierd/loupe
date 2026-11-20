#!/bin/sh
# The SDK cannot pass these flags. Keep local auth and session storage, but skip user
# config (including project trust) and rules that could run commands outside the sandbox.
subcommand=$1
shift
# Briefs and drafts are single turns and never need to be resumed.
for arg do
  if [ "$arg" = --output-schema ]; then
    set -- --ephemeral "$@"
    break
  fi
done
exec "${LOUPE_CODEX:-$(dirname "$0")/../node_modules/.bin/codex}" "$subcommand" --ignore-user-config --ignore-rules "$@"
