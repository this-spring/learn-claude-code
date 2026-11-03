import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export function pythonReference(chapter: string, cwd: string, data: unknown): { result: unknown; requests: unknown[] } {
  const run = spawnSync('python3', [fileURLToPath(new URL('./python-oracle.py', import.meta.url)), chapter], {
    cwd, input: JSON.stringify(data), encoding: 'utf8', maxBuffer: 16 * 1024 * 1024,
  });
  assert.equal(run.status, 0, run.stderr);
  return JSON.parse(run.stdout);
}
