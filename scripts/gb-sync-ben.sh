#!/usr/bin/env bash
# Compatibility entry point for the installed watcher: synchronize every tenant.
set -euo pipefail
exec node "$(dirname "$0")/gb-sync-all.js" "${1:-}"
