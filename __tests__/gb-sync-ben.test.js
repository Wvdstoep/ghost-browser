import { it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
it('keeps the installed watcher entry point and delegates to all-tenant discovery', () => {
  const root = new URL('../', import.meta.url);
  const deploy = readFileSync(new URL('scripts/gb-auto-deploy.sh', root), 'utf8');
  expect(deploy.match(/gb-sync-ben\.sh/g)).toHaveLength(2);
  expect(readFileSync(new URL('scripts/gb-sync-ben.sh', root), 'utf8')).toContain('gb-sync-all.js');
});
