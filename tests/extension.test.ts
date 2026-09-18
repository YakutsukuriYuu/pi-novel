import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { DefaultResourceLoader, SettingsManager, type ExtensionContext } from '@earendil-works/pi-coding-agent';
import { initProject, Project } from '../src/project.ts';
import { allowedTool, output, NOVEL_TOOLS } from '../src/index.ts';

// Real Pi package/resource loading, real tool implementations; no network/model credentials.
test('Pi loads package and skill; the plan gate and the author gate both hold', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-novel-host-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const book = (await initProject(path.join(root, 'book'), '测试小说')).root;
  const agentDir = path.join(root, 'agent');
  await fs.mkdir(agentDir);
  const packageRoot = fileURLToPath(new URL('../', import.meta.url));
  const loader = new DefaultResourceLoader({ cwd: book, agentDir, settingsManager: SettingsManager.inMemory({ packages: [packageRoot] }), noContextFiles: true, noPromptTemplates: true, noThemes: true });
  await loader.reload();
  const result = loader.getExtensions();
  assert.deepEqual(result.errors, []);
  const extension = result.extensions.find(e => e.path.endsWith('src/index.ts'));
  assert.ok(extension, 'extension discovered via package manifest');

  // 只用到 cwd / hasUI / ui.confirm；其余成员在这条测试路径上不会被访问。
  // 构造一个完整的 ExtensionContext 需要整套会话服务，测试里不现实；
  // ui 按真实类型标注，使这个对象与 ExtensionContext 保有足够重叠，不需要双重断言。
  let confirmAnswer = true;
  const ui = {
    confirm: async () => confirmAnswer,
    setStatus: () => {},
    notify: () => {},
  } as unknown as ExtensionContext['ui'];
  const ctx = { cwd: book, hasUI: true, ui } as ExtensionContext;

  assert.deepEqual(loader.getSkills().skills, [], 'manifest must not expose the skill globally');
  const discover = extension.handlers.get('resources_discover') ?? [];
  const outside = await discover[0]?.({ type: 'resources_discover', cwd: agentDir, reason: 'startup' }, ctx);
  assert.equal(outside, undefined, 'no skill outside a project');
  const inside = await discover[0]?.({ type: 'resources_discover', cwd: book, reason: 'startup' }, ctx) as { skillPaths?: string[] } | undefined;
  assert.ok(inside?.skillPaths?.length, 'skill offered inside a project');
  loader.extendResources({ skillPaths: inside!.skillPaths!.map(p => ({ path: p, metadata: {} as never })) });
  assert.ok(loader.getSkills().skills.some(s => s.name === 'novel-manager'));
  for (const hook of extension.handlers.get('session_start') ?? []) await hook({ type: 'session_start', reason: 'startup' }, ctx);

  const tool = (name: string) => {
    const entry = extension.tools.get(name);
    assert.ok(entry, `tool ${name} registered`);
    return entry.definition;
  };
  const call = async (name: string, args: Record<string, unknown>) => {
    const result = await tool(name).execute('test', args, new AbortController().signal, undefined, ctx);
    const text = result.content.find(c => c.type === 'text');
    assert.ok(text && text.type === 'text');
    return text.text;
  };

  // 会弹确认框的工具**必须**串行执行。
  //
  // pi 默认把一条消息里的多个工具调用并行执行，而模型很自然地会想
  // 「一次确认立项五件套」—— 发 5 个 novel_authorize。若它们并行跑，
  // 5 个阻塞式确认框会让界面永久挂起，连一个 toolResult 都返回不了（真踩过）。
  // 只要同批里有一个标了 sequential，agent-loop 就会让整批串行。
  for (const name of ['novel_authorize', 'novel_adopt', 'novel_reorder', 'novel_recover']) {
    assert.equal(tool(name).executionMode, 'sequential', `${name} 必须串行，否则并发确认框会卡死界面`);
  }

  // 注册面与白名单必须完全对应。
  // 注册了却不在白名单里的工具会被**自己的守卫拦死** —— 表面上存在，实际永远调不通；
  // 白名单里却有不存在名字则是幻觉。两者都不会报错，只能靠这条断言守。
  assert.deepEqual([...extension.tools.keys()].sort(), [...NOVEL_TOOLS].sort(), '注册的工具必须与白名单完全一致');

  // 建章会同时生成 方案/正文 两份
  const chapter = JSON.parse(await call('novel_new_chapter', { title: '雨夜' })) as { id: string; path: string; folder: string };
  assert.equal(chapter.path, '章节/0001-雨夜/正文.md');
  const planPath = '章节/0001-雨夜/方案.md';
  // 章节目录里只应该有两份文档：方案 + 正文
  assert.deepEqual((await fs.readdir(path.join(book, '章节/0001-雨夜'))).sort(), ['方案.md', '正文.md']);

  // 方案未批准之前，正文必须写不进去
  const before = JSON.parse(await call('novel_read', { path: chapter.path }));
  await assert.rejects(
    call('novel_write', { path: chapter.path, expectedRevision: before.revision, body: '# 雨夜\n\n抢写。' }),
    /方案尚未被作者批准/,
  );

  const plan = JSON.parse(await call('novel_read', { path: planPath }));
  await call('novel_propose', { chapterId: chapter.id, expectedRevision: plan.revision, body: '本章目标：让林默发现钥匙是假的。' });

  // 作者在确认框上点「取消」→ 方案不该变成已批准
  confirmAnswer = false;
  const declined = await call('novel_authorize', { action: 'confirm', path: planPath });
  assert.match(declined, /取消/);
  assert.equal(JSON.parse(await call('novel_read', { path: planPath })).status, 'draft', '拒绝后状态必须不变');
  await assert.rejects(
    call('novel_write', { path: chapter.path, expectedRevision: before.revision, body: '# 雨夜\n\n还是不行。' }),
    /方案尚未被作者批准/,
  );

  // 作者点「确认」→ 方案批准，正文解锁
  confirmAnswer = true;
  await call('novel_authorize', { action: 'confirm', path: planPath });
  assert.equal(JSON.parse(await call('novel_read', { path: planPath })).status, 'confirmed');

  const read = JSON.parse(await call('novel_read', { path: chapter.path }));
  await call('novel_write', { path: chapter.path, expectedRevision: read.revision, body: '# 雨夜\n\n推门。\n\n走入雨中。' });

  // 分页与检索
  const page = JSON.parse(await call('novel_read', { path: chapter.path, offset: 1, limit: 2 }));
  assert.equal(page.nextOffset, 3);
  const next = JSON.parse(await call('novel_read', { path: chapter.path, offset: 3, limit: 200 }));
  assert.equal(next.nextOffset, null);
  assert.match(next.body, /推门/);
  const docs = JSON.parse(await call('novel_catalog', { limit: 1 }));
  assert.equal(docs.nextOffset, 1);
  assert.equal(JSON.parse(await call('novel_catalog', { offset: 1, limit: 100 })).nextOffset, null);
  assert.equal(JSON.parse(await call('novel_catalog', { query: '走入雨中' })).total, 1);

  // 采纳要作者点确认
  confirmAnswer = false;
  await call('novel_authorize', { action: 'accept', path: chapter.path });
  assert.equal(JSON.parse(await call('novel_read', { path: chapter.path })).status, 'draft', '拒绝后不得采纳');
  confirmAnswer = true;
  await call('novel_authorize', { action: 'accept', path: chapter.path });
  assert.equal(JSON.parse(await call('novel_read', { path: chapter.path })).status, 'accepted');

  // 已采纳的正文被保护
  const accepted = JSON.parse(await call('novel_read', { path: chapter.path }));
  await assert.rejects(call('novel_write', { path: chapter.path, expectedRevision: accepted.revision, body: 'overwrite' }), /受保护内容/);

  // 非交互模式下不能弹框，授权必须失败而不是静默通过
  const headless = { cwd: book, hasUI: false } as ExtensionContext;
  await assert.rejects(
    tool('novel_authorize').execute('test', { action: 'reopen', path: chapter.path }, new AbortController().signal, undefined, headless),
    /交互模式/,
  );

  // novel_check 汇总现状：立项进度、章节方案状态、未纳入管理的笔记
  await fs.writeFile(path.join(book, '随手记.md'), '还没纳入管理的笔记。\n');
  const status = JSON.parse(await call('novel_check', {}));
  assert.equal(status.founding.length, 5);
  assert.equal(status.founding[0].label, '文风');
  assert.equal(status.chapters[0].plan, 'approved');
  assert.deepEqual(status.unmanaged, ['随手记.md']);
  // 当前生效的安全边界要能自查，否则「以为加了工具其实没生效」很难查
  assert.equal(status.toolAccess.readOutsideProject, false);
  assert.ok(status.toolAccess.builtinReadonly.includes('ffgrep'));
  assert.deepEqual(status.toolAccess.extraAllowed, []);
  assert.equal(status.toolAccess.configProblem, null);

  // 历史可用于撤销
  assert.match(await call('novel_history', {}), /\.novel\/transactions\//);

  const guards = extension.handlers.get('tool_call') ?? [];
  for (const name of ['bash', 'write', 'edit', 'powershell', 'arbitrary_mcp', 'subagent']) {
    let blocked = false;
    for (const hook of guards) {
      const value = await hook({ type: 'tool_call', toolName: name, toolCallId: 'x', input: {} }, ctx) as { block?: boolean } | undefined;
      blocked ||= value?.block === true;
    }
    assert.ok(blocked, name);
  }

  // 只读边界要真的接在钩子上，不能只是 access.ts 里一个没人调的函数。
  const blockedRead = async (name: string, input: Record<string, unknown>): Promise<boolean> => {
    for (const hook of guards) {
      const value = await hook({ type: 'tool_call', toolName: name, toolCallId: 'x', input }, ctx) as { block?: boolean } | undefined;
      if (value?.block === true) return true;
    }
    return false;
  };
  assert.ok(await blockedRead('read', { path: '../别的书/人物/林默.md' }), '越界读必须被拦');
  assert.ok(await blockedRead('ffgrep', { path: '/etc', pattern: 'x' }), '绝对路径越界也要拦');
  assert.ok(!(await blockedRead('read', { path: '章节/0001-雨夜/正文.md' })), '项目内读应放行');
  assert.ok(!(await blockedRead('ffgrep', { path: '**/*.md', pattern: 'x' })), 'glob 不该误伤');
  assert.ok(!(await blockedRead('web_search', { query: 'x' })), '按 URL 的工具不做路径检查');
  // 新放行的只读工具确实进了白名单
  for (const name of ['ffgrep', 'fffind', 'web_search', 'web_fetch']) {
    assert.ok(!(await blockedRead(name, { path: '人物/林默.md', query: 'x' })), `${name} 应放行`);
  }

  assert.equal((await new Project(book).chapters()).length, 1);
});

test('会弹确认框的工具都标了串行执行，且白名单与 SKILL.md 一致', () => {
  assert.deepEqual([...NOVEL_TOOLS].sort(), [
    'novel_adopt', 'novel_authorize', 'novel_catalog', 'novel_check', 'novel_context',
    'novel_create', 'novel_export', 'novel_history', 'novel_new_chapter', 'novel_patch',
    'novel_propose', 'novel_read', 'novel_recover', 'novel_rename', 'novel_reorder',
    'novel_write',
  ]);

  for (const name of NOVEL_TOOLS) assert.ok(allowedTool(name), name);
  assert.ok(allowedTool('read'));
  assert.ok(!allowedTool('bash'), '模型不能直接改文件');
  assert.ok(!allowedTool('novel_fake'));

  const result = output('长文本'.repeat(30000)).content[0]!.text;
  assert.ok(Buffer.byteLength(result) < 41000);
  assert.match(result, /截断/);
});
