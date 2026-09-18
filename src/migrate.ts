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
  /** 在迁移范围内、但没有 frontmatter（或格式坏）的文件。原样搬过去，需要作者再收编。 */
  unregistered: string[];
  /** 不在迁移范围内、保持原样的文件。如 AGENTS.md 与作者自己的笔记。 */
  leftAlone: string[];
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
  /** 迁移后的位置。已经由 targetPathFor 判定，不会为 null。 */
  to: string;
  raw: string;
  /** null 表示这个文件解不开（缺 frontmatter 或格式坏）。 */
  meta: Meta | null;
  body: string;
}

/**
 * 列出迁移范围内的文件。
 *
 * **范围由路径决定，不由能否解析决定。** 这一点曾经错得很隐蔽：
 * 早先先扫描全部 `.md` 去解析、解析失败就报阻塞，于是 `AGENTS.md`
 * （插件自己建的、故意没有 frontmatter 的规则文件）和作者随手写的笔记
 * 都会把整次迁移堵死。
 *
 * 现在的规则：
 * - 映射不到新位置的 → 根本不归迁移管，原样不动
 * - 映射得到位置、但解不开的 → 原样搬过去，报告为「未登记」
 * 两者都不阻塞。
 */
async function legacyEntries(root: string): Promise<{ entries: LegacyDoc[]; leftAlone: string[] }> {
  const entries: LegacyDoc[] = [];
  const leftAlone: string[] = [];
  for (const old of await legacyFiles(root)) {
    const to = targetPathFor(old);
    if (to === null) { leftAlone.push(old); continue; }
    const raw = await readOptional(root, old);
    if (raw === null) continue;
    try {
      // legacySources：format 1 的 sources 用 path，而当前校验器要求 id。
      // 用严格模式读旧文件会直接把迁移自己的输入判成非法。
      const parsed = decode(raw, { legacySources: true });
      entries.push({ old, to, raw, meta: parsed.meta, body: parsed.body });
    } catch {
      // 受管目录里的裸笔记：作者手写、没有 frontmatter。
      // 它只需要换个位置，登记编号是 novel_adopt 的事，不该堵住整本书。
      entries.push({ old, to, raw, meta: null, body: '' });
    }
  }
  return { entries, leftAlone };
}

export async function planMigration(root: string): Promise<MigrationPlan> {
  const metaRaw = await readOptional(root, LEGACY_META);
  if (metaRaw === null) throw new Error(`找不到 ${LEGACY_META}；这不是 pi-novel 项目`);
  const project = decode(metaRaw);
  if (project.meta.kind !== 'project') throw new Error('项目标记文件损坏');
  if (project.meta.format !== LEGACY_FORMAT) {
    throw new Error(project.meta.format === FORMAT ? '已经是 format 2，无需迁移' : `不支持的来源格式：${String(project.meta.format)}`);
  }

  const { entries, leftAlone } = await legacyEntries(root);
  const blockers: string[] = [];
  const registered = entries.filter((e) => e.meta !== null);
  const byOldPath = new Set(registered.map((e) => e.old));
  const moves: PathMapping[] = [];
  const unregistered: string[] = [];
  const seen = new Map<string, string>();

  for (const entry of entries) {
    const clash = seen.get(entry.to.toLowerCase());
    if (clash !== undefined) blockers.push(`${entry.old} 与 ${clash} 都会落到 ${entry.to}`);
    seen.set(entry.to.toLowerCase(), entry.old);
    moves.push({ from: entry.old, to: entry.to });
    if (entry.meta === null) unregistered.push(entry.old);
  }

  let kindRenames = 0;
  let sourceRewrites = 0;
  for (const entry of registered) {
    const meta = entry.meta!;
    if (KIND_RENAMES[meta.kind] !== undefined) kindRenames += 1;
    const sources = readLegacySources(meta);
    if (sources.length) sourceRewrites += 1;
    for (const source of sources) {
      if (source.id !== undefined) continue;
      if (source.path === undefined) { blockers.push(`${entry.old} 的来源缺少 path，无法解析`); continue; }
      if (!byOldPath.has(source.path)) blockers.push(`${entry.old} 的来源 ${source.path} 找不到对应文档，无法解析成编号`);
    }
  }

  return { root, title: project.meta.title, moves, kindRenames, sourceRewrites, unregistered, leftAlone, blockers };
}

export async function migrate(root: string): Promise<{ transaction: string; plan: MigrationPlan }> {
  const plan = await planMigration(root);
  if (plan.blockers.length) {
    throw new Error(`迁移被拒绝，有 ${plan.blockers.length} 个问题需要先解决：\n${plan.blockers.map((b) => `- ${b}`).join('\n')}`);
  }

  return locked(root, async () => {
    if ((await pending(root)).length) throw new Error('有未完成的事务；先执行 /novel recover <ID>');

    const { entries } = await legacyEntries(root);
    const byOldPath = new Map(entries.filter((e) => e.meta !== null).map((e) => [e.old, e]));
    const changes: Change[] = [];

    for (const entry of entries) {
      let after: string;
      if (entry.meta === null) {
        // 没有 frontmatter 的文件原样搬过去。
        // 给它补编号是作者用 novel_adopt 决定的事，迁移不替作者做主。
        after = entry.raw;
      } else {
        const meta = entry.meta;
        const kind = KIND_RENAMES[meta.kind] ?? meta.kind;
        // 来源从 path 解析成 id：这是本次迁移的核心，也是 Obsidian 下必须做的改动。
        const sources: Source[] = readLegacySources(meta).map((source) => {
          if (source.id !== undefined) return { id: source.id, revision: source.revision };
          const target = byOldPath.get(source.path ?? '');
          if (!target?.meta) throw new Error(`来源无法解析：${entry.old} → ${String(source.path)}`);
          return { id: target.meta.id, revision: source.revision };
        });
        after = encode({ ...meta, kind, ...(sources.length ? { sources } : {}) }, entry.body);
      }
      changes.push({ path: entry.old, before: entry.raw, after: null });
      changes.push({ path: entry.to, before: null, after });
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
