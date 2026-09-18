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
  const novel = await initProject(path.join(root, 'novel'), '探针');
  const code = path.join(root, 'code');
  await fs.mkdir(code);

  const prompts = new Map<string, string>();
  await fs.mkdir(path.join(novel, 'chapters'));
  for (const cwd of [code, novel, path.join(novel, 'chapters')]) {
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
      if (cwd === code) {
        assert.ok(!prompt.includes('novel-manager'), 'code session must not see the skill');
        assert.deepEqual(names, [], 'manifest must not declare skills globally');
      } else {
        assert.ok(prompt.includes('novel-manager'), `novel session must see the skill: ${cwd}`);
        assert.ok(names.includes('novel-manager'));
      }
    } finally {
      session.dispose();
    }
  }
  // Project-root discovery must reach the same result with or without a project-root cwd.
  assert.equal(prompts.get(novel)!.includes('novel-manager'), prompts.get(path.join(novel, 'chapters'))!.includes('novel-manager'));
});
