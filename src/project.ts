import * as fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { decode, encode, hash, type Meta, type Source } from './markdown.ts';
import { contentPath, commit, locked, pending, readOptional, safePath, type Change } from './storage.ts';
import { obsidianUnsafe, slugify, uniquePath } from './naming.ts';
import {
  AREAS,
  BODY_FILE,
  CHAPTER_DIR,
  CHAPTER_FILES,
  EXPORT_DIR,
  FOUNDING,
  PLAN_FILE,
  PROJECT_META,
  ROOT_DOCS,
  chapterFolderName,
  confirmableKinds,
  derivedKinds,
  generatedKinds,
  isKind,
  kindDef,
  kinds,
  labelOf,
  parseChapterFolder,
  templateNameOf,
} from './kinds.ts';

/** 当前支持的工作区格式版本。版本之间不兼容，也不做自动升级。 */
export const FORMAT = 2;

const folderOf = (p: string) => p.split('/').slice(0, -1).join('/');
const basenameOf = (p: string) => p.slice(p.lastIndexOf('/') + 1);

/** 三个受保护状态。进入之后正文不可再写，必须先 reopen。 */
const protectedStates = new Set(['accepted', 'published', 'confirmed']);

/** 章节三件套只能由 newChapter 创建，保证三者成对存在。 */
const CHAPTER_KINDS = new Set(CHAPTER_FILES.map((f) => f.kind));

export interface Document {
  path: string;
  meta: Meta;
  body: string;
  revision: string;
  raw: string;
  canonicalChanged: boolean;
}

export interface InitReport {
  root: string;
  /** 本次新建的骨架文件。 */
  created: string[];
  /** 已经存在的受管文档，直接沿用（身份在各自 frontmatter 里，不需要登记）。 */
  adopted: string[];
  /** 没有 frontmatter 的 Markdown，需要作者决定是否 adopt。 */
  unmanaged: string[];
  /** 看见了但不管的文件（图片、附件、符号链接等）。 */
  ignored: string[];
}

export { kinds, labelOf };

export async function template(kind: string, title: string): Promise<string> {
  const name = templateNameOf(kind);
  if (!/^[a-z][a-z0-9-]*$/.test(name)) throw new Error(`Invalid template: ${name}`);
  return (await fs.readFile(fileURLToPath(new URL(`../templates/${name}.md`, import.meta.url)), 'utf8')).replaceAll('{{title}}', title);
}

const skeleton = (kind: string, title: string): Promise<string> => template(kind, title);

async function listing(dir: string): Promise<string[]> {
  try {
    return await fs.readdir(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

/** 递归收集用于 init 报告的文件分类。不写入任何东西，只观察。 */
async function survey(root: string): Promise<{ adopted: string[]; unmanaged: string[]; ignored: string[] }> {
  const adopted: string[] = [];
  const unmanaged: string[] = [];
  const ignored: string[] = [];

  const visit = async (prefix: string): Promise<void> => {
    const dir = prefix ? path.join(root, prefix) : root;
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const name = prefix ? `${prefix}/${entry.name}` : entry.name;
      // .obsidian/ 和 .novel/ 一律不管：前者是 Obsidian 的，后者是我们自己的。
      if (entry.name.startsWith('.')) continue;
      if (entry.isSymbolicLink()) { ignored.push(`${name}（符号链接）`); continue; }
      if (entry.isDirectory()) { await visit(name); continue; }
      if (!entry.isFile() || !name.endsWith('.md')) { ignored.push(name); continue; }
      const text = await fs.readFile(path.join(root, name), 'utf8').catch(() => null);
      if (text === null) { ignored.push(name); continue; }
      try {
        decode(text);
        adopted.push(name);
      } catch {
        unmanaged.push(name);
      }
    }
  };

  await visit('');
  return { adopted: adopted.sort(), unmanaged: unmanaged.sort(), ignored: ignored.sort() };
}

/**
 * 在任意文件夹里激活一个小说项目。
 *
 * 与改造前的区别：**不再要求空目录**。这个插件的前端是 Obsidian，作者的文件夹里
 * 通常已经有 `.obsidian/`、附件和随手记的草稿。这些都不该成为激活的障碍，
 * 但也绝不能被覆盖 —— 所以骨架文件一律用 `wx` 新建，已存在就跳过。
 */
export async function initProject(directory: string, requestedTitle?: string): Promise<InitReport> {
  await fs.mkdir(directory, { recursive: true });
  const root = await fs.realpath(directory);
  const title = (requestedTitle ?? path.basename(root)).trim();
  if (!title || /[\r\n]/.test(title)) throw new Error('书名必须是单行非空文本');

  const existingMeta = await readOptional(root, PROJECT_META);
  if (existingMeta) {
    const { meta } = decode(existingMeta);
    throw new Error(`这里已经是一个 pi-novel 项目（format ${meta.format ?? '?'}），不要重复初始化。`);
  }

  const before = await survey(root);
  const created: string[] = [];

  // locked() 要在 .novel/ 下建锁目录，所以必须先把它建出来。
  await fs.mkdir(path.join(root, '.novel'), { recursive: true });

  await locked(root, async () => {
    const write = async (name: string, text: string): Promise<void> => {
      const target = await safePath(root, name);
      await fs.mkdir(path.dirname(target), { recursive: true });
      try {
        await fs.writeFile(target, text, { flag: 'wx' });
        created.push(name);
      } catch (error) {
        // 作者已有的同名文件：保留原样，不覆盖。
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
    };

    const meta = (kind: string, name: string): Meta => ({ id: randomUUID(), kind, title: name, status: 'draft' });

    // 创作约定 + 立项五件套。按立项顺序生成，作者打开就能从文风开始填。
    const founding: [string, string, string][] = [
      ['创作约定.md', 'creator', title],
      ...FOUNDING.map((f) => [f.path, f.kind, kindDef(f.kind).label] as [string, string, string]),
    ];
    for (const [name, kind, nameTitle] of founding) {
      await write(name, encode(meta(kind, nameTitle), await skeleton(kind, nameTitle)));
    }

    await write('AGENTS.md', agentsTemplate(title));
    await write('.gitignore', '# Obsidian 的工作区配置：各人不同，不入库\n.obsidian/workspace.json\n.obsidian/workspace-mobile.json\n\n# 未完成的事务\n.novel/pending/\n.novel/lock/\n');
    // 标记文件最后写：中途失败不会被误认为健康项目。
    await write(PROJECT_META, encode({ ...meta('project', title), format: FORMAT }, '# pi-novel 项目\n\n这里只记录格式版本；小说内容与元数据都在各自的 Markdown 里。\n'));
  });

  return { root, created, ...before };
}

/** 把作者手写的裸 Markdown 纳入受管体系。 */
export async function adoptDocument(
  project: Project,
  name: string,
  kind: string,
  title?: string,
): Promise<{ path: string; id: string; transaction: string }> {
  if (!isKind(kind)) throw new Error(`未知种类：${kind}`);
  if (derivedKinds.has(kind)) throw new Error(`${labelOf(kind)} 属于派生资料，必须绑定来源版本，不能直接收编；请用 novel_create 并给出来源。`);
  const raw = await readOptional(project.root, name);
  if (raw === null) throw new Error(`找不到文件：${name}`);
  try {
    decode(raw);
    throw new Error(`${name} 已经有 frontmatter 了，不需要收编。`);
  } catch (error) {
    // 只有「缺 frontmatter」这一种情况才继续；其他解析错误原样抛出。
    if (!/Missing Markdown YAML frontmatter/.test(String(error))) throw error;
  }

  const name_title = (title ?? basenameOf(name).replace(/\.md$/, '')).trim();
  if (!name_title || /[\r\n]/.test(name_title)) throw new Error('标题必须是单行非空文本');

  return project.mutate(async () => {
    const id = randomUUID();
    const after = encode({ id, kind, title: name_title, status: 'draft' }, raw);
    const changes: Change[] = [];
    // 已经在受管目录里的文件就地加 frontmatter；散落在别处的移到该种类的规范目录。
    const target = contentPath(name) ? name : await uniquePath(project.root, kindDef(kind).folder, slugify(name_title));
    if (target === name) {
      changes.push({ path: name, before: raw, after });
    } else {
      changes.push({ path: name, before: raw, after: null });
      changes.push({ path: target, before: null, after });
    }
    // 收编的整个意义就是把一个**不受管**的路径纳入管理，所以源路径必须放行受管检查。
    // 路径本身已经在上面经过 readOptional → safePath 校验。
    return { path: target, id, transaction: await commit(project.root, changes, `Adopt ${name}`, { allowUnmanaged: true }) };
  });
}

export class Project {
  constructor(readonly root: string) {}

  async validate(): Promise<void> {
    const text = await readOptional(this.root, PROJECT_META);
    if (!text) throw new Error('不是 pi-novel 项目');
    const { meta } = decode(text);
    if (meta.kind !== 'project') throw new Error('项目标记文件损坏');
    if (meta.format !== FORMAT) {
      throw new Error(
        meta.format !== FORMAT
          ? '这是旧版（format 1）项目：目录是英文的、引用记的是文件路径。当前版本只认识中文目录 + 编号引用，两者不兼容，因此拒绝写入以免损坏原稿。请新建一本重新开始，或继续用旧版插件。'
          : `不支持的格式 ${String(meta.format)}；当前版本只支持 ${FORMAT}。`,
      );
    }
  }

  async read(name: string): Promise<Document> {
    if (!contentPath(name)) throw new Error(`不是受管路径：${name}`);
    const text = await readOptional(this.root, name);
    if (text === null) throw new Error(`找不到：${name}`);
    const parsed = decode(text);
    return {
      path: name,
      ...parsed,
      revision: hash(text),
      raw: text,
      canonicalChanged: protectedStates.has(parsed.meta.status) && parsed.meta.canonicalBodyHash !== hash(parsed.body),
    };
  }

  /**
   * 列出全部受管文档。
   *
   * 顶层只进入 AREAS 里的目录（作者自己的 `我的素材/` 不会被误读），
   * 进入之后则一路向下，因此 `人物/主要角色/林默.md` 这类作者的分类是受支持的。
   */
  async paths(): Promise<string[]> {
    const result: string[] = [];
    const walk = async (prefix: string): Promise<void> => {
      const dir = prefix ? await safePath(this.root, prefix) : this.root;
      for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
        if (entry.name.startsWith('.')) continue;
        const name = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isSymbolicLink()) throw new Error(`项目里存在符号链接：${name}`);
        if (entry.isDirectory()) {
          if (prefix || AREAS.has(name)) await walk(name);
        } else if (entry.isFile() && name.endsWith('.md') && contentPath(name)) {
          result.push(name);
        }
      }
    };
    await walk('');
    return result.sort();
  }

  async documents(): Promise<Document[]> {
    const out: Document[] = [];
    for (const name of await this.paths()) {
      try {
        out.push(await this.read(name));
      } catch {
        // 作者往受管目录里丢了一个没有 frontmatter 的笔记是正常行为，
        // 不能因此让整次扫描崩掉。这些文件由 unmanaged() 与 diagnostics() 报告。
      }
    }
    return out;
  }

  /** 项目里所有 Markdown（跳过点目录与 AGENTS.md）。 */
  async allMarkdown(): Promise<string[]> {
    const out: string[] = [];
    const walk = async (prefix: string): Promise<void> => {
      const dir = prefix ? path.join(this.root, prefix) : this.root;
      for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
        if (entry.name.startsWith('.')) continue;
        const name = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) { await walk(name); continue; }
        if (entry.isFile() && name.endsWith('.md') && name !== 'AGENTS.md') out.push(name);
      }
    };
    await walk('');
    return out.sort();
  }

  /**
   * 作者手写、还没纳入管理的 Markdown。
   *
   * 对话式流程靠它发现「我写了个东西但忘了登记」。init 报告用的是同一个概念，
   * 所以这里和 init 的判断必须一致。
   */
  async unmanaged(): Promise<string[]> {
    const managed = new Set<string>();
    for (const name of await this.paths()) {
      try {
        await this.read(name);
        managed.add(name);
      } catch {
        // 解不开的就不是受管文档
      }
    }
    const all = await this.allMarkdown();
    return all.filter((name) => !managed.has(name));
  }

  /** id → 路径。sources/refs 都存 id，读的时候在这里解析。 */
  async index(): Promise<Map<string, Document>> {
    return new Map((await this.documents()).map((d) => [d.meta.id, d]));
  }

  async byId(id: string): Promise<Document> {
    const found = (await this.index()).get(id);
    if (!found) throw new Error(`找不到编号 ${id} 的文档`);
    return found;
  }

  async chapters(): Promise<Document[]> {
    const chapters = (await this.documents()).filter((d) => d.meta.kind === 'chapter');
    if (chapters.some((d) => !Number.isSafeInteger(d.meta.order))) throw new Error('有章节缺少 order');
    if (new Set(chapters.map((d) => d.meta.order)).size !== chapters.length) throw new Error('章节 order 重复');
    return chapters.sort((a, b) => a.meta.order! - b.meta.order!);
  }

  async chapter(id: string): Promise<Document> {
    const found = (await this.chapters()).find((d) => d.meta.id === id);
    if (!found) throw new Error(`未知章节：${id}`);
    return found;
  }

  /** 把编号列表解析成来源记录。sources 存 id，路径变化不影响它。 */
  async sources(ids: string[]): Promise<Source[]> {
    const index = await this.index();
    return [...new Set(ids)].map((id) => {
      const doc = index.get(id);
      if (!doc) throw new Error(`来源编号不存在：${id}`);
      return { id, revision: doc.revision };
    });
  }

  async mutate<T>(work: () => Promise<T>): Promise<T> {
    await this.validate();
    return locked(this.root, async () => {
      if ((await pending(this.root)).length) throw new Error('有未完成的事务；先让作者撤销它（novel_recover），再继续写入。');
      return work();
    });
  }

  async create(kind: string, title: string, refs: string[] = [], sources: Source[] = []): Promise<{ path: string; id: string; transaction: string }> {
    if (!isKind(kind)) throw new Error(`未知种类。可用：${Object.keys(kinds).join(', ')}`);
    if (generatedKinds.has(kind)) throw new Error(`${labelOf(kind)} 由工具生成（novel_export），不能直接创建`);
    if (CHAPTER_KINDS.has(kind)) throw new Error(`${labelOf(kind)} 属于章节三件套，请用 novel_new_chapter 创建，它保证三者成对存在`);
    if (!title.trim() || /[\r\n]/.test(title)) throw new Error('标题必须是单行非空文本');
    return this.mutate(async () => {
      await this.checkLinks(refs, sources);
      if (derivedKinds.has(kind) && !sources.length) throw new Error(`${labelOf(kind)} 属于派生资料，必须给出来源版本`);
      const id = randomUUID();
      const name = await uniquePath(this.root, kindDef(kind).folder, slugify(title));
      const after = encode({ id, kind, title, status: 'draft', refs, sources }, await template(kind, title));
      return { path: name, id, transaction: await commit(this.root, [{ path: name, before: null, after }], `Create ${kind}`) };
    });
  }

  /**
   * 新建一章：一次生成 方案 / 正文 两份文档。
   *
   * 方案必须被批准，正文才可写（见 write）。两份一起创建，
   * 让作者一眼看到「先填方案」这个流程。
   */
  async newChapter(title: string): Promise<{ id: string; path: string; folder: string; order: number; transaction: string }> {
    if (!title.trim() || /[\r\n]/.test(title)) throw new Error('标题必须是单行非空文本');
    return this.mutate(async () => {
      const list = await this.chapters();
      const id = randomUUID();
      const order = list.length ? Math.max(...list.map((d) => d.meta.order!)) + 1 : 1;
      const folder = `${CHAPTER_DIR}/${chapterFolderName(order, slugify(title))}`;
      const changes: Change[] = [];
      for (const { file, kind } of CHAPTER_FILES) {
        // 正文用裸 id：章节的身份就是它，planPath()/chapter() 都按这个 id 查找。
        // 方案带后缀，它是从属于这一章的独立文档。
        const docId = kind === 'chapter' ? id : `${id}-${templateNameOf(kind)}`;
        const refs = kind === 'chapter' ? [id] : [];
        const order_ = kind === 'chapter' ? { order } : {};
        changes.push({ path: `${folder}/${file}`, before: null, after: encode({ id: docId, kind, title, status: 'draft', refs, ...order_ }, await template(kind, title)) });
      }
      return { id, path: `${folder}/${BODY_FILE}`, folder, order, transaction: await commit(this.root, changes, 'Create chapter (plan/body)') };
    });
  }

  /** 章节方案文件的路径。 */
  async planPath(chapterId: string): Promise<string> {
    const chapter = await this.chapter(chapterId);
    return `${folderOf(chapter.path)}/${PLAN_FILE}`;
  }

  /**
   * 追加一轮方案。**只追加，不改动任何已有段落。**
   *
   * 作者的「要求」和「批注」段落因此在结构上不可能被模型覆盖 —— 模型只能往下加
   * `## 方案 vN`。同时把批准状态打回草稿：方案一改，之前的批准自动失效。
   */
  async propose(chapterId: string, body: string, expectedRevision: string): Promise<string> {
    const trimmed = body.trim();
    if (!trimmed) throw new Error('方案内容不能为空');
    return this.mutate(async () => {
      const planPath = await this.planPath(chapterId);
      const current = await this.read(planPath);
      if (current.revision !== expectedRevision) throw new Error('方案已被改动，请重新读取后再追加');
      if (current.meta.status !== 'draft') {
        throw new Error('方案处于已批准状态，正文写作已解锁。要修改方案，请先用 novel_authorize 请作者执行 reopen 撤回批准。');
      }
      const versions = [...current.body.matchAll(/^## 方案 v(\d+)/gm)].map((m) => Number(m[1]));
      const next = versions.length ? Math.max(...versions) + 1 : 1;
      const after = `${current.body.trimEnd()}\n\n## 方案 v${next}\n\n${trimmed}\n`;
      const meta = { ...current.meta, approvedRevision: undefined };
      return commit(this.root, [{ path: planPath, before: current.raw, after: encode(meta, after) }], `Propose plan v${next}`);
    });
  }

  /** 校验 refs 与 sources 都指向存在且版本一致的文档。 */
  async checkLinks(refs: string[], sources: Source[]): Promise<void> {
    const index = await this.index();
    for (const id of refs) if (!index.has(id)) throw new Error(`引用不存在：${id}`);
    for (const source of sources) {
      const target = index.get(source.id);
      if (!target) throw new Error(`来源不存在：${source.id}`);
      if (source.revision && target.revision !== source.revision) throw new Error(`来源已过期：${target.path}`);
    }
  }

  /** 写入前检查：正文必须先有被批准的方案。 */
  async assertBodyUnlocked(name: string, kind: string): Promise<void> {
    if (kind !== 'chapter' || !name.endsWith(`/${BODY_FILE}`)) return;
    const planPath = `${folderOf(name)}/${PLAN_FILE}`;
    const plan = await readOptional(this.root, planPath);
    if (plan === null) throw new Error(`本章缺少 ${PLAN_FILE}；请用 novel_new_chapter 重建，或手动补一份方案。`);
    const { meta, body } = decode(plan);
    if (meta.status !== 'confirmed') {
      throw new Error('本章方案尚未被作者批准，不能写正文。先调 novel_propose 产出方案，再用 novel_authorize 请作者批准。');
    }
    // 批准后作者仍在 Obsidian 里改了方案文字 -> 批准失效。
    if (meta.approvedRevision !== hash(body)) {
      throw new Error('方案在批准之后又被改动，批准已失效。请重新讨论方案，并请作者再次批准。');
    }
  }

  async write(name: string, expected: string, body: string, refs?: string[], sources?: Source[]): Promise<string> {
    return this.mutate(async () => {
      const current = await this.read(name);
      if (current.revision !== expected) throw new Error('版本冲突：请重新读取后再写入');
      if (current.meta.status !== 'draft') throw new Error('受保护内容：请作者先 reopen，或改用 proposal');
      await this.assertBodyUnlocked(name, current.meta.kind);
      const metadata = { ...current.meta, refs: refs ?? current.meta.refs ?? [], sources: sources ?? current.meta.sources ?? [] };
      await this.checkLinks(metadata.refs, metadata.sources);
      if (derivedKinds.has(metadata.kind) && !metadata.sources.length) throw new Error(`${labelOf(metadata.kind)} 必须绑定来源`);
      return commit(this.root, [{ path: name, before: current.raw, after: encode(metadata, body) }], `Edit ${name}`);
    });
  }

  async patch(name: string, expected: string, edits: { oldText: string; newText: string }[]): Promise<string> {
    const doc = await this.read(name);
    if (doc.revision !== expected) throw new Error('版本冲突');
    const spans = edits.map((e) => {
      const start = doc.body.indexOf(e.oldText);
      if (!e.oldText || start < 0 || doc.body.indexOf(e.oldText, start + 1) >= 0) throw new Error('oldText 必须在正文中恰好出现一次');
      return { start, end: start + e.oldText.length, replacement: e.newText };
    }).sort((a, b) => a.start - b.start);
    if (!spans.length || spans.some((s, i) => i > 0 && s.start < spans[i - 1]!.end)) throw new Error('修改为空或区间重叠');
    let body = doc.body;
    for (const span of spans.reverse()) body = body.slice(0, span.start) + span.replacement + body.slice(span.end);
    return this.write(name, expected, body);
  }

  async rename(name: string, title: string, expected: string): Promise<string> {
    if (!title.trim() || /[\r\n]/.test(title)) throw new Error('标题必须是单行非空文本');
    return this.mutate(async () => {
      const doc = await this.read(name);
      if (doc.revision !== expected || doc.meta.status !== 'draft') throw new Error('请重新读取并确认内容处于草稿状态');
      return commit(this.root, [{ path: name, before: doc.raw, after: encode({ ...doc.meta, title }, doc.body) }], 'Rename document (body unchanged)');
    });
  }

  async transition(name: string, action: 'accept' | 'publish' | 'confirm' | 'reopen', expected: string): Promise<string> {
    return this.mutate(async () => {
      const doc = await this.read(name);
      if (doc.revision !== expected) throw new Error('内容在等待确认期间发生了变化');
      let status: string;
      let approvedRevision: string | undefined;

      if (action === 'reopen') {
        if (!protectedStates.has(doc.meta.status)) throw new Error('该内容未被保护');
        status = 'draft';
      } else if (action === 'confirm') {
        if (!confirmableKinds.has(doc.meta.kind) || doc.meta.status !== 'draft') throw new Error('只有可确认种类的草稿能被执行 confirm');
        // 批准一份从未写过方案的模板是无意义的，因此在核心层也拦一道
        // （命令层已经检查过，这里是纵深防御）。
        if (doc.meta.kind === 'chapter-plan' && !doc.body.includes('## 方案 v')) {
          throw new Error('这份章节方案还没有任何内容，没什么可批准的');
        }
        status = 'confirmed';
        // 批准的对象是**方案内容**，不是那个带 status 的文件本身。
        // 存整文件哈希会立刻自我失效：批准这个动作本身就要改写 frontmatter。
        // 存正文哈希则恰好表达「作者批准的是这一版方案文字」。
        if (doc.meta.kind === 'chapter-plan') approvedRevision = hash(doc.body);
      } else {
        if (doc.meta.kind !== 'chapter') throw new Error('只有章节正文可以采纳或发布');
        if (action === 'accept' && doc.meta.status !== 'draft') throw new Error('只有草稿章节可以采纳');
        if (action === 'publish' && doc.meta.status !== 'accepted') throw new Error('先采纳，再发布');
        if (action === 'publish' && doc.meta.canonicalBodyHash !== hash(doc.body)) throw new Error('已采纳的正文被外部改动；请 reopen 后重新采纳');
        if (!doc.body.replace(/^#.*$/gm, '').replace(/<!--[\s\S]*?-->/g, '').trim()) throw new Error('正文为空，不能采纳');
        status = action === 'accept' ? 'accepted' : 'published';
      }

      const after = encode({ ...doc.meta, status, canonicalBodyHash: protectedStates.has(status) ? hash(doc.body) : undefined, ...(approvedRevision ? { approvedRevision } : {}) }, doc.body);
      const changes: Change[] = [{ path: name, before: doc.raw, after }];
      // 状态变更不改正文：在同一事务里把指向该精确版本的派生资料重绑，避免它们无故过期。
      for (const dependent of await this.documents()) {
        if (dependent.meta.kind === 'export' || dependent.path === name) continue;
        if (!dependent.meta.sources?.some((s) => s.id === doc.meta.id && s.revision === expected)) continue;
        const sources = dependent.meta.sources.map((s) => (s.id === doc.meta.id && s.revision === expected ? { id: s.id, revision: hash(after) } : s));
        changes.push({ path: dependent.path, before: dependent.raw, after: encode({ ...dependent.meta, sources }, dependent.body) });
      }
      return commit(this.root, changes, `${action}: ${doc.meta.title}`);
    });
  }

  /**
   * 重排章节顺序。
   *
   * 因为 `sources` 记的是编号而不是路径，移动文件**不会**让任何派生资料失效，
   * 所以这里只改文件夹名和正文的 order —— 改造前那套「迁移时重绑来源」的逻辑整块删掉了。
   */
  async reorder(ids: string[]): Promise<string> {
    return this.mutate(async () => {
      const chapters = await this.chapters();
      if (ids.length !== chapters.length || new Set(ids).size !== ids.length || ids.some((id) => !chapters.some((d) => d.meta.id === id))) {
        throw new Error('必须把每个章节编号恰好提供一次');
      }
      const byId = new Map(chapters.map((c) => [c.meta.id, c]));
      const occupied = new Set(chapters.map((c) => folderOf(c.path).toLowerCase()));

      // 目标目录名。交换两章时目标可能正被对方占用，此时加后缀让本次事务有落脚点：
      // commit 会拒绝同一事务里的重复路径，所以不能对同一路径既删又写，必须绕开。
      const targets = new Map<string, string>();
      for (let i = 0; i < ids.length; i++) {
        const doc = byId.get(ids[i]!)!;
        const stem = `${CHAPTER_DIR}/${chapterFolderName(i + 1, slugify(doc.meta.title))}`;
        let folder = stem;
        let n = 2;
        while (occupied.has(folder.toLowerCase()) && folderOf(doc.path).toLowerCase() !== folder.toLowerCase()) {
          folder = `${stem}-${n++}`;
        }
        targets.set(doc.meta.id, folder);
      }

      // 第一步：算出每个文件的原始内容与移后内容。正文的 order 跟着新位置走。
      interface Planned { from: string; to: string; original: string; moved: string }
      const planned: Planned[] = [];
      for (let i = 0; i < ids.length; i++) {
        const doc = byId.get(ids[i]!)!;
        const oldFolder = folderOf(doc.path);
        const newFolder = targets.get(doc.meta.id)!;
        for (const file of await listing(await safePath(this.root, oldFolder))) {
          if (!file.endsWith('.md')) continue;
          const from = `${oldFolder}/${file}`;
          const to = `${newFolder}/${file}`;
          const original = (await readOptional(this.root, from))!;
          const parsed = decode(original);
          const moved = file === BODY_FILE ? encode({ ...parsed.meta, order: i + 1 }, parsed.body) : original;
          planned.push({ from, to, original, moved });
        }
      }

      // 第二步：正文因 order 改写而内容变化 -> revision 变化。指向它的派生记录必须重绑，
      // 否则重排完立即变成「来源已过期」。
      //
      // 注意：真正破坏性的不是「路径变了」（来源存编号，路径无关），
      // 而是「内容变了」—— 这条区别很容易看漏。
      const shift = new Map<string, { from: string; to: string }>();
      for (const item of planned) {
        if (!item.to.endsWith(`/${BODY_FILE}`) || item.moved === item.original) continue;
        shift.set(decode(item.moved).meta.id, { from: hash(item.original), to: hash(item.moved) });
      }

      const rebind = (raw: string): string => {
        const parsed = decode(raw);
        if (!parsed.meta.sources?.length) return raw;
        let touched = false;
        const sources = parsed.meta.sources.map((s) => {
          const moved = shift.get(s.id);
          if (moved && moved.from === s.revision) { touched = true; return { id: s.id, revision: moved.to }; }
          return s;
        });
        return touched ? encode({ ...parsed.meta, sources }, parsed.body) : raw;
      };

      // 第三步：统一成变更集。被移动的文件和未被移动但来源需重绑的文件走同一条路径。
      const changes: Change[] = [];
      const handled = new Set<string>();
      for (const item of planned) {
        handled.add(item.from);
        const after = rebind(item.moved);
        if (item.from === item.to) {
          if (after !== item.original) changes.push({ path: item.from, before: item.original, after });
          continue;
        }
        changes.push({ path: item.from, before: item.original, after: null });
        changes.push({ path: item.to, before: null, after });
      }
      for (const doc of await this.documents()) {
        if (handled.has(doc.path)) continue;
        const after = rebind(doc.raw);
        if (after !== doc.raw) changes.push({ path: doc.path, before: doc.raw, after });
      }

      if (!changes.length) throw new Error('没有需要调整的章节');
      return commit(this.root, changes, 'Reorder chapters: folders renamed, body order updated, sources rebound');
    });
  }

  async diagnostics(): Promise<string[]> {
    const issues: string[] = [];
    const docs: Document[] = [];
    for (const name of await this.paths()) {
      try { docs.push(await this.read(name)); } catch (e) { issues.push(`${name}: ${String(e)}`); }
    }
    const ids = new Set<string>();
    const paths = new Set<string>();
    const orders = new Set<number>();
    const byId = new Map(docs.map((d) => [d.meta.id, d]));

    for (const d of docs) {
      if (protectedStates.has(d.meta.status) && d.meta.canonicalBodyHash !== hash(d.body)) {
        issues.push(`受保护内容被外部改动：${d.path}；请 reopen 后重新确认/采纳`);
      }
      // 种类被废弃后留下的文件。不报的话它们会一直静静地待在目录里、
      // 在 catalog 里以未知种类出现，而没人知道该拿它们怎么办。
      if (!isKind(d.meta.kind)) {
        issues.push(`种类已废弃（${d.meta.kind}）：${d.path}；可以删除它，或换个 kind 继续用`);
      }
      if (ids.has(d.meta.id)) issues.push(`编号重复：${d.meta.id}`);
      ids.add(d.meta.id);
      if (paths.has(d.path.toLowerCase())) issues.push(`路径大小写冲突：${d.path}`);
      paths.add(d.path.toLowerCase());
      if (obsidianUnsafe(basenameOf(d.path))) {
        issues.push(`文件名含 Obsidian 链接特殊字符（[ ] # ^ |），在 Obsidian 里无法被 [[链接]] 引用：${d.path}`);
      }

      if (d.meta.kind === 'chapter') {
        if (!d.meta.order || orders.has(d.meta.order)) issues.push(`章节 order 非法或重复：${d.path}`);
        orders.add(d.meta.order!);
        const folder = folderOf(d.path);
        const plan = docs.find((p) => p.path === `${folder}/${PLAN_FILE}`);
        if (!plan) issues.push(`缺少方案：${d.path}`);
        else if (plan.meta.status === 'confirmed' && plan.meta.approvedRevision !== hash(plan.body)) {
          issues.push(`方案在批准后被改动，批准已失效：${plan.path}`);
        }
      }

      for (const ref of d.meta.refs ?? []) if (!byId.has(ref)) issues.push(`引用悬空 ${ref}：${d.path}`);
      // 导出快照故意冻结当时的版本，它们是历史记录而不是漂移。
      if (d.meta.kind !== 'export') {
        for (const source of d.meta.sources ?? []) {
          const target = byId.get(source.id);
          if (!target) issues.push(`来源不存在 ${source.id}：${d.path}`);
          else if (target.revision !== source.revision) issues.push(`来源已过期 ${target.path}：${d.path}`);
        }
      }
      if (derivedKinds.has(d.meta.kind) && !d.meta.sources?.length) {
        // 空的派生文档是「还没填」，不是「缺溯源」——否则新建一节条章后 diagnostics 永远非零。
        const prose = d.body.replace(/^#.*$/gm, '').replace(/<!--[\s\S]*?-->/g, '').trim();
        if (prose) issues.push(`派生资料缺少来源：${d.path}`);
      }
    }

    // 立项进度不放在 diagnostics 里：那是「提示」，而 diagnostics 报告的是「故障」。
    // 混在一起会让「零问题」对一个刚开写的项目永远不可达。

    for (const p of await pending(this.root)) issues.push(`未完成的事务：${p}`);
    return issues;
  }

  /**
   * 立项进度。五项按 FOUNDING 的顺序（即立项顺序）返回，不硬拦写作，只供提示。
   * 文风排第一是因为它决定后面每一句话的写法。
   *
   * 「还没填」靠模板里的 `待填写` 标记判断。不能靠「剥掉标题和注释后还剩不剩字」——
   * 模板正文本身就是给作者的引导文字，那样判永远不为空。
   */
  async founding(): Promise<{ path: string; kind: string; label: string; state: 'missing' | 'empty' | 'draft' | 'confirmed' }[]> {
    const docs = await this.documents().catch(() => []);
    const byPath = new Map(docs.map((d) => [d.path, d]));
    return FOUNDING.map((f) => {
      const doc = byPath.get(f.path);
      const label = labelOf(f.kind);
      if (!doc) return { path: f.path, kind: f.kind, label, state: 'missing' as const };
      if (doc.body.includes('待填写')) return { path: f.path, kind: f.kind, label, state: 'empty' as const };
      return { path: f.path, kind: f.kind, label, state: doc.meta.status === 'confirmed' ? 'confirmed' as const : 'draft' as const };
    });
  }

  /**
   * 创作上下文清单。
   *
   * 立项五件套永远排在最前 —— 文风、背景、世界观、规则、大纲决定了后面的每一句话，
   * 顺序按 FOUNDING 的立项顺序，不是按路径字典序。
   */
  async context(id: string): Promise<string> {
    const chapter = await this.chapter(id);
    const docs = await this.documents();
    const byPath = new Map(docs.map((d) => [d.path, d]));
    const prior = (await this.chapters()).filter((c) => c.meta.order! < chapter.meta.order!);
    const priorIds = new Set(prior.filter((c) => protectedStates.has(c.meta.status) && c.meta.canonicalBodyHash === hash(c.body)).map((c) => c.meta.id));
    const folder = folderOf(chapter.path);

    const rows: string[] = [];
    const push = (d: Document, why: string): void => {
      const flag = d.canonicalChanged ? '外部改动，未验证' : d.meta.status;
      rows.push(`- ${d.path} [${flag}] ${d.meta.title} — ${why}`);
    };

    for (const f of FOUNDING) {
      const doc = byPath.get(f.path);
      if (doc) push(doc, '立项');
    }
    for (const extra of ['规则/写作规则.md', '规则/禁忌.md', '设定/体系.md']) {
      const doc = byPath.get(extra);
      if (doc) push(doc, '写作约束');
    }
    const plan = byPath.get(`${folder}/${PLAN_FILE}`);
    if (plan) push(plan, '本章方案');
    // 最近两章已定稿的前文
    for (const c of prior.slice(-2).reverse()) push(c, `前文（第 ${c.meta.order} 章）`);
    // 绑定了「本章之前已定稿章节」的派生资料
    for (const d of docs) {
      if (!d.meta.sources?.length) continue;
      if (d.meta.sources.every((s) => priorIds.has(s.id))) push(d, '既往事实');
    }
    push(chapter, '本章正文（当前草稿）');

    return [
      `# ${chapter.meta.title} — 创作上下文`,
      '',
      rows.join('\n'),
      '',
      '这只是路径清单，不是内容。请用 novel_read 逐份读取后再动笔。',
      '清单按立项顺序排列：文风、背景、世界观、规则、大纲决定后面每一句话的写法。',
      '草稿前文是临时的，不能当作已确立的事实。作者的秘密不等于人物知道的事。',
      '后续章节的 plans 不是已发生的事件。',
    ].join('\n');
  }

  async exportBook(): Promise<{ path: string; transaction: string }> {
    return this.mutate(async () => {
      const chapters = (await this.chapters()).filter((d) => ['accepted', 'published'].includes(d.meta.status));
      if (!chapters.length) throw new Error('没有已采纳的章节可以导出');
      for (const chapter of chapters) {
        if (chapter.meta.canonicalBodyHash !== hash(chapter.body)) throw new Error(`已采纳正文被外部改动：${chapter.path}`);
      }
      const now = new Date();
      const stamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}-${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}`;
      const projectRaw = await readOptional(this.root, PROJECT_META);
      const title = projectRaw ? decode(projectRaw).meta.title : 'novel';
      const name = await uniquePath(this.root, EXPORT_DIR, `${slugify(title)}-${stamp}`);
      const after = encode(
        { id: randomUUID(), kind: 'export', title: '小说正文', status: 'snapshot', sources: chapters.map((c) => ({ id: c.meta.id, revision: c.revision })) },
        chapters.map((c) => c.body).join('\n\n---\n\n'),
      );
      return { path: name, transaction: await commit(this.root, [{ path: name, before: null, after }], 'Export accepted prose') };
    });
  }
}

function agentsTemplate(title: string): string {
  return `# 《${title}》创作规则

这份文件是本书给 AI 的长期约定，在 Obsidian 里也可以直接编辑。

## 基本约定

- 只用 novel_* 工具读写内容，不要绕过它们直接改文件。
- 草稿不是正史。已采纳、已发布的正文和已确认的设定，需要作者退回草稿后才能改。
- 计划、灵感、提案都是想法，不是已经发生的事实。

## 写作流程

- 写正文之前必须先有方案，且方案要经作者批准（你发起 novel_authorize，作者点确认框）。
- 正文与人物用 [[双方括号]] 引用其他笔记，方便在 Obsidian 里跳转和看关系图谱。

## 本书特有要求

在这里写下这本书独有的规则，例如叙事视角、时间线约束、禁用的桥段。
`;
}

export { parseChapterFolder, ROOT_DOCS, CHAPTER_FILES, CHAPTER_DIR, AREAS };
