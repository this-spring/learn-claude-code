// Optional live smoke: uses the existing .env in a disposable copy; never prints credentials or model output.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('..', import.meta.url));
const fixture = mkdtempSync(join(tmpdir(), 'learn-live-api-'));
const project = join(fixture, 'project');
cpSync(root, project, { recursive: true, filter: (path) => !/(?:^|\/)(?:node_modules|\.env|\.runtime|\.memory|\.tasks|\.teams|\.mailboxes|\.worktrees|\.transcripts|\.task_outputs|__pycache__)(?:\/|$)/.test(path.slice(root.length)) });
symlinkSync(join(root, 'node_modules'), join(project, 'node_modules'), 'dir');
writeFileSync(join(project, '.env'), readFileSync(join(root, '.env')), { mode: 0o600 });
const report = [];
try {
  for (const chapter of readdirSync(project).filter((name) => /^s\d\d_/.test(name)).sort()) {
    const tag = chapter.slice(0, 3), cwd = join(fixture, tag); mkdirSync(cwd);
    const query = 'Reply with exactly LIVE_API_PASS. Do not call tools or store memories.';
    const argv = tag === 's17' ? ['/goal The next assistant reply must be exactly LIVE_API_PASS. Reply now with LIVE_API_PASS and do not call tools.'] : [];
    const child = spawn(process.execPath, ['--import', join(root, 'node_modules/tsx/dist/loader.mjs'), join(project, chapter, 'code.ts'), ...argv], {
      cwd, env: { ...process.env, MAX_TURNS: '2', CLAUDE_CODE_STOP_HOOK_BLOCK_CAP: '1' }, stdio: ['pipe', 'pipe', 'pipe'],
    });
    let output = '', errors = '', sent = false, quitting = false, timed_out = false;
    const start = Date.now();
    const timer = setTimeout(() => { timed_out = true; child.kill('SIGKILL'); }, 90000);
    child.stdout.on('data', (chunk) => {
      output += chunk;
      if (!sent && output.includes('>>')) { sent = true; child.stdin.write(query + '\n'); }
      if (output.includes('Allow?')) child.stdin.write('n\n');
      if (!quitting && output.includes('LIVE_API_PASS')) {
        quitting = true; setTimeout(() => { if (!child.stdin.destroyed) child.stdin.write('q\n'); }, 100);
      }
    });
    child.stderr.on('data', (chunk) => { errors += chunk; });
    const exit = await new Promise((done) => child.on('close', (code, signal) => done({ code, signal })));
    clearTimeout(timer);
    const pass = exit.code === 0 && output.includes('LIVE_API_PASS') && (tag !== 's17' || output.includes('[goal] achieved:'));
    report.push({ chapter: tag, pass, ...exit, timed_out, seconds: Number(((Date.now() - start) / 1000).toFixed(2)),
      ...(pass ? {} : { error_status: errors.match(/\b(?:400|401|403|404|408|413|429|500|502|503|504|529)\b/)?.[0] ?? null }) });
    console.log(`${tag}: live API ${pass ? 'PASS' : 'FAIL'} (${report.at(-1).seconds}s)`);
  }
  writeFileSync(join(root, 'docs/live-api-verification.json'), JSON.stringify({ date: new Date().toISOString(), node: process.version, report }, null, 2) + '\n');
  assert.ok(report.every((item) => item.pass), `${report.filter((item) => !item.pass).length} live smoke runs failed; see docs/live-api-verification.json`);
} finally { rmSync(fixture, { recursive: true, force: true }); }
