import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const reference = resolve(root, '..');
const chapters = readdirSync(reference).filter((name) => /^s(0[1-9]|1[0-7])_/.test(name)).sort();
const files = (directory, prefix = '') => readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
  const name = join(prefix, entry.name);
  return entry.isDirectory() ? files(join(directory, entry.name), name) : [name];
});
let markdown = 0;
let images = 0;
let links = 0;
for (const chapter of chapters) {
  const original = join(reference, chapter);
  const migrated = join(root, chapter);
  for (const name of files(original).filter((name) => name.endsWith('.md') || name.startsWith('images/'))) {
    const target = join(migrated, name);
    assert.ok(existsSync(target), `Missing material: ${chapter}/${name}`);
    if (name.startsWith('images/')) {
      assert.deepEqual(readFileSync(target), readFileSync(join(original, name)), `Image differs: ${chapter}/${name}`);
      images += 1;
      continue;
    }
    markdown += 1;
    const text = readFileSync(target, 'utf8');
    assert.doesNotMatch(text, /^```python\b/m, `Python code fence remains: ${target}`);
    assert.doesNotMatch(text, /\bpython(?:3)?\s+(?:s\d+_[\w]+\/)?code\.py/, `Python run command remains: ${target}`);
    assert.doesNotMatch(text, /pip install -r requirements\.txt|example\/hello\.py|same Python process/, `Stale Python runtime instruction: ${target}`);
    assert.ok(text.includes('code.ts'), `Missing TS entry: ${target}`);
    const prose = text.replace(/^```[^\n]*\n[\s\S]*?^```\s*$/gm, '');
    for (const match of prose.matchAll(/\]\(([^)]+)\)/g)) {
      const url = match[1].split(/\s+"/)[0];
      if (/^(?:[a-z]+:|#)/i.test(url)) continue;
      const pathname = decodeURIComponent(url.split('#')[0]);
      assert.ok(existsSync(resolve(dirname(target), pathname)), `Broken link: ${target} -> ${url}`);
      links += 1;
    }
  }
  const code = readFileSync(join(migrated, 'code.ts'), 'utf8');
  assert.match(code, /^\/\*\*[\s\S]*?\*\//, `Missing source header: ${chapter}`);
  assert.ok(existsSync(join(migrated, 'code.test.ts')), `Missing offline tests: ${chapter}`);
  for (const match of code.matchAll(/(?:from\s*['"]|import\(['"]|new URL\([`'"])(\.\.\/s\d+_[^`'"?]+)(?:[^`'"]*)/g)) {
    const allowed = chapter.startsWith('s15_') ? 's09_memory/' : chapter.startsWith('s16_') ? 's15_integrated_harness/' : null;
    assert.ok(allowed && match[1].startsWith('../' + allowed), `Unexpected chapter runtime import: ${chapter} -> ${match[1]}`);
  }
  assert.doesNotMatch(code, /(?:from\s*['"]|import\(['"])[^'"]*(?:test-helpers|\/scripts\/)/, `Runtime imports test helpers: ${chapter}`);
  assert.doesNotMatch(code, /\b(?:HookRuntime|SubagentRuntime|IntegratedRuntime|runCli)\b/, `Legacy shared runtime remains: ${chapter}`);
}
console.log(`${chapters.length} chapters, ${markdown} Markdown files, ${images} byte-identical images, ${links} valid local links`);

let resources = 0;
for (const name of files(join(reference, 'skills')).filter((name) => !name.includes('__pycache__') && !name.endsWith('.pyc'))) {
  const port = name.endsWith('.py') ? name.slice(0, -3) + '.ts' : name;
  assert.ok(existsSync(join(root, 'skills', port)), `Missing skill resource: ${port}`);
  if (!name.startsWith('agent-builder/')) assert.deepEqual(readFileSync(join(root, 'skills', port)), readFileSync(join(reference, 'skills', name)), `Skill knowledge changed: ${name}`);
  resources += 1;
}
console.log(`${resources} original skill resources retained or ported to TypeScript`);
