import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { truncateHead, withFileMutationQueue } from '@earendil-works/pi-coding-agent';
import { StringEnum } from '@earendil-works/pi-ai';
import { Type } from 'typebox';
import path from 'node:path';
import * as fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { Project, initProject, kinds } from './project.ts';
import { discover, locked, rollback, transactionFiles } from './storage.ts';

const sourceSchema = Type.Object({ path: Type.String(), revision: Type.String() });
const help = `# pi-novel\n\n/novel init <目录> | <书名> — 新建空目录中的小说\n/novel open <目录> — 本会话打开小说\n/novel status — 章节、状态和进度\n/novel new <标题> — 新建章节\n/novel create <类型> <名称> — 新建设定\n/novel write|polish|review|plan <要求> — 调用内置创作 Skill\n/novel check — 引用、来源版本和结构检查\n/novel accept|publish|confirm|reopen <相对文件路径> — 作者确认状态变更\n/novel reorder <按顺序排列的全部章节 ID>\n/novel history — 事务记录\n/novel recover <事务 ID> — 回滚（遇到外部修改则拒绝）\n/novel export — 导出已接受/发布章节为 Markdown\n/novel close — 关闭本会话管理保护\n\n类型：${Object.keys(kinds).join(', ')}\n\n自然语言也可以创作和管理；接受正文、确认设定、恢复版本需要作者命令。`;
export function output(text: string) {
  const t = truncateHead(text, { maxBytes: 40000, maxLines: 1000 });
  return { content: [{ type: 'text' as const, text: t.content + (t.truncated ? '\n[输出已截断；请使用分页或缩小查询范围，不要把截断内容写回文件。]' : '') }], details: {} };
}
// Guard is deliberately allowlist-based: unknown tool implementations may write via arbitrary APIs.
export const readOnlyTools = new Set(['read', 'grep', 'find', 'ls']);
export function allowedTool(name: string): boolean {
  return readOnlyTools.has(name) || ['novel_catalog','novel_read','novel_create','novel_write','novel_patch','novel_rename','novel_summary','novel_context','novel_check'].includes(name);
}
export default function novelExtension(pi: ExtensionAPI) {
  let active: Project | undefined;
  const need = async (): Promise<Project> => {
    if (!active) throw new Error('No active novel. Use /novel init or /novel open.');
    await active.validate();
    return active;
  };
  const show = (text: string) => pi.sendMessage({ customType: 'pi-novel', content: text, display: true });
  const refresh = async (ctx: ExtensionContext) => {
    if (!ctx.hasUI) return;
    if (!active) { ctx.ui.setStatus('pi-novel', undefined); return; }
    try {
      const chapters = await active.chapters();
      const accepted = chapters.filter(d => !d.canonicalChanged && ['accepted', 'published'].includes(d.meta.status)).length;
      ctx.ui.setStatus('pi-novel', `小说 ${accepted}/${chapters.length} 章已接受`);
    } catch { ctx.ui.setStatus('pi-novel', '小说 · 需要检查'); }
  };
  // Built-in writes are blocked while active. This queue additionally coordinates project tools.
  const mutate = async <T>(p: Project, signal: AbortSignal | undefined, work: () => Promise<T>): Promise<T> => {
    return withFileMutationQueue(path.join(p.root, '.novel/project.md'), async () => {
      signal?.throwIfAborted();
      return work();
    });
  };
  pi.on('session_start', async (_event, ctx) => {
    active = undefined;
    const root = await discover(ctx.cwd);
    if (root) { active = new Project(root); await active.validate(); }
    await refresh(ctx);
  });
  pi.on('tool_call', async event => {
    if (active && !allowedTool(event.toolName)) return { block: true, reason: 'pi-novel managed session: use novel_* tools. Arbitrary shell/write/edit/other extension tools are blocked. The author can /novel close to leave managed mode.' };
  });
  pi.on('before_agent_start', async event => {
    if (!active) return;
    await active.validate();
    return { systemPrompt: event.systemPrompt + '\n\npi-novel is managing a Markdown novel. Load the novel-manager skill before creative work. Use novel_catalog/read/context before changes and novel_write with exact revision for edits. All paths are relative to the active project, not necessarily cwd. Do not bypass managed tools. Draft/planned information is not canon. Never claim author acceptance; author-only /novel commands control acceptance. No subagents unless the user explicitly requests delegation.' };
  });
  pi.on('agent_end', async (_e, ctx) => { await refresh(ctx); });

  pi.registerTool({
    name: 'novel_catalog', label: '小说资料目录',
    description: 'List/search managed Markdown by literal query across title/body/ID/path; paginated, no full bodies. Read selected files with novel_read. kind optional. Paths are relative to active novel.',
    parameters: Type.Object({ query: Type.Optional(Type.String()), kind: Type.Optional(Type.String()), offset: Type.Optional(Type.Integer({ minimum: 0 })), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })) }),
    async execute(_id, args) {
      const p = await need(); const query = (args.query ?? '').toLowerCase();
      const docs = (await p.documents()).filter(d => (!args.kind || d.meta.kind === args.kind) && `${d.path} ${d.meta.title} ${d.meta.id} ${d.body}`.toLowerCase().includes(query));
      const offset = args.offset ?? 0, end = offset + (args.limit ?? 30);
      return output(JSON.stringify({ root: p.root, total: docs.length, nextOffset: end < docs.length ? end : null, documents: docs.slice(offset, end).map(d => ({ path: d.path, ...d.meta, revision: d.revision, canonicalChanged: d.canonicalChanged })) }, null, 2));
    },
  });
  pi.registerTool({
    name: 'novel_read', label: '读取小说文档',
    description: 'Read Markdown BODY with metadata and revision. offset is 1-based body line; continue until nextOffset=null before replacing the full body. Max 200 lines/30KB per page; long single lines are returned with a clear truncation error.',
    parameters: Type.Object({ path: Type.String(), offset: Type.Optional(Type.Integer({ minimum: 1 })), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })) }),
    async execute(_id, args) {
      const d = await (await need()).read(args.path); const lines = d.body.split('\n'); const start = (args.offset ?? 1) - 1;
      let end = start; let bytes = 0;
      while (end < lines.length && end < start + (args.limit ?? 100)) {
        const size = Buffer.byteLength(lines[end]) + 1;
        if (size > 30000) throw new Error(`Body line ${end + 1} exceeds 30KB. Split it with your editor before using managed replacement.`);
        if (bytes + size > 30000) break;
        bytes += size; end++;
      }
      return output(JSON.stringify({ path: d.path, meta: d.meta, revision: d.revision, canonicalChanged: d.canonicalChanged, totalLines: lines.length, nextOffset: end < lines.length ? end + 1 : null, body: lines.slice(start, end).join('\n') }, null, 2));
    },
  });
  pi.registerTool({
    name: 'novel_create', label: '创建小说资料',
    description: 'Create chapter+plan or a template-backed setting/continuity/review document. No prose is fabricated. Derived records require source path+revision from novel_read. refs are stable IDs.',
    parameters: Type.Object({ kind: StringEnum(['chapter', ...Object.keys(kinds)]), title: Type.String(), refs: Type.Optional(Type.Array(Type.String())), sources: Type.Optional(Type.Array(sourceSchema)) }),
    async execute(_id, args, signal) {
      const p = await need();
      return output(JSON.stringify(await mutate(p, signal, () => args.kind === 'chapter' ? p.newChapter(args.title) : p.create(args.kind, args.title, args.refs, args.sources))));
    },
  });
  pi.registerTool({
    name: 'novel_write', label: '保存小说文档',
    description: 'Replace ONLY the full Markdown body of an existing draft. Read all pages first. expectedRevision is mandatory. Plugin preserves ID/kind/title/order/status. Optional refs/sources replace those lists. Protected canon requires an author reopen command or a proposal. Returns backup transaction ID.',
    parameters: Type.Object({ path: Type.String(), expectedRevision: Type.String(), body: Type.String(), refs: Type.Optional(Type.Array(Type.String())), sources: Type.Optional(Type.Array(sourceSchema)) }),
    async execute(_id, args, signal) {
      const p = await need(); const transaction = await mutate(p, signal, () => p.write(args.path, args.expectedRevision, args.body, args.refs, args.sources));
      return output(JSON.stringify({ transaction, path: args.path, revision: (await p.read(args.path)).revision }));
    },
  });
  pi.registerTool({
    name: 'novel_patch', label: '局部修改小说',
    description: 'Apply unique non-overlapping exact body replacements against expectedRevision. Does not alter metadata. Prefer for localized polishing.',
    parameters: Type.Object({ path: Type.String(), expectedRevision: Type.String(), edits: Type.Array(Type.Object({ oldText: Type.String(), newText: Type.String() }), { minItems: 1 }) }),
    async execute(_id, args, signal) {
      const p = await need();
      return output(await mutate(p, signal, () => p.patch(args.path, args.expectedRevision, args.edits)));
    },
  });
  pi.registerTool({
    name: 'novel_rename', label: '修改文档标题',
    description: 'Change a draft metadata title without changing its stable ID, path or body. Update body headings separately if desired.',
    parameters: Type.Object({ path: Type.String(), expectedRevision: Type.String(), title: Type.String() }),
    async execute(_id, args, signal) {
      const p = await need();
      return output(await mutate(p, signal, () => p.rename(args.path, args.title, args.expectedRevision)));
    },
  });
  pi.registerTool({
    name: 'novel_summary', label: '保存章节摘要',
    description: 'Create/update a factual chapter summary grounded in the exact chapter revision read. expectedSummaryRevision must be new for creation or the current summary revision for updates. Summaries do not accept chapters or confirm new lore.',
    parameters: Type.Object({ chapterId: Type.String(), expectedChapterRevision: Type.String(), expectedSummaryRevision: Type.String(), body: Type.String() }),
    async execute(_id, args, signal) {
      const p = await need();
      return output(await mutate(p, signal, () => p.summary(args.chapterId, args.body, args.expectedChapterRevision, args.expectedSummaryRevision)));
    },
  });
  pi.registerTool({
    name: 'novel_context', label: '章节上下文清单',
    description: 'Return relevant file paths, not full contents; excludes future/stale derived state. Read files and select relevant lore through catalog. Long output truncated at 40KB/1000 lines: use catalog pagination to retrieve remaining records.',
    parameters: Type.Object({ chapterId: Type.String() }),
    async execute(_id, args) { return output(await (await need()).context(args.chapterId)); },
  });
  pi.registerTool({
    name: 'novel_check', label: '检查小说资料',
    description: 'Deterministic structure/reference/revision checks, not semantic plot validation. Paginated issues.',
    parameters: Type.Object({ offset: Type.Optional(Type.Integer({ minimum: 0 })) }),
    async execute(_id, args) {
      const issues = await (await need()).diagnostics(); const start = args.offset ?? 0;
      return output(JSON.stringify({ total: issues.length, issues: issues.slice(start, start + 100), nextOffset: start + 100 < issues.length ? start + 100 : null }));
    },
  });

  pi.registerCommand('novel', {
    description: '小说总管：项目、设定、章节、创作、审稿、版本恢复',
    getArgumentCompletions(prefix) {
      return ['init','open','status','new','create','write','polish','review','plan','check','accept','publish','confirm','reopen','reorder','history','recover','export','close','help'].filter(s => s.startsWith(prefix)).map(s => ({ value: s, label: s }));
    },
    async handler(args, ctx) {
      try {
        await ctx.waitForIdle();
        const match = /^(\S+)(?:\s+([\s\S]*))?$/.exec(args.trim());
        let command = match?.[1] ?? 'menu'; let rest = match?.[2]?.trim() ?? '';
        if (command === 'menu') {
          if (!ctx.hasUI) { show(help); return; }
          const choice = await ctx.ui.select('小说总管', ['status · 进度','write · 创作','polish · 润色','review · 审稿','plan · 规划','check · 检查','help · 帮助']);
          if (!choice) return;
          command = choice.split(' ')[0];
        }
        if (command === 'help') { show(help); return; }
        if (command === 'close') { active = undefined; await refresh(ctx); show('已关闭小说管理保护。'); return; }
        if (command === 'init') {
          const [directory, title] = rest.split('|').map(s => s.trim());
          if (!directory || !title) throw new Error('用法：/novel init <目录> | <书名>');
          active = new Project(await initProject(path.resolve(ctx.cwd, directory), title));
          show(`已创建：${active.root}\n\n后续从该目录启动 Pi 可自动打开；先填写创作约定、世界观、规则、大纲和人物。`);
        } else if (command === 'open') {
          if (!rest) throw new Error('请提供项目目录');
          const candidate = new Project(await fs.realpath(path.resolve(ctx.cwd, rest)));
          await candidate.validate(); active = candidate; show(`已打开：${active.root}`);
        } else {
          const p = await need();
          if (['write','polish','review','plan'].includes(command)) {
            if (!rest && ctx.hasUI) rest = (await ctx.ui.input('创作要求', '例如：写下一章；润色指定章节；完善人物关系')) ?? '';
            if (!rest) return;
            // Explicitly load the packaged skill even if skill auto-discovery is disabled.
            const skill = await fs.readFile(fileURLToPath(new URL('../skills/novel-manager/SKILL.md', import.meta.url)), 'utf8');
            pi.sendUserMessage(`${skill}\n\nSkill directory: ${fileURLToPath(new URL('../skills/novel-manager/', import.meta.url))}\nActive novel root: ${p.root}\nMode: ${command}\nUser request: ${rest}`);
          } else if (command === 'status') {
            const chapters = await p.chapters();
            show(`# 小说进度\n\n${p.root}\n\n${chapters.map(d => `- ${d.meta.order}. ${d.meta.title} [${d.canonicalChanged ? '外部修改待确认' : d.meta.status}] · ${d.body.replace(/\s/g, '').length} 非空白字符\n  ${d.path}`).join('\n') || '尚无章节。使用 /novel new 标题'}\n\n字数为含标题的非空白字符统计，不等于出版字数。`);
          } else if (command === 'new') show(JSON.stringify(await mutate(p, undefined, () => p.newChapter(rest))));
          else if (command === 'create') {
            const space = rest.indexOf(' ');
            if (space < 0) throw new Error('用法：/novel create character 人物名称；带来源的记录请通过自然语言创建');
            show(JSON.stringify(await mutate(p, undefined, () => p.create(rest.slice(0, space), rest.slice(space + 1)))));
          } else if (command === 'check') show((await p.diagnostics()).join('\n') || '结构、引用和来源版本检查通过；这不代表剧情逻辑已经审查。');
          else if (['accept','publish','confirm','reopen'].includes(command)) {
            if (!ctx.hasUI) throw new Error('状态变更需要交互确认，请在 Pi 交互模式使用此命令。');
            const d = await p.read(rest);
            if (!await ctx.ui.confirm('确认状态变更', `${command}: ${d.meta.title}\n${rest}\n请先阅读正文。此操作保留可恢复记录。`)) return;
            show(await mutate(p, undefined, () => p.transition(rest, command as 'accept' | 'publish' | 'confirm' | 'reopen', d.revision)));
          } else if (command === 'reorder') {
            if (!ctx.hasUI || !await ctx.ui.confirm('调整章节顺序', '此操作会使受影响章节的摘要和连续性记录需要复核。继续？')) return;
            show(await mutate(p, undefined, () => p.reorder(rest.split(/\s+/))));
          } else if (command === 'history') show((await transactionFiles(p.root)).join('\n') || '暂无变更记录');
          else if (command === 'recover') {
            if (!ctx.hasUI || !await ctx.ui.confirm('恢复旧版本', `回滚事务 ${rest}？有后续或外部修改时将拒绝恢复。`)) return;
            await mutate(p, undefined, () => locked(p.root, () => rollback(p.root, rest))); show('已恢复。请运行 /novel check。');
          } else if (command === 'export') show(JSON.stringify(await mutate(p, undefined, () => p.exportBook())));
          else throw new Error('未知命令；使用 /novel help');
        }
        await refresh(ctx);
      } catch (error) { show(`操作未完成：${error instanceof Error ? error.message : String(error)}`); }
    },
  });
}
