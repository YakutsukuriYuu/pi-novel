import { parseDocument, stringify } from 'yaml';
import { createHash } from 'node:crypto';

export interface Source { path: string; revision: string }
export interface Meta {
  id: string; kind: string; title: string; status: string;
  order?: number; sources?: Source[]; refs?: string[];
  [key: string]: unknown;
}
export function hash(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}
export function encode(meta: Record<string, unknown>, body: string): string {
  return `---\n${stringify(meta, { lineWidth: 0 })}---\n\n${body.trim()}\n`;
}
export function decode(text: string): { meta: Meta; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  if (!match) throw new Error('Missing Markdown YAML frontmatter');
  const doc = parseDocument(match[1]);
  if (doc.errors.length) throw new Error(doc.errors.map(e => e.message).join('; '));
  const value = doc.toJS({ maxAliasCount: 10 });
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid metadata');
  for (const key of ['id', 'kind', 'title', 'status']) {
    if (typeof value[key] !== 'string' || !value[key].trim()) throw new Error(`Invalid ${key}`);
  }
  if (value.sources !== undefined && (!Array.isArray(value.sources) || value.sources.some((s: Source) => !s || typeof s.path !== 'string' || !/^[a-f0-9]{64}$/.test(s.revision)))) throw new Error('Invalid sources');
  if (value.refs !== undefined && (!Array.isArray(value.refs) || value.refs.some((s: unknown) => typeof s !== 'string'))) throw new Error('Invalid refs');
  if (value.order !== undefined && (!Number.isSafeInteger(value.order) || value.order < 1)) throw new Error('Invalid chapter order');
  return { meta: value, body: text.slice(match[0].length).trim() };
}
