import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { DefaultResourceLoader, SettingsManager, type ExtensionContext } from '@earendil-works/pi-coding-agent';
import { initProject, Project } from '../src/project.ts';
import { allowedTool, output } from '../src/index.ts';

// Real Pi package/resource loading, real tool implementations; no network/model credentials.
test('Pi loads package and skill, tools run, hooks protect writes and survive startup', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-novel-host-'));
  t.after(() => fs.rm(root, {recursive:true, force:true}));
  const book = await initProject(path.join(root, 'book'), '测试小说');
  const agentDir = path.join(root, 'agent'); await fs.mkdir(agentDir);
  const packageRoot = fileURLToPath(new URL('../', import.meta.url));
  const loader = new DefaultResourceLoader({ cwd: book, agentDir, settingsManager: SettingsManager.inMemory({ packages: [packageRoot] }), noContextFiles: true, noPromptTemplates: true, noThemes: true });
  await loader.reload();
  const result = loader.getExtensions();
  assert.deepEqual(result.errors, []);
  const extension = result.extensions.find(e => e.path.endsWith('src/index.ts'));
  assert.ok(extension, 'extension discovered via package manifest');
  assert.ok(loader.getSkills().skills.some(s => s.name === 'novel-manager'));
  const ctx = { cwd: book, hasUI: false } as ExtensionContext;
  for (const hook of extension.handlers.get('session_start') ?? []) await hook({type:'session_start', reason:'startup'}, ctx);
  const tool = (name: string) => {
    const entry = extension.tools.get(name); assert.ok(entry); return entry.definition;
  };
  const call = async (name: string, args: Record<string, unknown>) => {
    const result = await tool(name).execute('test', args, new AbortController().signal, undefined, ctx);
    const text = result.content.find(c => c.type === 'text'); assert.ok(text && text.type === 'text'); return text.text;
  };
  const chapter = JSON.parse(await call('novel_create', {kind:'chapter',title:'雨夜'}));
  const read = JSON.parse(await call('novel_read', {path:chapter.path}));
  await call('novel_write', {path:chapter.path,expectedRevision:read.revision,body:'# 雨夜\n\n推门。\n\n走入雨中。'});
  const page = JSON.parse(await call('novel_read', {path:chapter.path,offset:1,limit:2}));
  assert.equal(page.nextOffset, 3);
  const next = JSON.parse(await call('novel_read', {path:chapter.path,offset:3,limit:200}));
  assert.equal(next.nextOffset, null); assert.match(next.body, /推门/);
  const docs = JSON.parse(await call('novel_catalog', {limit:1})); assert.equal(docs.nextOffset, 1);
  const more = JSON.parse(await call('novel_catalog', {offset:1,limit:100})); assert.equal(more.nextOffset, null);
  const search = JSON.parse(await call('novel_catalog', {query:'走入雨中'})); assert.equal(search.total, 1);
  await assert.rejects(call('novel_write', {path:chapter.path,expectedRevision:read.revision,body:'stale'}), /Revision conflict/);
  const guards = extension.handlers.get('tool_call') ?? [];
  for (const name of ['bash','write','edit','powershell','arbitrary_mcp','subagent']) {
    let blocked = false;
    for (const hook of guards) {
      const value = await hook({type:'tool_call',toolName:name,toolCallId:'x',input:{}}, ctx) as {block?:boolean} | undefined;
      blocked ||= value?.block === true;
    }
    assert.ok(blocked, name);
  }
  assert.equal((await new Project(book).chapters()).length, 1);
});

test('guard allows only known safe tools; output is explicitly bounded', () => {
  assert.ok(allowedTool('novel_patch')); assert.ok(allowedTool('read'));
  assert.ok(!allowedTool('novel_fake')); assert.ok(!allowedTool('bash'));
  const result = output('长文本'.repeat(30000)).content[0].text;
  assert.ok(Buffer.byteLength(result) < 41000); assert.match(result, /截断/);
});
