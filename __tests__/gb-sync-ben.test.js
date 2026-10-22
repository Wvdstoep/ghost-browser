import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const repo = fileURLToPath(new URL('..', import.meta.url));
const bash = process.platform === 'win32' && existsSync('C:\\Program Files\\Git\\bin\\bash.exe')
  ? 'C:\\Program Files\\Git\\bin\\bash.exe' : 'bash';

describe('Ben Ghost Browser release sync', () => {
  it('is called after a rollout and on no-change cycles', () => {
    const deploy = readFileSync(path.join(repo, 'scripts/gb-auto-deploy.sh'), 'utf8');
    expect(deploy.match(/gb-sync-ben\.sh/g)).toHaveLength(2);
  });
  it('keeps an idle Ben current, defers when busy, and rejects untrusted image names', () => {
    const result = spawnSync(bash, ['scripts/test-gb-sync-ben.sh'], { cwd: repo, encoding: 'utf8' });
    expect(result.status, result.stderr || result.stdout).toBe(0);
  });
});
