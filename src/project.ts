import * as fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { decode, encode, hash, type Meta, type Source } from './markdown.ts';
import { commit, contentPath, locked, pending, readOptional, safePath, type Change } from './storage.ts';

export const kinds: Record<string, string> = {
  character: 'lore/characters', location: 'lore/locations', faction: 'lore/factions',
  item: 'lore/items', concept: 'lore/concepts', relationship: 'lore/relationships',
  arc: 'outline/arcs', state: 'continuity/states', event: 'continuity/events',
  'relationship-state': 'continuity/relationships', thread: 'continuity/threads',
  review: 'reviews', idea: 'workspace/ideas', research: 'workspace/research', proposal: 'workspace/proposals',
};
export const derivedKinds = new Set(['summary', 'state', 'event', 'relationship-state', 'review']);
const protectedStates = new Set(['accepted', 'published', 'confirmed']);
export interface Document { path: string; meta: Meta; body: string; revision: string; raw: string; canonicalChanged: boolean }
export async function template(kind: string, title: string): Promise<string> {
  if (!/^[a-z-]+$/.test(kind)) throw new Error('Invalid template');
  return (await fs.readFile(fileURLToPath(new URL(`../templates/${kind}.md`, import.meta.url)), 'utf8')).replaceAll('{{title}}', title);
}
export async function initProject(directory: string, title: string): Promise<string> {
  title = title.trim();
  if (!title || /[\r\n]/.test(title)) throw new Error('A single-line title is required');
  // Dedicated empty directory only: never repurpose an existing project or overwrite author files.
  await fs.mkdir(directory, { recursive: true });
  const root = await fs.realpath(directory);
  if ((await fs.readdir(root)).length) throw new Error('Initialization requires an empty directory');
  const meta = (kind: string, name: string): Meta => ({ id: randomUUID(), kind, title: name, status: 'draft' });
  await fs.mkdir(path.join(root, '.novel'));
  await locked(root, async () => {
    // Staging is all Markdown and kept outside the final paths until ready.
    const stage = '.novel/setup';
    await fs.mkdir(path.join(root, stage));
    const files: Record<string, string> = {};
    for (const [name, kind, nameTitle] of [
      ['CREATOR.md', 'creator', title], ['setting/world.md', 'world', '世界观'],
      ['setting/rules.md', 'rules', '世界规则'], ['setting/style.md', 'style', '文风指南'],
      ['outline/main.md', 'outline', '全书大纲'],
    ]) files[name] = encode(meta(kind, nameTitle), await template(kind, nameTitle));
    files['AGENTS.md'] = '# 小说项目\n\n使用 pi-novel 的 novel_* 工具管理本书。创作前读取 novel-manager Skill。\n所有内容及管理记录均为 Markdown。不要通过 Bash/write/edit 绕过管理工具。\n草稿不是正史；采纳、发布和确认设定由作者通过 /novel 命令操作。\n';
    files['.novel/project.md'] = encode({ ...meta('project', title), format: 1 }, '# pi-novel project\n\n管理元数据；请勿手动修改格式版本。');
    for (const [name, text] of Object.entries(files)) {
      const target = path.join(root, stage, name);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, text, { flag: 'wx' });
    }
    // Marker last: an interrupted initialization is not mistaken for a healthy project.
    for (const name of Object.keys(files)) {
      const target = path.join(root, name);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.rename(path.join(root, stage, name), target);
    }
    await fs.rm(path.join(root, stage), { recursive: true });
  });
  return root;
}
export class Project {
  constructor(readonly root: string) {}
  async validate(): Promise<void> {
    const text = await readOptional(this.root, '.novel/project.md');
    if (!text) throw new Error('Not a pi-novel project');
    const { meta } = decode(text);
    if (meta.kind !== 'project' || meta.format !== 1) throw new Error('Unsupported project format; do not write');
  }
  async read(name: string): Promise<Document> {
    if (!contentPath(name)) throw new Error('Not a managed content path');
    const text = await readOptional(this.root, name);
    if (text === null) throw new Error(`Not found: ${name}`);
    const parsed = decode(text);
    return { path: name, ...parsed, revision: hash(text), raw: text, canonicalChanged: protectedStates.has(parsed.meta.status) && parsed.meta.canonicalBodyHash !== hash(parsed.body) };
  }
  async paths(): Promise<string[]> {
    const result: string[] = [];
    const walk = async (prefix: string): Promise<void> => {
      const dir = prefix ? await safePath(this.root, prefix) : this.root;
      for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
        if (entry.name.startsWith('.')) continue;
        const name = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isSymbolicLink()) throw new Error(`Symlink in project: ${name}`);
        if (entry.isDirectory()) {
          if (prefix || Object.values(kinds).some(p => p.startsWith(name + '/')) || ['setting', 'outline', 'chapters', 'continuity', 'workspace', 'exports'].includes(name)) await walk(name);
        } else if (contentPath(name)) result.push(name);
      }
    };
    await walk('');
    return result.sort();
  }
  async documents(): Promise<Document[]> {
    return Promise.all((await this.paths()).map(name => this.read(name)));
  }
  async chapters(): Promise<Document[]> {
    const chapters = (await this.documents()).filter(d => d.meta.kind === 'chapter');
    if (chapters.some(d => !Number.isSafeInteger(d.meta.order))) throw new Error('Missing chapter order');
    if (new Set(chapters.map(d => d.meta.order)).size !== chapters.length) throw new Error('Duplicate chapter order');
    return chapters.sort((a, b) => a.meta.order! - b.meta.order!);
  }
  async chapter(id: string): Promise<Document> {
    const found = (await this.chapters()).find(d => d.meta.id === id);
    if (!found) throw new Error(`Unknown chapter: ${id}`);
    return found;
  }
  async sources(names: string[]): Promise<Source[]> {
    return Promise.all([...new Set(names)].map(async name => ({ path: name, revision: (await this.read(name)).revision })));
  }
  async mutate<T>(work: () => Promise<T>): Promise<T> {
    await this.validate();
    return locked(this.root, async () => {
      if ((await pending(this.root)).length) throw new Error('Unfinished transaction; use /novel recover ID');
      return work();
    });
  }
  async create(kind: string, title: string, refs: string[] = [], sources: Source[] = []): Promise<{ path: string; transaction: string }> {
    if (!kinds[kind]) throw new Error(`Unknown kind. Choose ${Object.keys(kinds).join(', ')}`);
    if (!title.trim() || /[\r\n]/.test(title)) throw new Error('Single-line title required');
    return this.mutate(async () => {
      await this.checkLinks(refs, sources);
      if (derivedKinds.has(kind) && !sources.length) throw new Error('Derived records require source revisions');
      const id = `${kind}-${randomUUID()}`;
      const name = `${kinds[kind]}/${id}.md`;
      const after = encode({ id, kind, title, status: 'draft', refs, sources }, await template(kind, title));
      return { path: name, transaction: await commit(this.root, [{ path: name, before: null, after }], `Create ${kind}`) };
    });
  }
  async newChapter(title: string): Promise<{ id: string; path: string; transaction: string }> {
    if (!title.trim() || /[\r\n]/.test(title)) throw new Error('Single-line title required');
    return this.mutate(async () => {
      const list = await this.chapters();
      const id = `ch-${randomUUID()}`;
      const folder = `chapters/${id}`;
      const changes: Change[] = [];
      for (const [file, kind] of [['text', 'chapter'], ['plan', 'plan']]) {
        changes.push({ path: `${folder}/${file}.md`, before: null, after: encode({ id: file === 'text' ? id : `${id}-plan`, kind, title, status: 'draft', ...(file === 'text' ? { order: list.length + 1 } : { refs: [id] }) }, await template(kind, title)) });
      }
      return { id, path: `${folder}/text.md`, transaction: await commit(this.root, changes, 'Create chapter and plan') };
    });
  }
  async checkLinks(refs: string[], sources: Source[]): Promise<void> {
    const docs = await this.documents();
    const ids = new Set(docs.map(d => d.meta.id));
    for (const id of refs) if (!ids.has(id)) throw new Error(`Unknown reference ID: ${id}`);
    for (const source of sources) if ((await this.read(source.path)).revision !== source.revision) throw new Error(`Stale source: ${source.path}`);
  }
  async write(name: string, expected: string, body: string, refs?: string[], sources?: Source[]): Promise<string> {
    return this.mutate(async () => {
      const current = await this.read(name);
      if (current.revision !== expected) throw new Error('Revision conflict; reread before editing');
      if (current.meta.status !== 'draft') throw new Error('Protected content: ask author to reopen it, or create a proposal');
      const metadata = { ...current.meta, refs: refs ?? current.meta.refs ?? [], sources: sources ?? current.meta.sources ?? [] };
      await this.checkLinks(metadata.refs, metadata.sources);
      if (derivedKinds.has(metadata.kind) && !metadata.sources.length) throw new Error('Derived record requires sources');
      return commit(this.root, [{ path: name, before: current.raw, after: encode(metadata, body) }], `Edit ${name}`);
    });
  }
  async patch(name: string, expected: string, edits: { oldText: string; newText: string }[]): Promise<string> {
    const doc = await this.read(name);
    if (doc.revision !== expected) throw new Error('Revision conflict');
    const spans = edits.map(e => {
      const start = doc.body.indexOf(e.oldText);
      if (!e.oldText || start < 0 || doc.body.indexOf(e.oldText, start + 1) >= 0) throw new Error('oldText must match exactly once');
      return { start, end: start + e.oldText.length, replacement: e.newText };
    }).sort((a, b) => a.start - b.start);
    if (!spans.length || spans.some((s, i) => i > 0 && s.start < spans[i - 1].end)) throw new Error('Empty or overlapping edits');
    let body = doc.body;
    for (const span of spans.reverse()) body = body.slice(0, span.start) + span.replacement + body.slice(span.end);
    return this.write(name, expected, body);
  }
  async rename(name: string, title: string, expected: string): Promise<string> {
    if (!title.trim() || /[\r\n]/.test(title)) throw new Error('Single-line title required');
    return this.mutate(async () => {
      const doc = await this.read(name);
      if (doc.revision !== expected || doc.meta.status !== 'draft') throw new Error('Reread and reopen before renaming');
      return commit(this.root, [{ path: name, before: doc.raw, after: encode({ ...doc.meta, title }, doc.body) }], 'Rename document (body unchanged)');
    });
  }
  async summary(id: string, body: string, expectedChapter: string, expectedSummary = 'new'): Promise<string> {
    return this.mutate(async () => {
      const chapter = await this.chapter(id);
      if (chapter.revision !== expectedChapter) throw new Error('Chapter changed; reread before summarizing');
      const name = chapter.path.replace(/text\.md$/, 'summary.md');
      const before = await readOptional(this.root, name);
      if ((before === null ? 'new' : hash(before)) !== expectedSummary) throw new Error('Summary revision conflict; read the current summary or use new for creation');
      return commit(this.root, [{ path: name, before, after: encode({ id: `${id}-summary`, kind: 'summary', title: chapter.meta.title, status: 'draft', refs: [id], sources: [{ path: chapter.path, revision: chapter.revision }] }, body) }], 'Update chapter summary');
    });
  }
  async transition(name: string, action: 'accept' | 'publish' | 'confirm' | 'reopen', expected: string): Promise<string> {
    return this.mutate(async () => {
      const doc = await this.read(name);
      if (doc.revision !== expected) throw new Error('Content changed while awaiting confirmation');
      let status: string;
      if (action === 'reopen') {
        if (!protectedStates.has(doc.meta.status)) throw new Error('Content is not protected');
        status = 'draft';
      } else if (action === 'confirm') {
        if (!['character','location','faction','item','concept','relationship','world','rules','style','creator'].includes(doc.meta.kind) || doc.meta.status !== 'draft') throw new Error('Only draft setting documents can be confirmed');
        status = 'confirmed';
      } else {
        if (doc.meta.kind !== 'chapter') throw new Error('Chapter required');
        if (action === 'accept' && doc.meta.status !== 'draft') throw new Error('Only draft chapters can be accepted');
        if (action === 'publish' && doc.meta.status !== 'accepted') throw new Error('Accept before publishing');
        if (action === 'publish' && doc.meta.canonicalBodyHash !== hash(doc.body)) throw new Error('Accepted prose changed externally; reopen and accept it again');
        if (!doc.body.replace(/^#.*$/gm, '').replace(/<!--[\s\S]*?-->/g, '').trim()) throw new Error('Cannot accept empty prose');
        const summary = await this.read(doc.path.replace(/text\.md$/, 'summary.md'));
        if (!summary.body.replace(/^#.*$/gm, '').replace(/<!--[\s\S]*?-->/g, '').trim() || !summary.meta.sources?.some(s => s.path === name && s.revision === doc.revision)) throw new Error('Fresh chapter summary required');
        status = action === 'accept' ? 'accepted' : 'published';
      }
      const after = encode({ ...doc.meta, status, canonicalBodyHash: protectedStates.has(status) ? hash(doc.body) : undefined }, doc.body);
      const changes: Change[] = [{ path: name, before: doc.raw, after }];
      // A status-only transition does not change prose: rebind exact source revisions atomically.
      for (const dependent of await this.documents()) {
        if (dependent.meta.kind !== 'export' && dependent.path !== name && dependent.meta.sources?.some(s => s.path === name && s.revision === expected)) {
          changes.push({ path: dependent.path, before: dependent.raw, after: encode({ ...dependent.meta, sources: dependent.meta.sources.map(s => s.path === name && s.revision === expected ? { ...s, revision: hash(after) } : s) }, dependent.body) });
        }
      }
      return commit(this.root, changes, `${action}: ${doc.meta.title}`);
    });
  }
  async reorder(ids: string[]): Promise<string> {
    return this.mutate(async () => {
      const chapters = await this.chapters();
      if (ids.length !== chapters.length || new Set(ids).size !== ids.length || ids.some(id => !chapters.some(d => d.meta.id === id))) throw new Error('Supply every chapter ID exactly once');
      const changes = await Promise.all(ids.map(async (id, i) => {
        const d = chapters.find(c => c.meta.id === id)!;
        return { path: d.path, before: d.raw, after: encode({ ...d.meta, order: i + 1 }, d.body) };
      }));
      return commit(this.root, changes.filter(c => c.before !== c.after), 'Reorder chapters; recheck continuity');
    });
  }
  async diagnostics(): Promise<string[]> {
    const issues: string[] = [];
    const docs: Document[] = [];
    for (const name of await this.paths()) {
      try { docs.push(await this.read(name)); } catch (e) { issues.push(`${name}: ${String(e)}`); }
    }
    const ids = new Set<string>(); const paths = new Set<string>(); const orders = new Set<number>();
    for (const d of docs) {
      if (protectedStates.has(d.meta.status) && d.meta.canonicalBodyHash !== hash(d.body)) issues.push(`Protected content changed externally: ${d.path}; reopen and confirm/accept again`);
      if (ids.has(d.meta.id)) issues.push(`Duplicate ID: ${d.meta.id}`);
      ids.add(d.meta.id);
      if (paths.has(d.path.toLowerCase())) issues.push(`Case-insensitive path collision: ${d.path}`);
      paths.add(d.path.toLowerCase());
      if (d.meta.kind === 'chapter') {
        if (!d.meta.order || orders.has(d.meta.order)) issues.push(`Invalid/duplicate chapter order: ${d.path}`);
        orders.add(d.meta.order!);
        if (!docs.some(s => s.path === d.path.replace(/text\.md$/, 'summary.md'))) issues.push(`Missing summary: ${d.path}`);
      }
      for (const ref of d.meta.refs ?? []) if (!docs.some(other => other.meta.id === ref)) issues.push(`Broken reference ${ref}: ${d.path}`);
      for (const source of d.meta.sources ?? []) if (!docs.some(other => other.path === source.path && other.revision === source.revision)) issues.push(`Stale/missing source ${source.path}: ${d.path}`);
      if (derivedKinds.has(d.meta.kind) && !d.meta.sources?.length) issues.push(`Missing sources: ${d.path}`);
    }
    for (const p of await pending(this.root)) issues.push(`Unfinished transaction: ${p}`);
    return issues;
  }
  async context(id: string): Promise<string> {
    const chapter = await this.chapter(id);
    const docs = await this.documents();
    const prior = (await this.chapters()).filter(c => c.meta.order! < chapter.meta.order!);
    const priorPaths = new Set(prior.filter(c => protectedStates.has(c.meta.status) && c.meta.canonicalBodyHash === hash(c.body)).map(c => c.path));
    const rows = docs.filter(d => ['CREATOR.md','setting/world.md','setting/rules.md','setting/style.md','outline/main.md'].includes(d.path)
      || d.path === chapter.path.replace(/text\.md$/, 'plan.md')
      || prior.slice(-2).some(c => c.path === d.path)
      || (d.meta.sources?.length && d.meta.sources.every(s => priorPaths.has(s.path) && docs.some(x => x.path === s.path && x.revision === s.revision))))
      .map(d => `- ${d.path} [${d.canonicalChanged ? 'externally-changed; not verified canon' : d.meta.status}] ${d.meta.title}`);
    return `# ${chapter.meta.title} — context manifest\n\n${rows.join('\n')}\n\nRead relevant files with novel_read. This is a manifest, not their content. Draft predecessors are provisional. Use novel_catalog to select relevant lore, arcs, threads and relationships; they are not all injected. Sources at/after this chapter and stale derived records are excluded. Initial lore may contain author secrets; never equate author knowledge with character knowledge. Future plans are not established events.`;
  }
  async exportBook(): Promise<{ path: string; transaction: string }> {
    return this.mutate(async () => {
      const chapters = (await this.chapters()).filter(d => ['accepted','published'].includes(d.meta.status));
      if (!chapters.length) throw new Error('No accepted chapters to export');
      for (const chapter of chapters) {
        if (chapter.meta.canonicalBodyHash !== hash(chapter.body)) throw new Error(`Accepted prose changed externally: ${chapter.path}`);
        const summary = await this.read(chapter.path.replace(/text\.md$/, 'summary.md'));
        if (!summary.meta.sources?.some(s => s.path === chapter.path && s.revision === chapter.revision)) throw new Error(`Stale chapter summary: ${chapter.path}; reconcile before export`);
      }
      const name = `exports/book-${randomUUID()}.md`;
      const after = encode({ id: randomUUID(), kind: 'export', title: '小说正文', status: 'snapshot', sources: chapters.map(c => ({ path: c.path, revision: c.revision })) }, chapters.map(c => c.body).join('\n\n---\n\n'));
      return { path: name, transaction: await commit(this.root, [{ path: name, before: null, after }], 'Export accepted prose') };
    });
  }
}
