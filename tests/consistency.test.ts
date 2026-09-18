import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { KINDS, FOUNDING, AREAS } from '../src/kinds.ts';
import { NOVEL_TOOLS, readOnlyTools } from '../src/access.ts';
import { DEFAULT_CONFIG } from '../src/config.ts';
import { COMMANDS } from '../src/index.ts';

const root = fileURLToPath(new URL('../', import.meta.url));

async function collect(dir: string, filter: (name: string) => boolean): Promise<string[]> {
  const out: string[] = [];
  const walk = async (current: string, prefix: string): Promise<void> => {
    for (const entry of await fs.readdir(current, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue;
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) { if (rel !== 'node_modules') await walk(path.join(current, entry.name), rel); continue; }
      if (entry.isFile() && filter(rel)) out.push(rel);
    }
  };
  await walk(path.join(root, dir), dir);
  return out.sort();
}

/**
 * 全库一致性。
 *
 * 这条测试的来历：命令面从 23 个砍到 2 个之后，
 * README、docs/、Skill 参考，**以及代码里的报错信息**，
 * 都还在教用户跑 `recover`、`approve` 这些已经不存在的命令。
 *
 * 文档漂移不会让测试变红 —— 而报错信息指错方向比文档过期更难发现，
 * 因为它是运行到某一刻才冒出来的。所以这里把「代码 + 所有 Markdown」一起扫。
 */
test('所有地方引用的命令都真实存在', async () => {
  const allowed = new Set<string>(COMMANDS);
  const sources = [
    ...(await collect('src', (n) => n.endsWith('.ts'))),
    ...(await collect('docs', (n) => n.endsWith('.md'))),
    ...(await collect('skills', (n) => n.endsWith('.md'))),
    ...(await collect('templates', (n) => n.endsWith('.md'))),
    'README.md',
  ];

  const offenders: string[] = [];
  for (const rel of sources) {
    const text = await fs.readFile(path.join(root, rel), 'utf8');
    for (const match of text.matchAll(/\/novel ([a-z]+)/g)) {
      const name = match[1]!;
      if (!allowed.has(name)) offenders.push(`${rel}: /novel ${name}`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `以下位置引用了不存在的命令（真实命令只有 ${[...allowed].join(' / ')}）：\n${offenders.join('\n')}`,
  );
});

test('README 与代码一致', async () => {
  const readme = await fs.readFile(path.join(root, 'README.md'), 'utf8');

  for (const name of NOVEL_TOOLS) assert.ok(readme.includes(name), `README 缺少工具 ${name}`);
  for (const name of readOnlyTools) assert.ok(readme.includes(name), `README 缺少放行的只读工具 ${name}`);
  for (const name of ['bash', 'edit', 'write', 'powershell', 'subagent', 'mcp', 'mcpScript']) {
    assert.ok(readme.includes(name), `README 应当点明拦下了 ${name}`);
  }
  for (const f of FOUNDING) assert.ok(readme.includes(f.path), `README 缺少立项文档路径 ${f.path}`);
  for (const key of Object.keys(DEFAULT_CONFIG)) assert.ok(readme.includes(key), `README 缺少配置键 ${key}`);

  assert.ok(readme.includes(`顶层 ${AREAS.size} 个目录`), `README 的顶层目录数应为 ${AREAS.size}`);
  assert.ok(readme.includes(`${KINDS.length} 种`), `README 的种类数应为 ${KINDS.length}`);
});

test('文档里没有 format 1 的残留（旧英文目录、旧文件名）', async () => {
  const stale = /\blore\/|\bsetting\/|\bchapters\/|CREATOR\.md|text\.md|\bplan\.md/;
  const docs = [...(await collect('docs', (n) => n.endsWith('.md'))), 'README.md'];
  const offenders: string[] = [];
  for (const rel of docs) {
    const lines = (await fs.readFile(path.join(root, rel), 'utf8')).split('\n');
    lines.forEach((line, i) => { if (stale.test(line)) offenders.push(`${rel}:${i + 1}  ${line.trim().slice(0, 60)}`); });
  }
  assert.deepEqual(offenders, [], `旧版路径残留：\n${offenders.join('\n')}`);
});

test('文档里提到的工具名都真实存在', async () => {
  const known = new Set<string>([...NOVEL_TOOLS, ...readOnlyTools, 'bash', 'edit', 'write', 'powershell',
    'subagent', 'bg_wait', 'subagent_supervisor', 'mcp', 'mcpScript', 'ast_grep_replace',
    'pi_lens_activate_tools', 'lsp_navigation', 'ask_question']);
  const docs = [...(await collect('docs', (n) => n.endsWith('.md'))), 'README.md'];
  const offenders: string[] = [];
  for (const rel of docs) {
    const text = await fs.readFile(path.join(root, rel), 'utf8');
    // 只检查反引号里的 novel_* 名字，避免把普通名词当成工具
    for (const match of text.matchAll(/`(novel_[a-z_]+)`/g)) {
      const name = match[1]!;
      if (!known.has(name)) offenders.push(`${rel}: ${name}`);
    }
  }
  assert.deepEqual(offenders, [], `文档提到了不存在的工具：\n${offenders.join('\n')}`);
});
