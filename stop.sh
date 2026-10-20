#!/bin/sh
set -eu
cd "$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
exec node --disable-warning=ExperimentalWarning scripts/stop-server.ts
