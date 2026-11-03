import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SkillLoader, SKILL_LOADER, TOOLS, build_system_prompt } from './code.js';
import { workspace } from '../s04_hooks/test-helpers.js';

test('frontmatter supports folded descriptions and preserves body', () => {
  const [meta, body] = SkillLoader.parse_frontmatter('---\nname: review\ndescription: >\n  first\n  second\n---\n# Body');
  assert.match(String(meta.description), /first second/); assert.equal(body, '# Body');
});
test('invalid metadata does not discard the skill body', () => {
  assert.deepEqual(SkillLoader.parse_frontmatter('---\nname: [\n---\n# Body'), [{}, '# Body']);
  assert.deepEqual(SkillLoader.parse_frontmatter('# Plain'), [{}, '# Plain']);
});
test('catalog is thin; load returns full original content', (context) => {
  const directory = workspace(context); mkdirSync(join(directory, 'review'));
  writeFileSync(join(directory, 'review/SKILL.md'), '---\nname: review\ndescription: Review code\n---\nSECRET-BODY');
  const loader = new SkillLoader(directory);
  assert.doesNotMatch(loader.catalog(), /SECRET-BODY/); assert.match(loader.load('review'), /SECRET-BODY/);
  assert.match(loader.load('missing'), /Unknown skill/);
});
test('skills outside catalog root are not followed', (context) => {
  const directory = workspace(context); const outside = workspace(context);
  writeFileSync(join(outside, 'SKILL.md'), '# Outside'); symlinkSync(outside, join(directory, 'escape'));
  assert.equal(new SkillLoader(directory).skills.size, 0);
});
test('chapter exposes exactly base tools and load_skill, with a thin startup prompt', () => {
  assert.deepEqual(TOOLS.map((tool) => tool.name), ['bash', 'read_file', 'write_file', 'edit_file', 'glob', 'load_skill']);
  const system = build_system_prompt();
  assert.match(system, /Skills available:/);
  assert.match(system, /Use load_skill/);
  assert.ok(system.includes(SKILL_LOADER.catalog()));
});
test('only standalone delimiter lines close frontmatter', () => {
  const text = '---\nname: demo\ndescription: |\n  before\n  ---\n  after\n---\n# Body';
  for (const candidate of [text, text.replaceAll('\n', '\r\n')]) {
    assert.deepEqual(SkillLoader.parse_frontmatter(candidate), [{ name: 'demo', description: 'before\n---\nafter\n' }, '# Body']);
  }
  assert.deepEqual(SkillLoader.parse_frontmatter('---not metadata\n---\nBody'), [{}, '---not metadata\n---\nBody']);
});

test('frontmatter edge cases and tool schemas match Python', async (context) => {
  const { pythonReference } = await import('../scripts/parity-helpers.js');
  const directory = workspace(context);
  const scalars = ['y', 'n', 'yes', 'On', '01', '08', '1e2', '1e+2', '1.0e2', '1.0e+2', '12:30'];
  const texts = [...scalars.map((value) => `---\nname: ${value}\ndescription: ${value}\n---\nBody`), '---\nname: first\nname: last\n---\nBody', '---\rname: demo\r---\rBody', '---\nname:\n---\n', '---\n[]\n---\nBody', '---\nname: [\n---\nBody', '---not-frontmatter\n---\nBody'];
  assert.deepEqual(texts.map((text) => SkillLoader.parse_frontmatter(text)), pythonReference('s07_skill_loading', directory, { scenario: 'frontmatter', texts }).result);
  assert.deepEqual({ TOOLS }, pythonReference('s07_skill_loading', directory, {}).result);
});
