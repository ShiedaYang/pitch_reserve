#!/bin/sh
set -eu
cd "$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
if ! command -v node >/dev/null 2>&1; then
  echo 'Node.js 24+ is required.' >&2
  exit 1
fi
node -e 'if(Number(process.versions.node.split(".")[0])<24){console.error("Node.js 24+ is required.");process.exit(1)}'
if [ ! -d node_modules ]; then
  echo 'Dependencies are missing. Run npm ci first.' >&2
  exit 1
fi
umask 077
exec node --disable-warning=ExperimentalWarning scripts/start-server.ts "$@"
