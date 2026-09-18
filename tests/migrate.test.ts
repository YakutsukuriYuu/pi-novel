import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { migrate, planMigration, targetPathFor } from '../src/migrate.ts';
import { Project, FORMAT } from '../src/project.ts';
import { decode, encode, hash } from '../src/markdown.ts';
import { locked, rollback, readOptional, pending } from '../src/storage.ts';

/**
 * 手工搭一个 format 1 项目。
 *
 * 迁移会重写每一个文件，是整套改造里最危险的操作，所以必须有测试；
 * 而这些旧结构已经无法由当前代码生成，只能照旧格式写字面量。
 */
async function legacyProject(t: { after: (fn: () => Promise<void>) => void }) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-novel-f1-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const root = path.join(dir, '旧书');

  const chapterBody = encode({ id: 'ch-1', kind: 'chapter', title: '雨夜', status: 'draft', order: 1 }, '# 雨夜\n\n正文。');
  const files: Record<string, string> = {
    '.novel/project.md': encode({ id: 'project-1', kind: 'project', title: '旧书', status: 'draft', format: 1 }, '# pi-novel project'),
    'CREATOR.md': encode({ id: 'creator-1', kind: 'creator', title: '旧书', status: 'draft' }, '# 旧书\n\n目标。'),
    'setting/world.md': encode({ id: 'world-1', kind: 'world', title: '世界观', status: 'draft' }, '# 世界观\n\n有海。'),
    'setting/style.md': encode({ id: 'style-1', kind: 'style', title: '文风', status: 'draft' }, '# 文风\n\n冷硬。'),
    'lore/characters/林默.md': encode({ id: 'char-1', kind: 'character', title: '林默', status: 'draft' }, '# 林默\n\n刑警。'),
    'lore/relationships/林默与沈遥.md': encode({ id: 'rel-1', kind: 'relationship', title: '林默与沈遥', status: 'draft', refs: ['char-1'] }, '# 关系'),
    'continuity/threads/断掉的伞.md': encode({ id: 'thread-1', kind: 'thread', title: '断掉的伞', status: 'draft' }, '# 伏笔'),
    'workspace/ideas/一个想法.md': encode({ id: 'idea-1', kind: 'idea', title: '一个想法', status: 'draft' }, '# 想法'),
    'workspace/research/码头考据.md': encode({ id: 'research-1', kind: 'research', title: '码头考据', status: 'draft' }, '# 考据'),
    'outline/main.md': encode({ id: 'outline-1', kind: 'outline', title: '全书大纲', status: 'draft' }, '# 大纲'),
    'chapters/0001-雨夜/text.md': chapterBody,
    // plan 是最需要改名的种类：format 2 里它叫 chapter-plan
    'chapters/0001-雨夜/plan.md': encode({ id: 'ch-1-plan', kind: 'plan', title: '雨夜', status: 'draft', refs: ['ch-1'] }, '# 计划'),
    // summary 的来源按**路径**记录 —— 迁移的核心工作就是把它换成编号
    'chapters/0001-雨夜/summary.md': encode(
      { id: 'ch-1-summary', kind: 'summary', title: '雨夜', status: 'draft', refs: ['ch-1'], sources: [{ path: 'chapters/0001-雨夜/text.md', revision: hash(chapterBody) }] },
      '# 摘要\n\n推门。',
    ),
  };

  for (const [name, text] of Object.entries(files)) {
    await fs.mkdir(path.join(root, path.dirname(name)), { recursive: true });
    await fs.writeFile(path.join(root, name), text);
  }
  return { root, chapterBody };
}

test('format 1 项目迁移到 format 2：目录、种类名、来源绑定一次事务完成', async t => {
  const { root, chapterBody } = await legacyProject(t);

  const plan = await planMigration(root);
  assert.equal(plan.title, '旧书');
  assert.equal(plan.moves.length, 12, '12 个内容文件（.novel/ 不算）');
  assert.deepEqual(plan.blockers, []);
  assert.equal(plan.kindRenames, 1, 'plan → chapter-plan');
  assert.equal(plan.sourceRewrites, 1, '摘要的来源要改绑编号');

  const result = await migrate(root);
  assert.ok(result.transaction);

  // 目录已换中文，旧文件与旧目录一并消失
  await assert.rejects(fs.access(path.join(root, 'CREATOR.md')));
  await assert.rejects(fs.access(path.join(root, 'lore')));
  await assert.rejects(fs.access(path.join(root, 'setting')), '空目录应被清理');
  assert.equal(await fs.readFile(path.join(root, '创作约定.md'), 'utf8').then((s) => decode(s).meta.id), 'creator-1');
  assert.ok(decode(await fs.readFile(path.join(root, '设定/世界观.md'), 'utf8')).body.includes('有海'));
  assert.ok(decode(await fs.readFile(path.join(root, '人物/林默.md'), 'utf8')).body.includes('刑警'));
  assert.ok(decode(await fs.readFile(path.join(root, '灵感/考据/码头考据.md'), 'utf8')).body.includes('考据'));

  // 章节三件套改名，plan 的种类也跟着改
  const chapter = decode(await fs.readFile(path.join(root, '章节/0001-雨夜/正文.md'), 'utf8'));
  assert.equal(chapter.meta.kind, 'chapter');
  assert.equal(chapter.meta.order, 1);
  const planDoc = decode(await fs.readFile(path.join(root, '章节/0001-雨夜/方案.md'), 'utf8'));
  assert.equal(planDoc.meta.kind, 'chapter-plan', 'plan 必须改名为 chapter-plan');
  assert.deepEqual(planDoc.meta.refs, ['ch-1']);

  // 迁移的核心：来源从路径换成编号，revision 保留
  const summary = decode(await fs.readFile(path.join(root, '章节/0001-雨夜/摘要.md'), 'utf8'));
  assert.deepEqual(summary.meta.sources, [{ id: 'ch-1', revision: hash(chapterBody) }]);

  // 标记文件升级，且新代码能正常打开它
  assert.equal(decode(await fs.readFile(path.join(root, '.novel/project.md'), 'utf8')).meta.format, FORMAT);
  const p = new Project(root);
  await p.validate();
  assert.equal((await p.chapters()).length, 1);
  assert.deepEqual(await p.diagnostics(), [], '迁移后不应有任何结构问题');
});

test('迁移保留完整事务记录，可以整体退回', async t => {
  const { root, chapterBody } = await legacyProject(t);
  const result = await migrate(root);
  assert.equal((await pending(root)).length, 0);

  await locked(root, () => rollback(root, result.transaction));

  // 旧路径与旧内容原样回来
  assert.equal(await fs.readFile(path.join(root, 'CREATOR.md'), 'utf8').then((s) => decode(s).meta.id), 'creator-1');
  assert.equal(await fs.readFile(path.join(root, 'chapters/0001-雨夜/text.md'), 'utf8'), chapterBody);
  // 回滚删文件但不删目录（不该去动作者可能自己建的目录），所以断言文件而不是目录
  await assert.rejects(fs.access(path.join(root, '人物/林默.md')));
  await assert.rejects(fs.access(path.join(root, '章节/0001-雨夜/正文.md')));
  assert.equal(decode(await fs.readFile(path.join(root, '.novel/project.md'), 'utf8')).meta.format, 1);
});

test('迁移遇到无法解析的来源时拒绝执行，不猜也不静默丢数据', async t => {
  const { root } = await legacyProject(t);
  // 把摘要的来源指向一个不存在的文档（这是 format 1 的 path 形式，读取时要用宽容模式）
  const summaryPath = path.join(root, 'chapters/0001-雨夜/summary.md');
  const doc = decode(await fs.readFile(summaryPath, 'utf8'), { legacySources: true });
  await fs.writeFile(summaryPath, encode({ ...doc.meta, sources: [{ path: 'chapters/0009-不存在/text.md', revision: '0'.repeat(64) }] }, doc.body));

  const plan = await planMigration(root);
  assert.equal(plan.blockers.length, 1);
  assert.match(plan.blockers[0]!, /找不到对应文档/);

  await assert.rejects(migrate(root), /迁移被拒绝/);
  // 拒绝之后什么都没动
  assert.ok(await readOptional(root, 'CREATOR.md'));
  assert.equal(decode(await fs.readFile(path.join(root, '.novel/project.md'), 'utf8')).meta.format, 1);
});

test('AGENTS.md 和作者的笔记不阻塞迁移；受管目录里的裸 md 原样搬过去', async t => {
  const { root } = await legacyProject(t);
  // 插件自己在 format 1 建的基础设施文件：故意没有 frontmatter。
  // 早先的实现把它当成「损坏的受管文档」，于是一整本书都迁不了。
  await fs.writeFile(path.join(root, 'AGENTS.md'), '# 小说项目\n\n使用 pi-novel 的 novel_* 工具管理本书。\n');
  // 作者随手写的笔记（根级，本来就不归迁移管）
  await fs.writeFile(path.join(root, '随手记.md'), '雨天的感觉。\n');
  // 作者放在受管目录里、但没写 frontmatter 的笔记
  await fs.mkdir(path.join(root, 'lore/characters'), { recursive: true });
  await fs.writeFile(path.join(root, 'lore/characters/老张.md'), '老张是个铁匠。\n');

  const plan = await planMigration(root);
  assert.deepEqual(plan.blockers, [], '这些都不该阻塞迁移');
  assert.deepEqual([...plan.leftAlone].sort(), ['AGENTS.md', '随手记.md']);
  assert.deepEqual(plan.unregistered, ['lore/characters/老张.md']);

  await migrate(root);

  // 不在迁移范围的文件一字未动
  assert.match(await fs.readFile(path.join(root, 'AGENTS.md'), 'utf8'), /pi-novel/);
  assert.equal(await fs.readFile(path.join(root, '随手记.md'), 'utf8'), '雨天的感觉。\n');
  // 裸笔记跟着换位置，但内容一字未改 —— 补编号是作者用 novel_adopt 决定的事
  assert.equal(await fs.readFile(path.join(root, '人物/老张.md'), 'utf8'), '老张是个铁匠。\n');
  await assert.rejects(fs.access(path.join(root, 'lore/characters/老张.md')));

  // 迁移后它们都被如实报为「还没纳入管理」，而不是静默消失。
  // 根目录的随手记也在列 —— unmanaged 报的是全部未受管 markdown，两者都可以收编。
  assert.deepEqual([...(await new Project(root).unmanaged())].sort(), ['人物/老张.md', '随手记.md'].sort());
});

test('已经在 format 2 的项目不会被重复迁移', async t => {
  const { root } = await legacyProject(t);
  await migrate(root);
  await assert.rejects(planMigration(root), /已经是 format 2/);
});

test('旧路径映射表覆盖章节、固定文件与整目录三种形式', () => {
  assert.equal(targetPathFor('CREATOR.md'), '创作约定.md');
  assert.equal(targetPathFor('setting/rules.md'), '规则/世界规则.md');
  assert.equal(targetPathFor('lore/characters/林默.md'), '人物/林默.md');
  assert.equal(targetPathFor('lore/relationships/甲与乙.md'), '人物/关系/甲与乙.md');
  assert.equal(targetPathFor('lore/locations/旧城区.md'), '设定/地点/旧城区.md');
  assert.equal(targetPathFor('outline/arcs/断伞.md'), '大纲/剧情线/断伞.md');
  assert.equal(targetPathFor('continuity/states/0001-林默.md'), '当前状态/人物/0001-林默.md');
  assert.equal(targetPathFor('continuity/events/枪击.md'), '时间线/枪击.md');
  assert.equal(targetPathFor('workspace/research/码头.md'), '灵感/考据/码头.md');
  assert.equal(targetPathFor('reviews/审稿一.md'), '审稿/审稿一.md');
  assert.equal(targetPathFor('exports/旧书-20260101.md'), '导出/旧书-20260101.md');
  // 章节序号会被归一化（旧项目里可能出现 `1-雨夜` 这种没补零的目录）
  assert.equal(targetPathFor('chapters/1-雨夜/text.md'), '章节/0001-雨夜/正文.md');
  assert.equal(targetPathFor('chapters/0001-雨夜/plan.md'), '章节/0001-雨夜/方案.md');
  assert.equal(targetPathFor('chapters/0001-雨夜/summary.md'), '章节/0001-雨夜/摘要.md');
  // 认不出的路径必须返回 null，由调用方列为阻塞项而不是静默丢弃
  assert.equal(targetPathFor('随便/一个文件.md'), null);
});
