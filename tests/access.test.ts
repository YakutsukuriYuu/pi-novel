import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { NOVEL_TOOLS, READ_PATH_TOOLS, allowedTool, escapesProject, pathArgument, readOnlyTools } from '../src/access.ts';
import { DEFAULT_CONFIG, loadConfig } from '../src/config.ts';

test('白名单默认拒绝：只读与 novel_* 放行，能写的一律拦下', () => {
  for (const name of readOnlyTools) assert.ok(allowedTool(name), name);
  for (const name of NOVEL_TOOLS) assert.ok(allowedTool(name), name);

  for (const name of ['bash', 'edit', 'write', 'powershell']) {
    assert.ok(!allowedTool(name), `${name} 必须被拦`);
  }
  // 这三个是实测出来的「朴素黑名单会漏掉」的口子，必须逐个锁住：
  // subagent 派出的子代理自带 bash/edit/write；ast_grep_replace 能改文件但名字看不出来；
  // pi_lens_activate_tools 一句话就能把后者激活。
  assert.ok(!allowedTool('subagent'), 'subagent 会带写工具的子代理回来');
  assert.ok(!allowedTool('ast_grep_replace'), '能改文件，名字里却没有 write/edit');
  assert.ok(!allowedTool('pi_lens_activate_tools'), '能激活上面那个');
  assert.ok(!allowedTool('mcp'), 'MCP 服务器可以暴露任意工具');
  // 默认拒绝的要害：以后装了新扩展带来新工具，它自动被拦，而不是自动被放行。
  assert.ok(!allowedTool('某个还没出现的扩展工具'));
});

test('新放行的四个都是只读工具', () => {
  for (const name of ['ffgrep', 'fffind', 'web_search', 'web_fetch']) {
    assert.ok(allowedTool(name), name);
  }
});

test('配置只能追加，不能缩减内置白名单', () => {
  assert.ok(allowedTool('lsp_navigation', ['lsp_navigation']));
  assert.ok(!allowedTool('lsp_navigation'), '没配置时不放行');

  assert.ok(allowedTool('read', []), '空配置下内置白名单照旧');
  assert.ok(allowedTool('read', ['bash']), '配置挡不住内置放行的');
  assert.ok(!allowedTool('bash', ['read']), '配置也放不出内置拦截的（除非显式写进去）');
  assert.ok(allowedTool('bash', ['bash']), '作者显式加就加 —— 那是他的凭据');
});

test('只读边界：项目内放行，项目外拦下', async t => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-novel-access-'));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const root = path.join(base, 'B');
  await fs.mkdir(path.join(root, '人物'), { recursive: true });
  await fs.mkdir(path.join(base, 'C'), { recursive: true });

  for (const ok of ['人物/林默.md', '.', '**/*.md', './人物/林默.md', path.join(root, '人物/林默.md')]) {
    assert.equal(await escapesProject(root, ok), false, `应放行：${ok}`);
  }
  for (const bad of ['../C/人物/别人.md', '..', '../', '../../etc/passwd', path.join(base, 'C/x.md'), '~/x.md']) {
    assert.equal(await escapesProject(root, bad), true, `应拦下：${bad}`);
  }
});

test('只读边界能看穿指向外部的符号链接', async t => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-novel-link-'));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const root = path.join(base, 'B');
  const outside = path.join(base, 'C');
  await fs.mkdir(root, { recursive: true });
  await fs.mkdir(outside, { recursive: true });
  await fs.writeFile(path.join(outside, '别人.md'), '不该看到');
  await fs.symlink(outside, path.join(root, '外链'));

  // 词法上在项目内，真实路径却在外 —— 这正是需要 realpath 那一层的原因
  assert.equal(await escapesProject(root, '外链/别人.md'), true);
});

test('pathArgument 只认 path 参数', () => {
  assert.equal(pathArgument({ path: '人物/林默.md' }), '人物/林默.md');
  assert.equal(pathArgument({ pattern: 'x', path: 'y' }), 'y');
  assert.equal(pathArgument({ pattern: 'x' }), null);
  assert.equal(pathArgument({ path: '' }), null);
  assert.equal(pathArgument(undefined), null);
  assert.equal(pathArgument('nope'), null);
  assert.equal(pathArgument({ path: 42 }), null);
});

test('需要做边界检查的工具正是那些带 path 的', () => {
  for (const name of ['read', 'grep', 'find', 'ls', 'ffgrep', 'fffind']) {
    assert.ok(READ_PATH_TOOLS.has(name), name);
  }
  // 这两个按 URL 工作，不该被路径检查误伤
  assert.ok(!READ_PATH_TOOLS.has('web_search'));
  assert.ok(!READ_PATH_TOOLS.has('web_fetch'));
});

test('配置文件：缺失用默认值；坏掉也用默认值，但必须报出来', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-novel-cfg-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));

  const missing = await loadConfig(path.join(dir, '不存在.json'));
  assert.deepEqual(missing.config, DEFAULT_CONFIG);
  assert.equal(missing.problem, null, '文件不存在不算问题');

  const good = path.join(dir, 'good.json');
  await fs.writeFile(good, JSON.stringify({ additionalAllowedTools: ['lsp_navigation'], allowReadOutsideProject: true }));
  const loaded = await loadConfig(good);
  assert.deepEqual(loaded.config.additionalAllowedTools, ['lsp_navigation']);
  assert.equal(loaded.config.allowReadOutsideProject, true);
  assert.equal(loaded.problem, null);

  const bad = path.join(dir, 'bad.json');
  await fs.writeFile(bad, '{ 不是 json');
  const broken = await loadConfig(bad);
  assert.deepEqual(broken.config, DEFAULT_CONFIG);
  assert.match(broken.problem ?? '', /JSON/);

  const wrong = path.join(dir, 'wrong.json');
  await fs.writeFile(wrong, JSON.stringify({ additionalAllowedTools: 'not-an-array', allowReadOutsideProject: 'yes' }));
  const mistyped = await loadConfig(wrong);
  assert.deepEqual(mistyped.config, DEFAULT_CONFIG);
  assert.match(mistyped.problem ?? '', /additionalAllowedTools/);
  assert.match(mistyped.problem ?? '', /allowReadOutsideProject/);

  // 数组里混进坏项：好的留下，坏的报出来 —— 静默丢弃比报错更难查
  const mixed = path.join(dir, 'mixed.json');
  await fs.writeFile(mixed, JSON.stringify({ additionalAllowedTools: ['ok', 42, '', '  trimmed  '] }));
  const partial = await loadConfig(mixed);
  assert.deepEqual(partial.config.additionalAllowedTools, ['ok', 'trimmed']);
  assert.match(partial.problem ?? '', /不是非空字符串/);
});
