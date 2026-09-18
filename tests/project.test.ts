import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Project, initProject, kinds } from '../src/project.ts';
import { discover, safePath, locked, rollback, commit, pending, readOptional, transactionFiles } from '../src/storage.ts';
import { decode, encode, hash } from '../src/markdown.ts';

async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-novel-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return new Project(await initProject(dir, '雨城'));
}
async function written(p: Project, title = '雨夜') {
  const c = await p.newChapter(title);
  const doc = await p.read(c.path);
  await p.write(c.path, doc.revision, '# 雨夜\n\n林默推开门。他尚不知道钥匙的来历。');
  const final = await p.read(c.path);
  await p.summary(c.id, '# 摘要\n\n林默推门，尚不知道钥匙来源。', final.revision);
  return { ...c, doc: await p.read(c.path) };
}

test('initialization is Markdown only, discoverable from descendants, non-destructive', async t => {
  const p = await fixture(t);
  await p.validate();
  assert.equal(await discover(path.join(p.root, 'setting')), p.root);
  assert.equal((await p.documents()).length, 5);
  await assert.rejects(initProject(p.root, '覆盖'), /empty directory/);
  const walk = async (dir: string): Promise<void> => {
    for (const e of await fs.readdir(dir, { withFileTypes: true })) {
      if (e.isDirectory()) await walk(path.join(dir, e.name)); else assert.ok(e.name.endsWith('.md'));
    }
  };
  await walk(p.root);
});

test('all domain types have templates; derived records require fresh sources', async t => {
  const p = await fixture(t); const chapter = await written(p);
  const person = await p.create('character', '林默');
  const personId = (await p.read(person.path)).meta.id;
  for (const kind of Object.keys(kinds)) {
    const made = await p.create(kind, `中文 ${kind}`, [personId], [{ path: chapter.path, revision: chapter.doc.revision }]);
    const d = await p.read(made.path);
    assert.equal(d.meta.kind, kind); assert.ok(d.body.includes('中文'));
  }
  await assert.rejects(p.create('state', '无来源'), /require source/);
  await assert.rejects(p.create('item', '坏引用', ['unknown']), /Unknown reference/);
  await assert.rejects(p.create('review', '旧来源', [], [{ path: chapter.path, revision: '0'.repeat(64) }]), /Stale source/);
});

test('optimistic writes preserve metadata and reject stale revisions', async t => {
  const p = await fixture(t); const c = await p.newChapter('第一章'); const d = await p.read(c.path);
  await p.write(c.path, d.revision, '# 第一章\n\n正文。');
  await assert.rejects(p.write(c.path, d.revision, 'lost update'), /Revision conflict/);
  assert.equal((await p.read(c.path)).meta.id, d.meta.id);
  assert.equal((await p.read(c.path)).meta.status, 'draft');
});

test('local patches are exact, unique, non-overlapping and revision checked', async t => {
  const p = await fixture(t); const c = await written(p); const d = await p.read(c.path);
  await p.patch(c.path, d.revision, [{ oldText: '推开门', newText: '关上门' }]);
  const changed = await p.read(c.path); assert.match(changed.body, /关上门/);
  await assert.rejects(p.patch(c.path, d.revision, [{ oldText: '林默', newText: 'A' }]), /conflict/);
  await assert.rejects(p.patch(c.path, changed.revision, [{ oldText: '不存在', newText: 'A' }]), /exactly once/);
  await assert.rejects(p.patch(c.path, changed.revision, [{ oldText: '林默关上门', newText: 'A' }, { oldText: '关上门', newText: 'B' }]), /overlapping/);
});

test('acceptance requires prose and a current summary, protects text, and rebinds sources', async t => {
  const p = await fixture(t); const empty = await p.newChapter('空章');
  await assert.rejects(p.transition(empty.path, 'accept', (await p.read(empty.path)).revision), /empty prose/);
  const c = await written(p);
  await p.transition(c.path, 'accept', c.doc.revision);
  let d = await p.read(c.path); assert.equal(d.meta.status, 'accepted');
  await assert.rejects(p.write(c.path, d.revision, 'overwrite'), /Protected/);
  assert.ok(!(await p.diagnostics()).some(x => x.includes('Stale')));
  await p.transition(c.path, 'publish', d.revision);
  d = await p.read(c.path); assert.equal(d.meta.status, 'published');
  await p.transition(c.path, 'reopen', d.revision);
  d = await p.read(c.path); await p.write(c.path, d.revision, d.body + '\n\n新的事件。');
  await assert.rejects(p.transition(c.path, 'accept', (await p.read(c.path)).revision), /Fresh chapter summary/);
});

test('confirmed lore cannot be silently overwritten', async t => {
  const p = await fixture(t); const c = await p.create('character', '林默');
  const d = await p.read(c.path);
  await p.transition(c.path, 'confirm', d.revision);
  const canon = await p.read(c.path);
  await assert.rejects(p.write(c.path, canon.revision, '改设定'), /Protected/);
  await assert.rejects(p.transition(c.path, 'reopen', d.revision), /changed/);
});

test('context does not leak future or stale state and distinguishes draft predecessors', async t => {
  const p = await fixture(t); const first = await written(p, '一');
  await p.transition(first.path, 'accept', first.doc.revision);
  const now = await p.newChapter('二'); const future = await written(p, '三');
  const a = await p.create('state', '过去', [], await p.sources([first.path]));
  const b = await p.create('state', '未来', [], await p.sources([future.path]));
  const context = await p.context(now.id);
  assert.ok(context.includes(a.path)); assert.ok(!context.includes(b.path));
  const d = await p.read(first.path);
  await p.transition(first.path, 'reopen', d.revision);
  const draftContext = await p.context(now.id);
  assert.ok(!draftContext.includes(a.path)); assert.ok(draftContext.includes('[draft]'));
});

test('external changes invalidate sources; IDs survive reorder; export is Markdown and canonical only', async t => {
  const p = await fixture(t); const a = await written(p, '一'); const b = await written(p, '二');
  await p.transition(a.path, 'accept', a.doc.revision);
  const exported = await p.exportBook(); const snapshot = await p.read(exported.path);
  assert.equal(snapshot.meta.sources?.length, 1);
  await assert.rejects(p.write(exported.path, snapshot.revision, '覆盖快照'), /Protected/);
  await p.reorder([b.id, a.id]);
  assert.equal((await p.chapters())[0].meta.id, b.id);
  const aAfter = await p.chapter(a.id);
  assert.match(aAfter.path, /0002-一\/text\.md$/, 'reorder renames folders to readable NNNN-title');
  assert.ok(!(await p.diagnostics()).some(x => x.includes('Stale')), 'reorder rebinds sources to moved paths');
  await fs.appendFile(path.join(p.root, aAfter.path), '\n外部编辑。\n');
  assert.ok((await p.diagnostics()).some(x => x.includes('Stale')));
  await assert.rejects(p.exportBook(), /Stale chapter summary|changed externally/);
});

test('rollback restores exact content and refuses to clobber newer author edits', async t => {
  const p = await fixture(t); const c = await p.newChapter('一'); const original = await p.read(c.path);
  const tx = await p.write(c.path, original.revision, '修改内容');
  await locked(p.root, () => rollback(p.root, tx));
  assert.equal((await p.read(c.path)).raw, original.raw);
  const tx2 = await p.write(c.path, original.revision, '修改内容2');
  await fs.appendFile(path.join(p.root, c.path), '\n作者新增');
  await assert.rejects(locked(p.root, () => rollback(p.root, tx2)), /Recovery conflict/);
  assert.match((await p.read(c.path)).body, /作者新增/);
});

test('interrupted multi-file transaction blocks writes and recovery rolls back partial apply', async t => {
  const p = await fixture(t); const c = await written(p); const d = await p.read(c.path);
  const id = '12345678-11111111-1111-1111-1111-111111111111';
  const changes = [
    { path: c.path, before: d.raw, after: encode(d.meta, '部分写入') },
    { path: 'workspace/ideas/interrupted.md', before: null, after: encode({ id:'idea-x',kind:'idea',title:'x',status:'draft' }, '尚未写入') },
  ];
  await fs.writeFile(path.join(p.root, `.novel/pending/${id}.md`), encode({ id,kind:'transaction',title:'interrupted',status:'pending',changes }, '# Pending'));
  await fs.writeFile(path.join(p.root, c.path), changes[0].after!);
  assert.equal((await pending(p.root)).length, 1);
  await assert.rejects(p.newChapter('blocked'), /Unfinished transaction/);
  await locked(p.root, () => rollback(p.root, id));
  assert.equal((await p.read(c.path)).raw, d.raw);
  assert.equal(await readOptional(p.root, changes[1].path), null);
  assert.equal((await pending(p.root)).length, 0);
});

test('cross-process lock is fail-closed and released on exceptions', async t => {
  const p = await fixture(t);
  await locked(p.root, async () => { await assert.rejects(locked(p.root, async () => {}), /locked/); });
  await assert.rejects(locked(p.root, async () => { throw new Error('failure'); }), /failure/);
  await locked(p.root, async () => {});
});

test('unsafe paths, symbolic links and hard links are rejected', async t => {
  const p = await fixture(t);
  for (const name of ['../escape.md','/tmp/escape.md','lore/../escape.md','lore\\escape.md','lore/CON.md','lore/a:bad.md']) await assert.rejects(safePath(p.root, name), /Unsafe/);
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-outside-'));
  t.after(() => fs.rm(outside, { recursive:true, force:true }));
  await fs.mkdir(path.join(p.root, 'lore'));
  await fs.symlink(outside, path.join(p.root, 'lore', 'escape'));
  await assert.rejects(safePath(p.root, 'lore/escape/file.md'), /Unsupported/);
  await fs.link(path.join(p.root, 'CREATOR.md'), path.join(p.root, 'linked.md'));
  await assert.rejects(safePath(p.root, 'linked.md'), /Unsupported/);
});

test('transaction preflight never writes if any expected snapshot conflicts', async t => {
  const p = await fixture(t); const d = await p.read('CREATOR.md'); const beforeCount = (await transactionFiles(p.root)).length;
  await assert.rejects(locked(p.root, () => commit(p.root, [
    { path: 'CREATOR.md', before: d.raw, after: encode(d.meta, 'new') },
    { path: 'setting/world.md', before: 'wrong', after: 'bad' },
  ], 'conflict')), /Revision conflict/);
  assert.equal((await p.read('CREATOR.md')).revision, d.revision);
  assert.equal((await transactionFiles(p.root)).length, beforeCount);
});

test('Markdown parser preserves arbitrary prose and rejects malformed schema', () => {
  const body = '# 标题\n\n---\n\n```yaml\nkey: value\n```\n\n中文正文。';
  const text = encode({id:'x',kind:'idea',title:'中文: 标题',status:'draft'}, body);
  assert.equal(decode(text).body, body); assert.equal(hash(text).length, 64);
  assert.throws(() => decode('not frontmatter'), /Missing/);
  assert.throws(() => decode('---\nid: a\nid: b\n---\nbody'), /unique/);
  assert.throws(() => decode(encode({id:'x',kind:'x',title:'x',status:'draft',sources:[{path:'x',revision:'bad'}]}, 'body')), /sources/);
});

test('title changes preserve stable paths, ID and prose', async t => {
  const p = await fixture(t); const c = await written(p); const before = await p.read(c.path);
  await p.rename(c.path, '新的标题', before.revision);
  const after = await p.read(c.path);
  assert.equal(after.meta.title, '新的标题'); assert.equal(after.meta.id, before.meta.id); assert.equal(after.body, before.body);
});

test('summary updates require the current summary revision, not just the chapter revision', async t => {
  const p = await fixture(t); const c = await written(p);
  const summaryPath = c.path.replace(/text\.md$/, 'summary.md');
  const old = await p.read(summaryPath);
  await assert.rejects(p.summary(c.id, '覆盖作者摘要', c.doc.revision), /Summary revision conflict/);
  await p.summary(c.id, '# 摘要\n\n新版事实。', c.doc.revision, old.revision);
  await assert.rejects(p.summary(c.id, '再覆盖', c.doc.revision, old.revision), /Summary revision conflict/);
});

test('external edits to accepted prose require reacceptance even after summary refresh', async t => {
  const p = await fixture(t); const c = await written(p);
  await p.transition(c.path, 'accept', c.doc.revision);
  await fs.appendFile(path.join(p.root, c.path), '\n\n作者改了情节。\n');
  const altered = await p.read(c.path); const summary = await p.read(c.path.replace(/text\.md$/, 'summary.md'));
  await p.summary(c.id, '# 摘要\n\n包括作者修改。', altered.revision, summary.revision);
  assert.ok((await p.diagnostics()).some(s => s.includes('Protected content changed externally')));
  await assert.rejects(p.exportBook(), /changed externally/);
  await assert.rejects(p.transition(c.path, 'publish', altered.revision), /changed externally/);
});

test('concurrent writes based on same revision cannot both succeed', async t => {
  const p = await fixture(t); const c = await written(p);
  const results = await Promise.allSettled([
    p.write(c.path, c.doc.revision, 'version A'),
    p.write(c.path, c.doc.revision, 'version B'),
  ]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.ok(['version A', 'version B'].includes((await p.read(c.path)).body));
});

test('malicious recovery journal cannot restore outside the managed root', async t => {
  const p = await fixture(t); await written(p);
  const id = '98765432-11111111-1111-1111-1111-111111111111';
  await fs.writeFile(path.join(p.root, `.novel/pending/${id}.md`), encode({ id, kind:'transaction',title:'unsafe',status:'pending',changes:[{path:'../outside.md',before:'bad',after:null}] }, 'bad'));
  await assert.rejects(locked(p.root, () => rollback(p.root, id)), /Invalid transaction target/);
});

test('orphan atomic temporary files are not interpreted as transactions or content', async t => {
  const p = await fixture(t); await written(p);
  await fs.writeFile(path.join(p.root, '.novel/transactions/.unfinished.md'), 'partial YAML');
  assert.equal((await pending(p.root)).length, 0);
  await p.newChapter('恢复后');
});

test('filenames are human-readable titles with dedup and cross-platform sanitizing', async t => {
  const p = await fixture(t);
  const a = await p.create('character', '林默');
  assert.equal(a.path, 'lore/characters/林默.md');
  const b = await p.create('character', '林默');
  assert.equal(b.path, 'lore/characters/林默-2.md', 'duplicate titles get a numeric suffix');
  const c = await p.create('character', '林 默: <秘密>?');
  assert.match(c.path, /^lore\/characters\/林-默.*\.md$/);
  await p.read(c.path);
  const reserved = await p.create('character', 'CON');
  assert.ok(!/^lore\/characters\/con\.md$/i.test(reserved.path), 'Windows reserved names must not be used verbatim');
  const chapter = await p.newChapter('第一章 雨夜');
  assert.equal(chapter.path, 'chapters/0001-第一章-雨夜/text.md');
  await assert.rejects(p.read('lore/characters/林默 .md'), /Not found/);
});

test('reorder migrates chapter folders to readable names and keeps summaries valid', async t => {
  const p = await fixture(t);
  const a = await written(p, '雨夜'); const b = await written(p, '天明');
  await p.transition(a.path, 'accept', a.doc.revision);
  await p.reorder([b.id, a.id]);
  const aNow = await p.chapter(a.id); const bNow = await p.chapter(b.id);
  assert.equal(aNow.path, 'chapters/0002-雨夜/text.md');
  assert.equal(bNow.path, 'chapters/0001-天明/text.md');
  assert.equal(aNow.meta.order, 2); assert.equal(bNow.meta.order, 1);
  const summary = await p.read(aNow.path.replace(/text\.md$/, 'summary.md'));
  assert.deepEqual(summary.meta.sources, [{ path: aNow.path, revision: aNow.revision }], 'summary follows the moved chapter');
  assert.equal((await p.diagnostics()).length, 0);
  // identity survives; the accepted chapter still exports
  assert.equal(aNow.meta.id, a.id);
  await p.exportBook();
});

test('reorder tolerates duplicate chapter titles without folder collisions', async t => {
  const p = await fixture(t);
  const a = await written(p, '同一标题'); const b = await written(p, '同一标题');
  assert.notEqual(folderOfPath(a.path), folderOfPath(b.path));
  await p.reorder([b.id, a.id]);
  const aNow = await p.chapter(a.id); const bNow = await p.chapter(b.id);
  assert.match(aNow.path, /^chapters\/0002-同一标题/); assert.match(bNow.path, /^chapters\/0001-同一标题/);
  assert.equal((await p.diagnostics()).length, 0);
});

function folderOfPath(p: string) { return p.split('/').slice(0, -1).join('/'); }
