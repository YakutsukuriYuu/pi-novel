/**
 * 文档种类的唯一来源。
 *
 * 改造前这里的信息散在三处：`project.ts` 的 kinds 映射、`storage.ts` 的 areas 集合、
 * `Project.paths()` 里又一份硬编码目录列表。三份必然漂移，现在合并到这里。
 *
 * 两条命名决定：
 *
 * 1. **目录名用中文。** 这个插件的前端是 Obsidian，作者在左栏直接看到这些文件夹名。
 * 2. **种类标识（kind）保持英文。** 它写进 frontmatter，是机器字段：代码按它分支，
 *    而且改它会让所有存量小说的 frontmatter 失效。中文名放在 `label` 里用于展示。
 */

/** 只允许停留在草稿的种类。 */
export const DRAFT_ONLY: readonly string[] = ['draft'];
/** 可由作者确认的种类。 */
export const CONFIRMABLE_STATES: readonly string[] = ['draft', 'confirmed'];
/** 章节正文。 */
export const CHAPTER_STATES: readonly string[] = ['draft', 'accepted', 'published'];

export interface KindDef {
  /** frontmatter 的 kind 值，机器标识，英文。 */
  kind: string;
  /** 中文显示名，用于提示、错误信息和界面。 */
  label: string;
  /** 所在目录，相对项目根，中文。 */
  folder: string;
  /** 派生资料：必须绑定来源版本，否则只能当草稿参考。 */
  derived?: boolean;
  /** 受保护的设定：作者可以用 confirm 把它从草稿变成长期设定。 */
  confirmable?: boolean;
  /** 立项文档：新项目最先要定的内容，上下文清单里永远排最前。 */
  founding?: boolean;
  /**
   * 由工具生成的产物（如导出快照），不接受模型或作者直接创建。
   * 这类文档有刻意冻结的来源版本，让它们能被自由创建会破坏诊断的可信度。
   */
  generated?: boolean;
  /**
   * 该种类允许的状态。省略时按其他标记推导：
   * confirmable → draft/confirmed，其余 → 只有 draft。
   *
   * 它存在的原因：作者会直接改 frontmatter，而一个对该种类无效的状态值
   * （例如给章节写 confirmed）以前会被静默忽略——文件看着改了，实际什么也没发生。
   */
  statuses?: readonly string[];
  /** 模板文件名，默认与 kind 同名。 */
  template?: string;
}

/**
 * 立项顺序即数组顺序，`foundingOrder()` 依赖它。
 *
 * 文风排在第一位是刻意的：调子不定，后面写的所有正文都是返工。
 */
export const KINDS: readonly KindDef[] = [
  // ── 立项：最先要定的五件事 ───────────────────────────────────────
  { kind: 'style', label: '文风', folder: '设定', confirmable: true, founding: true },
  { kind: 'background', label: '背景', folder: '设定', confirmable: true, founding: true },
  { kind: 'world', label: '世界观', folder: '设定', confirmable: true, founding: true },
  { kind: 'rules', label: '世界规则', folder: '规则', confirmable: true, founding: true },
  { kind: 'outline', label: '全书大纲', folder: '大纲', confirmable: true, founding: true },

  // ── 规则：硬约束 ─────────────────────────────────────────────────
  { kind: 'writing', label: '写作规则', folder: '规则', confirmable: true },
  { kind: 'taboo', label: '禁忌', folder: '规则', confirmable: true },

  // ── 设定：世界的事实 ──────────────────────────────────────────────
  { kind: 'system', label: '体系', folder: '设定', confirmable: true },
  { kind: 'location', label: '地点', folder: '设定/地点', confirmable: true },
  { kind: 'faction', label: '势力', folder: '设定/势力', confirmable: true },
  { kind: 'item', label: '物品', folder: '设定/物品', confirmable: true },
  { kind: 'concept', label: '概念', folder: '设定/概念', confirmable: true },

  // ── 人物 ─────────────────────────────────────────────────────────
  { kind: 'character', label: '人物', folder: '人物', confirmable: true },
  { kind: 'relationship', label: '初始关系', folder: '人物/关系', confirmable: true },

  // ── 大纲 ─────────────────────────────────────────────────────────
  { kind: 'volume', label: '分卷', folder: '大纲', confirmable: true },
  { kind: 'arc', label: '剧情线', folder: '大纲/剧情线', confirmable: true },

  // ── 章节两件套 ───────────────────────────────────────────────────
  // 方案必须先被作者批准，正文才允许写入（见 Project.write）。
  { kind: 'chapter-plan', label: '章节方案', folder: '章节', template: 'chapter-plan', confirmable: true },
  { kind: 'chapter', label: '章节正文', folder: '章节', statuses: CHAPTER_STATES },

  // ── 追踪：随时间变化的事实 ────────────────────────────────────────
  { kind: 'state', label: '人物状态', folder: '当前状态/人物', derived: true },
  { kind: 'relationship-state', label: '关系状态', folder: '当前状态/关系', derived: true },
  { kind: 'event', label: '事件', folder: '时间线', derived: true },
  { kind: 'thread', label: '伏笔', folder: '伏笔' },

  // ── 长期设计（不是快照） ──────────────────────────────────────────
  { kind: 'emotion', label: '情感线', folder: '情感线', confirmable: true },
  { kind: 'timeline', label: '时间线', folder: '时间线', confirmable: true },

  // ── 辅助 ─────────────────────────────────────────────────────────
  { kind: 'review', label: '审稿', folder: '审稿', derived: true },
  { kind: 'idea', label: '灵感', folder: '灵感' },
  { kind: 'research', label: '考据', folder: '灵感/考据' },
  { kind: 'proposal', label: '提案', folder: '提案' },
  { kind: 'export', label: '导出', folder: '导出', generated: true, statuses: ['snapshot'] },

  // ── 根级 ─────────────────────────────────────────────────────────
  { kind: 'creator', label: '创作约定', folder: '', template: 'creator' },
];

const BY_KIND = new Map(KINDS.map((k) => [k.kind, k]));

export function kindDef(kind: string): KindDef {
  const found = BY_KIND.get(kind);
  if (!found) throw new Error(`未知种类：${kind}；可用：${KINDS.map((k) => k.kind).join(', ')}`);
  return found;
}

/**
 * 某个种类允许的状态。
 *
 * 单一来源：`transition()` 用它校验状态变更，`diagnostics()` 用它报出
 * 作者手改进来的非法状态。两边各写一份必然漂移。
 */
export function statusesOf(kind: string): readonly string[] {
  const def = kindDef(kind);
  if (def.statuses) return def.statuses;
  return def.confirmable ? CONFIRMABLE_STATES : DRAFT_ONLY;
}

export function isKind(kind: string): boolean {
  return BY_KIND.has(kind);
}

export function labelOf(kind: string): string {
  return BY_KIND.get(kind)?.label ?? kind;
}

export function templateNameOf(kind: string): string {
  return BY_KIND.get(kind)?.template ?? kind;
}

/** 种类 → 目录。多个种类可以共用一个目录（如「规则/」下的三种）。 */
export const kinds: Record<string, string> = Object.fromEntries(
  KINDS.filter((k) => k.folder !== '').map((k) => [k.kind, k.folder]),
);

/** 派生资料：必须有 sources，否则不能作为事实依据。 */
export const derivedKinds = new Set(KINDS.filter((k) => k.derived).map((k) => k.kind));

/** 由工具生成的种类，不接受直接创建。 */
export const generatedKinds = new Set(KINDS.filter((k) => k.generated).map((k) => k.kind));

/** 可由作者 confirm 的设定类内容。 */
export const confirmableKinds = new Set(KINDS.filter((k) => k.confirmable).map((k) => k.kind));

/** 立项文档的固定相对路径，按立项顺序排列。 */
export const FOUNDING: readonly { kind: string; path: string }[] = [
  { kind: 'style', path: '设定/文风.md' },
  { kind: 'background', path: '设定/背景.md' },
  { kind: 'world', path: '设定/世界观.md' },
  { kind: 'rules', path: '规则/世界规则.md' },
  { kind: 'outline', path: '大纲/全书大纲.md' },
];

/**
 * 顶层目录白名单。顶层字段来自 KINDS，因此新增种类时不可能忘记同步这里
 * ——这正是之前三处重复定义导致漂移的地方。
 */
export const AREAS: ReadonlySet<string> = new Set(
  [...KINDS.map((k) => k.folder), ...FOUNDING.map((f) => f.path.split('/').slice(0, -1).join('/'))]
    .map((folder) => folder.split('/')[0] ?? '')
    .filter((top) => top !== ''),
);

/** 根级的受管文件（不在任何目录下）。 */
export const ROOT_DOCS: ReadonlySet<string> = new Set(['创作约定.md']);

/** 章节两件套：方案 + 正文。方案先被批准，正文才能写。 */
export const PLAN_FILE = '方案.md';
export const BODY_FILE = '正文.md';

export const CHAPTER_FILES: readonly { file: string; kind: string }[] = [
  { file: PLAN_FILE, kind: 'chapter-plan' },
  { file: BODY_FILE, kind: 'chapter' },
];

export const CHAPTER_DIR = '章节';
export const EXPORT_DIR = '导出';
export const PROJECT_META = '.novel/project.md';

/** 章节文件夹名：`0001-雨夜`。序号决定作品中的位置。 */
export function chapterFolderName(order: number, stem: string): string {
  return `${String(order).padStart(4, '0')}-${stem}`;
}

/** 从 `0001-雨夜` 取出序号。取不到时返回 0。 */
export function parseChapterFolder(name: string): number {
  const match = /^(\d+)-/.exec(name);
  return match?.[1] ? Number(match[1]) : 0;
}
