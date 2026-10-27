#!/usr/bin/env bash
# Regression suite for the compatibility entry point and all-tenant rollout.
set -euo pipefail
cd "$(dirname "$0")/.."
npx vitest run __tests__/gb-sync-ben.test.js __tests__/gb-sync-all.test.js
