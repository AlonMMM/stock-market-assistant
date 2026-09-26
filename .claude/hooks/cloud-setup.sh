#!/bin/bash
# Prepare Claude Code on the web containers so doctor/check can run.
# Local sessions are untouched: developers manage Node and npm ci themselves.
set -euo pipefail

if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

cd "${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel)}"
required="$(cat .nvmrc)"

if [ "$(node -v 2>/dev/null | sed -E 's/^v([0-9]+).*/\1/')" != "$required" ]; then
  export NVM_DIR="${NVM_DIR:-/opt/nvm}"
  # nvm.sh returns non-zero when no default alias exists yet.
  set +eu
  . "$NVM_DIR/nvm.sh"
  nvm install "$required" >&2
  set -eu
  node_bin="$(dirname "$(nvm which "$required")")"
  export PATH="$node_bin:$PATH"
  if [ -n "${CLAUDE_ENV_FILE:-}" ]; then
    echo "export PATH=\"$node_bin:\$PATH\"" >>"$CLAUDE_ENV_FILE"
  fi
fi

# npm install (not ci) reuses the cached container's node_modules.
npm install --no-audit --no-fund >&2
