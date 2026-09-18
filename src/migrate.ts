/**
 * format 1 → format 2 迁移。
 *
 * 改造内容有两类，**都存在存量小说里**，所以必须能自动迁移：
 *
 * 1. 目录从英文改为中文（`lore/characters` → `人物/`），`plan` 种类改名为 `chapter-plan`。
 * 2. `sources` 从路径改为稳定编号 —— 否则作者在 Obsidian 里一重命名文件，
 *    所有摘要和状态记录的来源就全部失效。
 *
 * 迁移是**一次事务**：任何一步失败整体回滚。事务日志保留每个文件的完整前后镜像，
 * 所以即使迁移完成，也能用 `/novel recover <ID>` 退回去。
 *
 * 会拒绝迁移的情况（不猜、不静默丢数据）：
 * - 存在无法归类的旧路径
 * - 两个文档会落到同一个新路径
 * - `sources` 指向的路径找不到对应文档（无法解析成编号）
 */

import * as fs from 'node:fs/promises';
import path from 'node:path';
import { decode, encode, type Meta, type Source } from './markdown.ts';
import { commit, locked, pending, readOptional, type Change } from './storage.ts';
import { FORMAT } from './project.ts';
import { chapterFolderName, parseChapterFolder } from './kinds.ts';

const LEGACY_FORMAT = 1;
const LEGACY_META = '.novel/project.md';

/** 固定路径的对应关系。 */
const EXACT: Record<string, string> = {
  'CREATOR.md': '创作约定.md',
  'setting/world.md': '设定/世界观.md',
  'setting/rules.md': '规则/世界规则.md',
  'setting/style.md': '设定/文风.md',
  'outline/main.md': '大纲/全书大纲.md',
};

/** 整目录搬迁。前缀匹配，长前缀在前。 */
const DIRECTORY_MOVES: readonly [string, string][] = [
  ['lore/characters', '人物'],
  ['lore/relationships', '人物/关系'],
  ['lore/locations', '设定/地点'],
  ['lore/factions', '设定/势力'],
  ['lore/items', '设定/物品'],
  ['lore/concepts', '设定/概念'],
  ['outline/arcs', '大纲/剧情线'],
  ['continuity/states', '当前状态/人物'],
  ['continuity/relationships', '当前状态/关系'],
  ['continuity/events', '时间线'],
  ['continuity/threads', '伏笔'],
  ['workspace/ideas', '灵感'],
  ['workspace/research', '灵感/考据'],
  ['workspace/proposals', '提案'],
  ['reviews', '审稿'],
  ['exports', '导出'],
];

/** 章节内部的文件改名。 */
const CHAPTER_FILE: Record<string, string> = { plan: '方案.md', text: '正文.md', summary: '摘要.md' };

/** 种类改名。 */
const KIND_RENAMES: Record<string, string> = { plan: 'chapter-plan' };

const CHAPTER_RE = /^chapters\/([^/]+)\/(plan|text|summary)\.md$/;

export interface PathMapping { from: string; to: string }

export interface MigrationPlan {
  root: string;
  title: string;
  moves: PathMapping[];
  kindRenames: number;
  sourceRewrites: number;
  /** 非空即拒绝迁移。 */
  blockers: string[];
}

/** 旧路径 → 新路径。返回 null 表示无法归类。 */
export function targetPathFor(old: string): string | null {
  const chapter = CHAPTER_RE.exec(old);
  if (chapter) {
    const folder = chapter[1];
    const which = chapter[2];
    if (folder === undefined || which === undefined) return null;
    const file = CHAPTER_FILE[which];
    if (file === undefined) return null;
    // 归一化序号（旧目录可能是 `1-雨夜`），并丢掉旧 slugify 留下的非法字符。
    const stem = folder.replace(/^\d+-/, '');
    return `章节/${chapterFolderName(parseChapterFolder(folder), stem)}/${file}`;
  }
  const exact = EXACT[old];
  if (exact !== undefined) return exact;
  for (const [from, to] of DIRECTORY_MOVES) {
    if (old === from || old.startsWith(`${from}/`)) return `${to}${old.slice(from.length)}`;
  }
  return null;
}

/** 递归列出所有旧文件。 */
async function legacyFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  const visit = async (prefix: string): Promise<void> => {
    const dir = prefix ? path.join(root, prefix) : root;
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue;
      const name = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) { await visit(name); continue; }
      if (entry.isFile() && name.endsWith('.md')) out.push(name);
    }
  };
  await visit('');
  return out.sort();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * 读取来源条目。
 *
 * format 1 用 `path`，format 2 用 `id`，而 `Meta.sources` 现在是新格式的类型，
 * 所以这里在边界上按 `unknown` 解码，不做类型断言 —— 类型断言会掩盖
 * 「旧数据其实不符合新类型」这个事实，而这正是迁移要处理的全部内容。
 */
interface LegacySource { id?: string; path?: string; revision: string }

function readLegacySources(meta: Meta): LegacySource[] {
  const raw: unknown = meta.sources;
  if (!Array.isArray(raw)) return [];
  const out: LegacySource[] = [];
  for (const item of raw) {
    if (!isRecord(item)) continue;
    const revision = item.revision;
    if (typeof revision !== 'string') continue;
    const entry: LegacySource = { revision };
    if (typeof item.id === 'string' && item.id) entry.id = item.id;
    if (typeof item.path === 'string') entry.path = item.path;
    out.push(entry);
  }
  return out;
}

interface LegacyDoc {
  old: string;
  meta: Meta;
  body: string;
  raw: string;
}

async function readLegacyDocs(root: string): Promise<{ docs: LegacyDoc[]; problems: string[] }> {
  const docs: LegacyDoc[] = [];
  const problems: string[] = [];
  for (const old of await legacyFiles(root)) {
    const raw = await readOptional(root, old);
    if (raw === null) continue;
    try {
      const parsed = decode(raw);
      docs.push({ old, meta: parsed.meta, body: parsed.body, raw });
    } catch (error) {
      problems.push(`${old} 无法解析：${String(error)}`);
    }
  }
  return { docs, problems };
}

export async function planMigration(root: string): Promise<MigrationPlan> {
  const metaRaw = await readOptional(root, LEGACY_META);
  if (metaRaw === null) throw new Error(`找不到 ${LEGACY_META}；这不是 pi-novel 项目`);
  const project = decode(metaRaw);
  if (project.meta.kind !== 'project') throw new Error('项目标记文件损坏');
  if (project.meta.format !== LEGACY_FORMAT) {
    throw new Error(project.meta.format === FORMAT ? '已经是 format 2，无需迁移' : `不支持的来源格式：${String(project.meta.format)}`);
  }

  const { docs, problems } = await readLegacyDocs(root);
  const blockers: string[] = [...problems];
  const byOldPath = new Set(docs.map((d) => d.old));
  const moves: PathMapping[] = [];
  const seen = new Map<string, string>();

  for (const doc of docs) {
    const to = targetPathFor(doc.old);
    if (to === null) {
      blockers.push(`${doc.old} 没有对应的新位置（旧格式里不该有这份文件？）`);
      continue;
    }
    const clash = seen.get(to.toLowerCase());
    if (clash !== undefined) blockers.push(`${doc.old} 与 ${clash} 都会落到 ${to}`);
    seen.set(to.toLowerCase(), doc.old);
    moves.push({ from: doc.old, to });
  }

  let kindRenames = 0;
  let sourceRewrites = 0;
  for (const doc of docs) {
    if (KIND_RENAMES[doc.meta.kind] !== undefined) kindRenames += 1;
    const sources = readLegacySources(doc.meta);
    if (sources.length) sourceRewrites += 1;
    for (const source of sources) {
      if (source.id !== undefined) continue;
      if (source.path === undefined) { blockers.push(`${doc.old} 的来源缺少 path，无法解析`); continue; }
      if (!byOldPath.has(source.path)) blockers.push(`${doc.old} 的来源 ${source.path} 找不到对应文档，无法解析成编号`);
    }
  }

  return { root, title: project.meta.title, moves, kindRenames, sourceRewrites, blockers };
}

export async function migrate(root: string): Promise<{ transaction: string; plan: MigrationPlan }> {
  const plan = await planMigration(root);
  if (plan.blockers.length) {
    throw new Error(`迁移被拒绝，有 ${plan.blockers.length} 个问题需要先解决：\n${plan.blockers.map((b) => `- ${b}`).join('\n')}`);
  }

  return locked(root, async () => {
    if ((await pending(root)).length) throw new Error('有未完成的事务；先执行 /novel recover <ID>');

    const { docs } = await readLegacyDocs(root);
    const byOldPath = new Map(docs.map((d) => [d.old, d]));
    const changes: Change[] = [];

    for (const { from, to } of plan.moves) {
      const doc = byOldPath.get(from);
      if (!doc) continue;
      const kind = KIND_RENAMES[doc.meta.kind] ?? doc.meta.kind;

      // 来源从 path 解析成 id：这是本次迁移的核心，也是 Obsidian 下必须做的改动。
      const legacy = readLegacySources(doc.meta);
      const sources: Source[] = legacy.map((source) => {
        if (source.id !== undefined) return { id: source.id, revision: source.revision };
        const target = byOldPath.get(source.path ?? '');
        if (!target) throw new Error(`来源无法解析：${from} → ${String(source.path)}`);
        return { id: target.meta.id, revision: source.revision };
      });

      const meta = { ...doc.meta, kind, ...(sources.length ? { sources } : {}) };
      changes.push({ path: from, before: doc.raw, after: null });
      changes.push({ path: to, before: null, after: encode(meta, doc.body) });
    }

    const metaRaw = await readOptional(root, LEGACY_META);
    if (metaRaw === null) throw new Error(`迁移途中 ${LEGACY_META} 消失了；请检查目录状态`);
    const project = decode(metaRaw);
    changes.push({
      path: LEGACY_META,
      before: metaRaw,
      after: encode({ ...project.meta, format: FORMAT }, '# pi-novel 项目\n\n这里只记录格式版本；小说内容与元数据都在各自的 Markdown 里。\n'),
    });

    // 旧目录按新规则已不受管，因此放行受管路径检查；每个路径都已在上面的映射里推导过。
    const transaction = await commit(root, changes, `Migrate format ${LEGACY_FORMAT} → ${FORMAT}`, { allowUnmanaged: true });
    await pruneEmptyLegacyDirs(root);
    return { transaction, plan };
  });
}

/** 清掉迁移后留下的空目录。只删空目录，尽力而为。 */
async function pruneEmptyLegacyDirs(root: string): Promise<void> {
  const candidates = ['setting', 'outline', 'lore', 'chapters', 'continuity', 'workspace', 'reviews', 'exports'];
  for (const name of candidates) {
    await removeIfEmptyTree(path.join(root, name)).catch(() => false);
  }
}

async function removeIfEmptyTree(dir: string): Promise<boolean> {
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true;
    throw error;
  }
  let empty = true;
  for (const entry of entries) {
    const child = path.join(dir, entry);
    const stat = await fs.lstat(child);
    if (stat.isDirectory()) {
      if (!(await removeIfEmptyTree(child))) empty = false;
    } else empty = false;
  }
  if (empty) { await fs.rmdir(dir); return true; }
  return false;
}
