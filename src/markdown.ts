import { parseDocument, stringify } from 'yaml';
import { createHash } from 'node:crypto';

/**
 * 来源引用。
 *
 * **用稳定 id 而不是路径。** 这个插件的前端是 Obsidian，作者用 F2 重命名文件或把笔记
 * 拖到别的文件夹都是日常操作。如果来源记的是路径，每重命名一次，所有摘要、状态、
 * 审稿的 sources 全部失效，`diagnostics()` 会刷满「Stale/missing source」。
 *
 * 代价是 frontmatter 里看到的是 uuid，不可读。所以人读的来源写进正文：
 * `依据：[[章节/0001-雨夜/正文]]`；机器校验的放这里。
 */
export interface Source { id: string; revision: string }

export interface Meta {
  id: string;
  kind: string;
  title: string;
  status: string;
  /** 章节正文在作品中的位置。仅 chapter 使用。 */
  order?: number;
  sources?: Source[];
  refs?: string[];
  /** Obsidian 内置别名：让 [[老林]] 也能链到「人物/林默.md」。 */
  aliases?: string[];
  /** Obsidian 内置标签。 */
  tags?: string[];
  /** 章节方案被作者批准时方案文件的 revision；方案一改，批准即失效。 */
  approvedRevision?: string;
  /** 受保护正文被采纳/确认时的正文哈希，用于发现外部改动。 */
  canonicalBodyHash?: string;
  [key: string]: unknown;
}

export function hash(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

export function encode(meta: Record<string, unknown>, body: string): string {
  return `---\n${stringify(meta, { lineWidth: 0 })}---\n\n${body.trim()}\n`;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`Invalid ${field}`);
  return value;
}

function optionalStringArray(value: unknown, field: string): void {
  if (value === undefined) return;
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) throw new Error(`Invalid ${field}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

const SHA256 = /^[a-f0-9]{64}$/;

function checkSources(sources: unknown): void {
  if (sources === undefined) return;
  if (!Array.isArray(sources)) throw new Error('Invalid sources');
  for (const item of sources) {
    if (!isRecord(item)) throw new Error('Invalid sources');
    if (typeof item.revision !== 'string' || !SHA256.test(item.revision)) {
      throw new Error('Invalid sources: revision 必须是 sha256');
    }
    // 只接受稳定编号。路径形式的来源会被明确拒绝——
    // 作者会在 Obsidian 里重命名文件，路径引用必然失效。
    if (typeof item.id === 'string' && item.id.trim()) continue;
    throw new Error('Invalid sources: 每一项都需要稳定 id（不是路径）');
  }
}

export function decode(text: string): { meta: Meta; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  if (!match) throw new Error('Missing Markdown YAML frontmatter');
  const doc = parseDocument(match[1]);
  if (doc.errors.length) throw new Error(doc.errors.map((e) => e.message).join('; '));
  const value = doc.toJS({ maxAliasCount: 10 });
  if (!isRecord(value)) throw new Error('Invalid metadata');

  for (const key of ['id', 'kind', 'title', 'status']) requireString(value[key], key);

  checkSources(value.sources);
  optionalStringArray(value.refs, 'refs');
  optionalStringArray(value.aliases, 'aliases');
  optionalStringArray(value.tags, 'tags');
  const order = value.order;
  if (order !== undefined && (typeof order !== 'number' || !Number.isSafeInteger(order) || order < 1)) {
    throw new Error('Invalid chapter order');
  }
  if (value.approvedRevision !== undefined && (typeof value.approvedRevision !== 'string' || !SHA256.test(value.approvedRevision))) {
    throw new Error('Invalid approvedRevision');
  }
  if (value.canonicalBodyHash !== undefined && (typeof value.canonicalBodyHash !== 'string' || !SHA256.test(value.canonicalBodyHash))) {
    throw new Error('Invalid canonicalBodyHash');
  }

  return { meta: value as Meta, body: text.slice(match[0].length).trim() };
}
