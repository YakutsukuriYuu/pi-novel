import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { KINDS, FOUNDING, AREAS } from '../src/kinds.ts';
import { NOVEL_TOOLS, readOnlyTools } from '../src/access.ts';
import { DEFAULT_CONFIG } from '../src/config.ts';

/**
 * README 与代码的一致性。
 *
 * 这条测试是有来历的：改造过程中命令从 23 个砍到 2 个、目录从英文换成中文、
 * 工具集换了两次，而 README 一直没人动 —— 它连着好几个提交都在教用户输入
 * 已经不存在的命令。文档漂移不会让测试变红，所以必须专门守一道。
 */
test('README 描述的命令与工具与代码一致', async () => {
  const readme = await fs.readFile(new URL('../README.md', import.meta.url), 'utf8');

  // 命令面：README 只能提到真实存在的命令。
  const mentioned = [...new Set([...readme.matchAll(/\/novel ([a-z]+)/g)].map((m) => m[1]!))];
  assert.ok(mentioned.length > 0, 'README 应当提到命令');
  assert.deepEqual(
    mentioned.filter((c) => !['init', 'close'].includes(c)),
    [],
    `README 提到了不存在的命令：${mentioned.join(', ')}`,
  );

  // 每个工具都要出现，否则用户不知道它存在。
  for (const name of NOVEL_TOOLS) assert.ok(readme.includes(name), `README 缺少工具 ${name}`);
  for (const name of readOnlyTools) assert.ok(readme.includes(name), `README 缺少放行的只读工具 ${name}`);

  // 被拦下的工具必须点名。
  for (const name of ['bash', 'edit', 'write', 'powershell', 'subagent', 'mcp', 'mcpScript']) {
    assert.ok(readme.includes(name), `README 应当点明拦下了 ${name}`);
  }

  // 立项五件套的路径
  for (const f of FOUNDING) assert.ok(readme.includes(f.path), `README 缺少立项文档路径 ${f.path}`);

  // 数量会随代码变化，README 里写死了就得跟着改
  assert.ok(readme.includes(`顶层 ${AREAS.size} 个目录`), `README 的顶层目录数应为 ${AREAS.size}`);
  assert.ok(readme.includes(`${KINDS.length} 种`), `README 的种类数应为 ${KINDS.length}`);

  // 配置键
  for (const key of Object.keys(DEFAULT_CONFIG)) assert.ok(readme.includes(key), `README 缺少配置键 ${key}`);

  // format 1 的英文目录不能残留
  assert.ok(
    !/\blore\/|\bsetting\/|\bchapters\/|CREATOR\.md|text\.md/.test(readme),
    'README 里还有旧版（format 1）的英文路径',
  );
});
