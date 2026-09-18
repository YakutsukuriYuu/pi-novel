import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
} from '@earendil-works/pi-coding-agent';
import { initProject } from '../src/project.ts';

// Verifies the real loaded system prompt, so conditional skill injection is proven end to end:
// no model request is made; only session construction and prompt assembly.
test('novel-manager is absent outside a project and present inside one', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-novel-prompt-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const agentDir = path.join(root, 'agent');
  await fs.mkdir(agentDir);
  const novel = (await initProject(path.join(root, 'novel'), '探针')).root;
  const code = path.join(root, 'code');
  await fs.mkdir(code);

  const prompts = new Map<string, string>();
  const chapterDir = path.join(novel, '章节');
  await fs.mkdir(chapterDir);
  // 第三个用例是关键：小说的子目录**不算**小说根，所以不注入 skill。
  // 「一个目录就是一本书」—— 子目录不能隷隷继承父目录的激活状态。
  const cases: [string, string, boolean][] = [
    ['代码目录', code, false],
    ['小说根', novel, true],
    ['小说的子目录', chapterDir, false],
  ];
  for (const [label, cwd, expectSkill] of cases) {
    const loader = new DefaultResourceLoader({
      cwd,
      agentDir,
      settingsManager: SettingsManager.inMemory({ packages: [fileURLToPath(new URL('../', import.meta.url))] }),
      noContextFiles: true,
      noPromptTemplates: true,
      noThemes: true,
    });
    await loader.reload();
    const { session } = await createAgentSession({
      cwd,
      agentDir,
      resourceLoader: loader,
      sessionManager: SessionManager.inMemory(cwd),
    });
    // Extensions are loaded by the loader but only bound here; bindExtensions is what emits
    // session_start and resources_discover, which is where conditional skill injection happens.
    await session.bindExtensions({});
    try {
      const prompt = session.agent.state.systemPrompt ?? '';
      prompts.set(cwd, prompt);
      const names = loader.getSkills().skills.map(s => s.name);
      assert.equal(prompt.includes('novel-manager'), expectSkill, `${label} 是否应注入 skill`);
      if (expectSkill) assert.ok(names.includes('novel-manager'));
      else assert.ok(!names.includes('novel-manager'), `${label} 不应拿到 skill`);
      if (cwd === code) assert.deepEqual(names, [], 'manifest must not declare skills globally');
    } finally {
      session.dispose();
    }
  }
  assert.ok(prompts.get(novel)!.includes('novel-manager'));
  assert.ok(!prompts.get(chapterDir)!.includes('novel-manager'), '开在小说子目录里不会激活小说模式');
});

test('corrupted project: fail-closed without injecting the skill', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-novel-broken-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const agentDir = path.join(root, 'agent');
  await fs.mkdir(agentDir);
  const broken = path.join(root, 'broken');
  await fs.mkdir(path.join(broken, '.novel'), { recursive: true });
  await fs.writeFile(path.join(broken, '.novel', 'project.md'), 'not a valid project file\n');

  const loader = new DefaultResourceLoader({
    cwd: broken,
    agentDir,
    settingsManager: SettingsManager.inMemory({ packages: [fileURLToPath(new URL('../', import.meta.url))] }),
    noContextFiles: true, noPromptTemplates: true, noThemes: true,
  });
  await loader.reload();
  const ext = loader.getExtensions().extensions.find(e => e.path.endsWith('src/index.ts'))!;
  const ctx = { cwd: broken, hasUI: false } as never;
  // 项目损坏不该让会话起不来，但绝不能因此放行任意写入：fail-closed。
  await Promise.all((ext.handlers.get('session_start') ?? []).map(h => h({ type: 'session_start', reason: 'startup' }, ctx)));
  const offered = await ext.handlers.get('resources_discover')?.[0]?.({ type: 'resources_discover', cwd: broken, reason: 'startup' }, ctx) as { skillPaths?: string[] } | undefined;
  assert.ok(!offered?.skillPaths?.length, 'broken project must not expose the skill');
  // Fail-closed: activation marker present, so built-in writes stay blocked despite the error.
  const blocked = await Promise.all((ext.handlers.get('tool_call') ?? []).map(h => h({ type: 'tool_call', toolName: 'bash', toolCallId: 'x', input: {} }, ctx)));
  assert.ok(blocked.some(r => (r as { block?: boolean } | undefined)?.block === true), 'writes stay blocked in a corrupted project');
  // 并且模型要被明确告知项目有问题，才能转告作者怎么修。
  const started = await ext.handlers.get('before_agent_start')?.[0]?.({ type: 'before_agent_start', systemPrompt: 'BASE' }, ctx) as { systemPrompt?: string } | undefined;
  assert.match(started?.systemPrompt ?? '', /not usable/);
  assert.match(started?.systemPrompt ?? '', /novel migrate/);
});
