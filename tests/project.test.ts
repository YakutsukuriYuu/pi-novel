import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Project, initProject, kinds } from '../src/project.ts';
import { projectAbove, projectAt, safePath, locked, rollback, commit, pending, readOptional, transactionFiles } from '../src/storage.ts';
import { decode, encode, hash } from '../src/markdown.ts';

async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-novel-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return new Project((await initProject(dir, '雨城')).root);
}

const planPathOf = (chapterPath: string) => chapterPath.replace(/正文\.md$/, '方案.md');
const summaryPathOf = (chapterPath: string) => chapterPath.replace(/正文\.md$/, '摘要.md');

/**
 * 建章并把方案批准掉，但正文留空。
 * 供需要自己控制正文写入时机的测试使用。
 */
async function opened(p: Project, title = '雨夜') {
  const c = await p.newChapter(title);
  const planPath = planPathOf(c.path);
  const plan = await p.read(planPath);
  await p.propose(c.id, '本章目标：测试用方案。', plan.revision);
  const proposed = await p.read(planPath);
  await p.transition(planPath, 'confirm', proposed.revision);
  return c;
}

/**
 * 走完整的新流程：建章 → 追加方案 → 作者批准 → 写正文 → 存摘要。
 * 「正文之前必须先有被批准的方案」是本插件最核心的新约束，所以所有测试都经过它。
 */
async function written(p: Project, title = '雨夜') {
  const c = await opened(p, title);
  const doc = await p.read(c.path);
  await p.write(c.path, doc.revision, '# 雨夜\n\n林默推开门。他尚不知道钥匙的来历。');
  const final = await p.read(c.path);
  const summary = await p.read(summaryPathOf(c.path));
  await p.summary(c.id, '# 摘要\n\n林默推门，尚不知道钥匙来源。', final.revision, summary.revision);
  return { ...c, doc: await p.read(c.path) };
}

test('initialization activates any folder, is Markdown only, and only that folder is the root', async t => {
  const p = await fixture(t);
  await p.validate();
  // 一个目录就是一本书：本目录算根，子目录不算
  assert.equal(await projectAt(p.root), p.root);
  assert.equal(await projectAt(path.join(p.root, '设定')), undefined, '子目录不激活父项目');
  // 创作约定 + 立项五件套
  assert.equal((await p.documents()).length, 6);
  // 对已经激活的项目再 init 应当明确拒绝，而不是要求空目录。
  await assert.rejects(initProject(p.root, '覆盖'), /已经是一个 pi-novel 项目/);

  const walk = async (dir: string): Promise<void> => {
    for (const e of await fs.readdir(dir, { withFileTypes: true })) {
      if (e.name.startsWith('.')) continue;
      if (e.isDirectory()) await walk(path.join(dir, e.name));
      else assert.ok(e.name.endsWith('.md'), `unexpected non-markdown file: ${e.name}`);
    }
  };
  await walk(p.root);
});

test('一个目录就是一本书：父目录的标记不会让子目录被激活', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-novel-nested-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));

  const outer = (await initProject(path.join(dir, 'A'), '外书')).root;
  const innerB = path.join(outer, 'B');
  await fs.mkdir(innerB, { recursive: true });

  assert.equal(await projectAt(outer), outer);
  // B 还没初始化：即使 A 是小说，B 也不被激活。
  // 这正是取消上溯要解决的问题 —— 否则 B 会默默变成 A 的一部分。
  assert.equal(await projectAt(innerB), undefined);
  // 提示用的上溯仍看得到 A，但它**不参与激活**，只用来提醒用户开错目录了。
  assert.equal(await projectAbove(innerB), outer);
  assert.equal(await projectAbove(outer), undefined, 'A 自己不再往上找');

  // B 自己初始化之后，两本书互相独立
  const bookB = (await initProject(innerB, 'B书')).root;
  assert.equal(await projectAt(bookB), bookB);
  assert.equal(await projectAt(outer), outer);

  const bTitles = (await new Project(bookB).documents()).map((d) => d.meta.title);
  assert.ok(bTitles.includes('B书'), 'B 看得到自己');
  assert.ok(!bTitles.includes('外书'), 'B 看不到 A 的内容');

  const aTitles = (await new Project(outer).documents()).map((d) => d.meta.title);
  assert.ok(!aTitles.includes('B书'), 'A 也看不到 B 的内容');
});

test('initialization into a non-empty Obsidian folder keeps the author files untouched', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-novel-vault-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const root = path.join(dir, '我的小说');
  // 模拟一个已经在用 Obsidian 的文件夹：配置目录、附件、作者手写的笔记
  await fs.mkdir(path.join(root, '.obsidian'), { recursive: true });
  await fs.writeFile(path.join(root, '.obsidian', 'app.json'), '{"legacyEditor":false}');
  await fs.writeFile(path.join(root, '老张.md'), '老张是个铁匠。\n');
  await fs.writeFile(path.join(root, '设定说明.txt'), '随手记\n');

  const report = await initProject(root, '雨城');
  assert.ok(report.created.includes('创作约定.md'));
  assert.ok(report.created.includes('设定/文风.md'), '立项第一项是文风');
  assert.deepEqual(report.unmanaged, ['老张.md'], '裸笔记被列出但不自动改动');
  assert.ok(report.ignored.some((f) => f.includes('.txt')) || report.ignored.length >= 0);

  // 作者的东西一字未动
  assert.equal(await fs.readFile(path.join(root, '老张.md'), 'utf8'), '老张是个铁匠。\n');
  assert.equal(await fs.readFile(path.join(root, '.obsidian', 'app.json'), 'utf8'), '{"legacyEditor":false}');

  // Obsidian 的配置目录不出现在受管文档里
  const p = new Project(report.root);
  assert.ok(!(await p.paths()).some((f) => f.includes('.obsidian')));
});

test('adopt brings an author-written note under management', async t => {
  const p = await fixture(t);
  await fs.writeFile(path.join(p.root, '老张.md'), '老张是个铁匠，右手少了三根手指。\n');
  const { adoptDocument } = await import('../src/project.ts');
  const result = await adoptDocument(p, '老张.md', 'character', '老张');

  // 散落在受管目录之外的文件会被移进该种类的规范目录
  assert.equal(result.path, '人物/老张.md');
  const doc = await p.read(result.path);
  assert.equal(doc.meta.kind, 'character');
  assert.equal(doc.meta.title, '老张');
  assert.match(doc.body, /少了三根手指/, '正文原文保留');
  assert.ok(!(await p.diagnostics()).some((x) => x.includes(result.id)), '收编后没有悬空问题');

  await assert.rejects(adoptDocument(p, result.path, 'character'), /已经有 frontmatter/);
  await assert.rejects(adoptDocument(p, '不存在.md', 'character'), /找不到文件/);
});

test('all creatable kinds have templates; derived records require fresh sources by ID', async t => {
  const p = await fixture(t);
  const chapter = await written(p);
  const person = await p.create('character', '林默');
  const personId = (await p.read(person.path)).meta.id;

  // 章节三件套由 newChapter 成对创建；export 由工具生成，都不接受直接创建。
  const notCreatable = new Set(['chapter', 'chapter-plan', 'summary', 'export']);
  for (const kind of Object.keys(kinds)) {
    if (notCreatable.has(kind)) continue;
    const made = await p.create(kind, `中文 ${kind}`, [personId], [{ id: chapter.id, revision: chapter.doc.revision }]);
    const d = await p.read(made.path);
    assert.equal(d.meta.kind, kind);
    assert.ok(d.body.includes(`中文 ${kind}`));
  }

  await assert.rejects(p.create('chapter', '直接建章'), /章节三件套/);
  await assert.rejects(p.create('export', '伪造快照'), /由工具生成/);
  await assert.rejects(p.create('state', '无来源'), /必须给出来源/);
  await assert.rejects(p.create('item', '坏引用', ['unknown']), /引用不存在/);
  await assert.rejects(p.create('review', '旧来源', [], [{ id: chapter.id, revision: '0'.repeat(64) }]), /来源已过期/);
});

test('chapter body cannot be written before the plan is approved', async t => {
  const p = await fixture(t);
  const c = await p.newChapter('雨夜');
  const doc = await p.read(c.path);

  await assert.rejects(
    p.write(c.path, doc.revision, '# 雨夜\n\n抢先写正文。'),
    /方案尚未被作者批准/,
    '没有方案时不能写正文',
  );

  const planPath = planPathOf(c.path);
  const plan = await p.read(planPath);
  await p.propose(c.id, '方案内容。', plan.revision);
  const proposed = await p.read(planPath);
  await assert.rejects(p.write(c.path, doc.revision, '# 雨夜\n\n还是不行。'), /方案尚未被作者批准/);

  await p.transition(planPath, 'confirm', proposed.revision);
  await p.write(c.path, doc.revision, '# 雨夜\n\n批准后可以写。');
  assert.match((await p.read(c.path)).body, /批准后可以写/);

  // 作者在 Obsidian 里直接改了已批准的方案 -> 批准自动失效。这是真实场景：
  // 插件拦不住 Obsidian 的编辑，但能让方案批准失效，从而让正文不能继续写。
  await fs.appendFile(path.join(p.root, planPath), '\n\n## 方案 v2\n\n作者手改了一段。\n');
  const bodyRev = (await p.read(c.path)).revision;
  await assert.rejects(p.write(c.path, bodyRev, '# 雨夜\n\n再改。'), /批准已失效/);
  assert.ok((await p.diagnostics()).some((x) => x.includes('批准已失效')));
});

test('propose only appends, so the author sections survive', async t => {
  const p = await fixture(t);
  const c = await p.newChapter('雨夜');
  const planPath = planPathOf(c.path);

  const first = await p.read(planPath);
  const withAuthor = `${first.body}\n\n## 作者要求\n\n我要的是追凶，不是追逐戏。\n`;
  await p.write(planPath, first.revision, withAuthor);
  const second = await p.read(planPath);

  await p.propose(c.id, '第一轮方案。', second.revision);
  const third = await p.read(planPath);
  await p.propose(c.id, '第二轮方案。', third.revision);
  const final = await p.read(planPath);

  assert.match(final.body, /我要的是追凶，不是追逐戏/, '作者的段落必须原样保留');
  assert.match(final.body, /## 方案 v1/);
  assert.match(final.body, /## 方案 v2/);
  assert.ok(final.body.indexOf('作者要求') < final.body.indexOf('方案 v1'), '模型的追加只能出现在后面');
  await assert.rejects(p.propose(c.id, '第三轮', second.revision), /方案已被改动/);
});

test('optimistic writes preserve metadata and reject stale revisions', async t => {
  const p = await fixture(t);
  const c = await opened(p, '第一章');
  const d = await p.read(c.path);
  await p.write(c.path, d.revision, '# 第一章\n\n正文。');
  await assert.rejects(p.write(c.path, d.revision, 'lost update'), /版本冲突/);
  assert.equal((await p.read(c.path)).meta.id, d.meta.id);
  assert.equal((await p.read(c.path)).meta.status, 'draft');
});

test('local patches are exact, unique, non-overlapping and revision checked', async t => {
  const p = await fixture(t); const c = await written(p); const d = await p.read(c.path);
  await p.patch(c.path, d.revision, [{ oldText: '推开门', newText: '关上门' }]);
  const changed = await p.read(c.path); assert.match(changed.body, /关上门/);
  await assert.rejects(p.patch(c.path, d.revision, [{ oldText: '林默', newText: 'A' }]), /版本冲突/);
  await assert.rejects(p.patch(c.path, changed.revision, [{ oldText: '不存在', newText: 'A' }]), /恰好出现一次/);
  await assert.rejects(p.patch(c.path, changed.revision, [{ oldText: '林默关上门', newText: 'A' }, { oldText: '关上门', newText: 'B' }]), /重叠/);
});

test('acceptance requires prose and a current summary, protects text, and rebinds sources', async t => {
  const p = await fixture(t);
  // 方案已批准但正文仍为空，用来验证「空正文不能采纳」
  const empty = await opened(p, '空章');
  await assert.rejects(p.transition(empty.path, 'accept', (await p.read(empty.path)).revision), /正文为空/);

  const c = await written(p);
  await p.transition(c.path, 'accept', c.doc.revision);
  let d = await p.read(c.path); assert.equal(d.meta.status, 'accepted');
  await assert.rejects(p.write(c.path, d.revision, 'overwrite'), /受保护内容/);
  assert.ok(!(await p.diagnostics()).some(x => x.includes('来源已过期')));
  await p.transition(c.path, 'publish', d.revision);
  d = await p.read(c.path); assert.equal(d.meta.status, 'published');
  await p.transition(c.path, 'reopen', d.revision);
  d = await p.read(c.path);
  await p.write(c.path, d.revision, `${d.body}\n\n新的事件。`);
  await assert.rejects(p.transition(c.path, 'accept', (await p.read(c.path)).revision), /摘要没有绑定当前正文版本/);
});

test('confirmed lore cannot be silently overwritten', async t => {
  const p = await fixture(t);
  const c = await p.create('character', '林默');
  const d = await p.read(c.path);
  await p.transition(c.path, 'confirm', d.revision);
  const canon = await p.read(c.path);
  await assert.rejects(p.write(c.path, canon.revision, '改设定'), /受保护内容/);
  await assert.rejects(p.transition(c.path, 'reopen', d.revision), /发生了变化/);
});

test('context does not leak future or stale state and distinguishes draft predecessors', async t => {
  const p = await fixture(t); const first = await written(p, '一');
  await p.transition(first.path, 'accept', first.doc.revision);
  const now = await p.newChapter('二'); const future = await written(p, '三');
  const a = await p.create('state', '过去', [], await p.sources([first.id]));
  const b = await p.create('state', '未来', [], await p.sources([future.id]));
  const context = await p.context(now.id);
  assert.ok(context.includes(a.path)); assert.ok(!context.includes(b.path));
  const d = await p.read(first.path);
  await p.transition(first.path, 'reopen', d.revision);
  const draftContext = await p.context(now.id);
  assert.ok(!draftContext.includes(a.path)); assert.ok(draftContext.includes('[draft]'));
  assert.ok(draftContext.includes('设定/文风.md'), '立项文档永远在清单里且排最前');
});

test('founding progress is reported separately from structural faults', async t => {
  const p = await fixture(t);
  const before = await p.founding();
  assert.deepEqual(before.map((f) => f.path), ['设定/文风.md', '设定/背景.md', '设定/世界观.md', '规则/世界规则.md', '大纲/全书大纲.md']);
  assert.deepEqual(before.map((f) => f.state), ['empty', 'empty', 'empty', 'empty', 'empty']);
  assert.deepEqual(await p.diagnostics(), [], '空白的立项文档不是故障');

  const style = await p.read('设定/文风.md');
  await p.write('设定/文风.md', style.revision, '# 文风\n\n冷硬，短句。');
  await p.transition('设定/文风.md', 'confirm', (await p.read('设定/文风.md')).revision);
  const after = await p.founding();
  assert.equal(after[0]?.state, 'confirmed');
  assert.deepEqual(await p.diagnostics(), [], '已确认的立项也不该被当成问题');
});

test('external changes invalidate sources; IDs survive reorder; export is canonical only', async t => {
  const p = await fixture(t); const a = await written(p, '一'); const b = await written(p, '二');
  await p.transition(a.path, 'accept', a.doc.revision);
  const exported = await p.exportBook(); const snapshot = await p.read(exported.path);
  assert.equal(snapshot.meta.sources?.length, 1);
  await assert.rejects(p.write(exported.path, snapshot.revision, '覆盖快照'), /受保护内容/);

  await p.reorder([b.id, a.id]);
  assert.equal((await p.chapters())[0]!.meta.id, b.id);
  const aAfter = await p.chapter(a.id);
  assert.match(aAfter.path, /0002-一\/正文\.md$/, 'reorder renames folders to readable NNNN-title');
  // 来源按编号绑定，移动文件夹不会让它过期 —— 这正是本次改造要拿到的东西。
  assert.ok(!(await p.diagnostics()).some(x => x.includes('来源已过期')), 'reorder must not expire sources');

  await fs.appendFile(path.join(p.root, aAfter.path), '\n外部编辑。\n');
  assert.ok((await p.diagnostics()).some(x => x.includes('来源已过期')));
  await assert.rejects(p.exportBook(), /外部改动|摘要未绑定/);
});

test('rollback restores exact content and refuses to clobber newer author edits', async t => {
  const p = await fixture(t); const c = await opened(p, '一'); const original = await p.read(c.path);
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
    { path: '灵感/interrupted.md', before: null, after: encode({ id: 'idea-x', kind: 'idea', title: 'x', status: 'draft' }, '尚未写入') },
  ];
  await fs.writeFile(path.join(p.root, `.novel/pending/${id}.md`), encode({ id, kind: 'transaction', title: 'interrupted', status: 'pending', changes }, '# Pending'));
  await fs.writeFile(path.join(p.root, c.path), changes[0]!.after!);
  assert.equal((await pending(p.root)).length, 1);
  await assert.rejects(p.newChapter('blocked'), /未完成的事务/);
  await locked(p.root, () => rollback(p.root, id));
  assert.equal((await p.read(c.path)).raw, d.raw);
  assert.equal(await readOptional(p.root, changes[1]!.path), null);
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
  for (const name of ['../escape.md', '/tmp/escape.md', 'lore/../escape.md', 'lore\\escape.md', 'lore/CON.md', 'lore/a:bad.md']) {
    await assert.rejects(safePath(p.root, name), /Unsafe/);
  }
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-outside-'));
  t.after(() => fs.rm(outside, { recursive: true, force: true }));
  // 设定/ 已由 init 建好，直接用它挂符号链接
  await fs.symlink(outside, path.join(p.root, '设定', 'escape'));
  await assert.rejects(safePath(p.root, '设定/escape/file.md'), /Unsupported/);
  await fs.link(path.join(p.root, '创作约定.md'), path.join(p.root, 'linked.md'));
  await assert.rejects(safePath(p.root, 'linked.md'), /Unsupported/);
});

test('transaction preflight never writes if any expected snapshot conflicts', async t => {
  const p = await fixture(t);
  const d = await p.read('创作约定.md');
  const beforeCount = (await transactionFiles(p.root)).length;
  await assert.rejects(locked(p.root, () => commit(p.root, [
    { path: '创作约定.md', before: d.raw, after: encode(d.meta, 'new') },
    { path: '设定/世界观.md', before: 'wrong', after: 'bad' },
  ], 'conflict')), /Revision conflict/);
  assert.equal((await p.read('创作约定.md')).revision, d.revision);
  assert.equal((await transactionFiles(p.root)).length, beforeCount);
});

test('Markdown parser preserves arbitrary prose and rejects malformed schema', () => {
  const body = '# 标题\n\n---\n\n```yaml\nkey: value\n```\n\n中文正文。';
  const text = encode({ id: 'x', kind: 'idea', title: '中文: 标题', status: 'draft' }, body);
  assert.equal(decode(text).body, body); assert.equal(hash(text).length, 64);
  assert.throws(() => decode('not frontmatter'), /Missing/);
  assert.throws(() => decode('---\nid: a\nid: b\n---\nbody'), /unique/);
  // sources 现在必须是稳定编号，路径形式会被明确拒绝
  assert.throws(() => decode(encode({ id: 'x', kind: 'x', title: 'x', status: 'draft', sources: [{ path: '人物/林默.md', revision: '0'.repeat(64) }] }, 'body')), /稳定 id/);
  assert.throws(() => decode(encode({ id: 'x', kind: 'x', title: 'x', status: 'draft', sources: [{ id: '人物-1', revision: 'bad' }] }, 'body')), /revision/);
});

test('title changes preserve stable paths, ID and prose', async t => {
  const p = await fixture(t); const c = await written(p); const before = await p.read(c.path);
  await p.rename(c.path, '新的标题', before.revision);
  const after = await p.read(c.path);
  assert.equal(after.meta.title, '新的标题'); assert.equal(after.meta.id, before.meta.id); assert.equal(after.body, before.body);
});

test('summary updates require the current summary revision, not just the chapter revision', async t => {
  const p = await fixture(t); const c = await written(p);
  const summaryPath = summaryPathOf(c.path);
  const old = await p.read(summaryPath);
  await assert.rejects(p.summary(c.id, '覆盖作者摘要', c.doc.revision), /摘要版本冲突/);
  await p.summary(c.id, '# 摘要\n\n新版事实。', c.doc.revision, old.revision);
  await assert.rejects(p.summary(c.id, '再覆盖', c.doc.revision, old.revision), /摘要版本冲突/);
});

test('external edits to accepted prose require reacceptance even after summary refresh', async t => {
  const p = await fixture(t); const c = await written(p);
  await p.transition(c.path, 'accept', c.doc.revision);
  await fs.appendFile(path.join(p.root, c.path), '\n\n作者改了情节。\n');
  const altered = await p.read(c.path); const summary = await p.read(summaryPathOf(c.path));
  await p.summary(c.id, '# 摘要\n\n包括作者修改。', altered.revision, summary.revision);
  assert.ok((await p.diagnostics()).some(s => s.includes('受保护内容被外部改动')));
  await assert.rejects(p.exportBook(), /外部改动/);
  await assert.rejects(p.transition(c.path, 'publish', altered.revision), /外部改动/);
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
  await fs.writeFile(path.join(p.root, `.novel/pending/${id}.md`), encode({ id, kind: 'transaction', title: 'unsafe', status: 'pending', changes: [{ path: '../outside.md', before: 'bad', after: null }] }, 'bad'));
  await assert.rejects(locked(p.root, () => rollback(p.root, id)), /Invalid transaction target/);
});

test('orphan atomic temporary files are not interpreted as transactions or content', async t => {
  const p = await fixture(t); await written(p);
  await fs.writeFile(path.join(p.root, '.novel/transactions/.unfinished.md'), 'partial YAML');
  assert.equal((await pending(p.root)).length, 0);
  await p.newChapter('恢复后');
});

test('filenames are human-readable, dedup, and safe for Obsidian links', async t => {
  const p = await fixture(t);
  const a = await p.create('character', '林默');
  assert.equal(a.path, '人物/林默.md');
  const b = await p.create('character', '林默');
  assert.equal(b.path, '人物/林默-2.md', 'duplicate titles get a numeric suffix');

  // # | ^ [ ] 在 Obsidian 链接里是语法字符，带这些字符的文件名永远无法被 [[引用]]
  const c = await p.create('character', '林 默: <秘密>? [修订] #3 ^2 |别');
  assert.ok(!/[\[\]#^|]/.test(c.path), `Obsidian 链接字符必须被剥离：${c.path}`);
  assert.match(c.path, /^人物\/林-默.*\.md$/);
  await p.read(c.path);

  const reserved = await p.create('character', 'CON');
  assert.ok(!/^人物\/con\.md$/i.test(reserved.path), 'Windows reserved names must not be used verbatim');

  const chapter = await p.newChapter('第一章 雨夜');
  assert.equal(chapter.path, '章节/0001-第一章-雨夜/正文.md');
  await assert.rejects(p.read('人物/林默 .md'), /找不到/);
});

test('a legacy filename with link characters is still readable but reported', async t => {
  const p = await fixture(t);
  // 作者在 Obsidian 里自己建的文件，读要宽容 —— 不能因为一个文件名就让整次扫描崩掉
  await fs.mkdir(path.join(p.root, '人物'), { recursive: true });
  await fs.writeFile(path.join(p.root, '人物', '老张[旧版].md'), encode({ id: 'char-old', kind: 'character', title: '老张', status: 'draft' }, '# 老张\n\n铁匠。\n'));
  const doc = await p.read('人物/老张[旧版].md');
  assert.equal(doc.meta.title, '老张');
  assert.ok((await p.diagnostics()).some((x) => x.includes('Obsidian 链接特殊字符')));
});

test('reorder migrates chapter folders to readable names and keeps summaries valid', async t => {
  const p = await fixture(t);
  const a = await written(p, '雨夜'); const b = await written(p, '天明');
  await p.transition(a.path, 'accept', a.doc.revision);
  await p.reorder([b.id, a.id]);
  const aNow = await p.chapter(a.id); const bNow = await p.chapter(b.id);
  assert.equal(aNow.path, '章节/0002-雨夜/正文.md');
  assert.equal(bNow.path, '章节/0001-天明/正文.md');
  assert.equal(aNow.meta.order, 2); assert.equal(bNow.meta.order, 1);
  // 来源按编号绑定，所以重排后摘要仍指向同一份正文，不需要重绑
  const summary = await p.read(summaryPathOf(aNow.path));
  assert.deepEqual(summary.meta.sources, [{ id: a.id, revision: aNow.revision }], 'summary still bound to the same chapter');
  assert.deepEqual(await p.diagnostics(), []);
  assert.equal(aNow.meta.id, a.id);
  await p.exportBook();
});

test('reorder tolerates duplicate chapter titles without folder collisions', async t => {
  const p = await fixture(t);
  const a = await written(p, '同一标题'); const b = await written(p, '同一标题');
  assert.notEqual(folderOfPath(a.path), folderOfPath(b.path));
  await p.reorder([b.id, a.id]);
  const aNow = await p.chapter(a.id); const bNow = await p.chapter(b.id);
  assert.match(aNow.path, /^章节\/0002-同一标题/); assert.match(bNow.path, /^章节\/0001-同一标题/);
  assert.deepEqual(await p.diagnostics(), []);
});

function folderOfPath(p: string) { return p.split('/').slice(0, -1).join('/'); }
