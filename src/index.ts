import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { truncateHead, withFileMutationQueue } from '@earendil-works/pi-coding-agent';
import { StringEnum } from '@earendil-works/pi-ai';
import { Type } from 'typebox';
import path from 'node:path';
import * as fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { Project, adoptDocument, initProject, kinds, labelOf } from './project.ts';
import { migrate, planMigration } from './migrate.ts';
import { FOUNDING, PLAN_FILE, chapterFolderName } from './kinds.ts';
import { discover, locked, rollback, transactionFiles } from './storage.ts';

const sourceSchema = Type.Object({ id: Type.String(), revision: Type.String() });

const help = `# pi-novel

前端用 Obsidian 读写，Pi 负责生成。所有内容都是普通 Markdown。

/novel init [书名] — 在当前文件夹激活项目（允许非空目录）
/novel adopt <路径> [--kind 种类] [--title 标题] — 把作者手写的笔记纳入管理
/novel setup — 引导式立项：文风 → 背景 → 世界观 → 规则 → 大纲
/novel status — 章节、状态和进度
/novel new <标题> — 新建章节（同时生成 方案/正文/摘要）
/novel approve <章节> — 批准本章方案，解锁正文写作
/novel create <种类> <名称> — 新建设定
/novel write|polish|review|plan <要求> — 调用内置创作 Skill
/novel check — 结构、引用、来源版本与立项进度检查
/novel accept|publish|confirm|reopen <相对路径> — 作者确认状态变更
/novel reorder <按顺序排列的全部章节 ID> — 重排章节
/novel history — 事务记录
/novel recover <事务 ID> — 回滚（遇到外部修改则拒绝）
/novel export — 导出已采纳章节
/novel migrate — 把 format 1 旧项目升级到当前格式
/novel close — 关闭本会话管理保护

种类：${Object.keys(kinds).join(', ')}

写正文前必须先有方案并被批准。接受正文、确认设定、恢复版本只能由作者执行。`;

export function output(text: string) {
  const t = truncateHead(text, { maxBytes: 40000, maxLines: 1000 });
  return {
    content: [{ type: 'text' as const, text: t.content + (t.truncated ? '\n[输出已截断；请使用分页或缩小查询范围，不要把截断内容写回文件。]' : '') }],
    details: {},
  };
}

// Guard is deliberately allowlist-based: unknown tool implementations may write via arbitrary APIs.
export const readOnlyTools = new Set(['read', 'grep', 'find', 'ls']);
export function allowedTool(name: string): boolean {
  return readOnlyTools.has(name) || [
    'novel_catalog', 'novel_read', 'novel_create', 'novel_new_chapter', 'novel_write',
    'novel_patch', 'novel_rename', 'novel_propose', 'novel_summary', 'novel_context', 'novel_check',
  ].includes(name);
}

export default function novelExtension(pi: ExtensionAPI) {
  let active: Project | undefined;
  const need = async (): Promise<Project> => {
    if (!active) throw new Error('没有打开的小说。先在小说文件夹里 /novel init，或从该目录启动 Pi。');
    await active.validate();
    return active;
  };
  const show = (text: string) => pi.sendMessage({ customType: 'pi-novel', content: text, display: true });

  const refresh = async (ctx: ExtensionContext) => {
    if (!ctx.hasUI) return;
    if (!active) { ctx.ui.setStatus('pi-novel', undefined); return; }
    try {
      const chapters = await active.chapters();
      const done = chapters.filter((d) => !d.canonicalChanged && ['accepted', 'published'].includes(d.meta.status)).length;
      ctx.ui.setStatus('pi-novel', `小说 ${done}/${chapters.length} 章已接受`);
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
    if (active && !allowedTool(event.toolName)) {
      return { block: true, reason: 'pi-novel managed session: use novel_* tools. Arbitrary shell/write/edit/other extension tools are blocked. The author can /novel close to leave managed mode.' };
    }
  });

  // The package manifest deliberately does not declare skills: novel-manager is injected only when a
  // project root is discoverable, so paper/code sessions never carry its description or trigger on it.
  pi.on('resources_discover', async event => {
    const root = await discover(event.cwd);
    if (!root) return;
    try { await new Project(root).validate(); } catch { return; }
    return { skillPaths: [fileURLToPath(new URL('../skills', import.meta.url))] };
  });

  pi.on('before_agent_start', async event => {
    if (!active) return;
    await active.validate();
    return {
      systemPrompt: event.systemPrompt + `

pi-novel is managing a Markdown novel whose front end is Obsidian. Load the novel-manager skill before creative work.

Workflow that must be respected:
- Before writing any chapter body, build a chapter plan with novel_propose, and wait for the author to run /novel approve. Writing 正文.md before approval is rejected by the tool.
- Start the project by settling 文风, 背景, 世界观, 规则, 大纲 with the author, in that order.

Rules:
- Use novel_catalog / novel_read / novel_context before every change; write with novel_write and the exact revision.
- All paths are relative to the active project, not necessarily cwd. Do not bypass managed tools.
- references (refs) and sources use stable document IDs, never paths. Renaming a file in Obsidian must not break anything.
- In prose, link other notes with [[双方括号]] so Obsidian's graph and backlinks work.
- Draft and planned information is not canon. Never claim author acceptance; author-only /novel commands control acceptance.
- No subagents unless the user explicitly requests delegation.`,
    };
  });

  pi.on('agent_end', async (_e, ctx) => { await refresh(ctx); });

  // ── 工具 ────────────────────────────────────────────────────────────

  pi.registerTool({
    name: 'novel_catalog', label: '小说资料目录',
    description: 'List/search managed Markdown by literal query across title/body/ID/path; paginated, no full bodies. Read selected files with novel_read. kind optional. Paths are relative to active novel.',
    parameters: Type.Object({
      query: Type.Optional(Type.String()),
      kind: Type.Optional(StringEnum(Object.keys(kinds))),
      offset: Type.Optional(Type.Integer({ minimum: 0 })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
    }),
    async execute(_id, args) {
      const p = await need();
      const query = (args.query ?? '').toLowerCase();
      const docs = (await p.documents()).filter(d =>
        (!args.kind || d.meta.kind === args.kind)
        && `${d.path} ${d.meta.title} ${d.meta.id} ${(d.meta.aliases ?? []).join(' ')} ${d.body}`.toLowerCase().includes(query));
      const offset = args.offset ?? 0, end = offset + (args.limit ?? 30);
      return output(JSON.stringify({
        root: p.root,
        total: docs.length,
        nextOffset: end < docs.length ? end : null,
        documents: docs.slice(offset, end).map(d => ({
          path: d.path, id: d.meta.id, kind: d.meta.kind, label: labelOf(d.meta.kind),
          title: d.meta.title, status: d.meta.status, order: d.meta.order,
          revision: d.revision, canonicalChanged: d.canonicalChanged,
        })),
      }, null, 2));
    },
  });

  pi.registerTool({
    name: 'novel_read', label: '读取小说文档',
    description: 'Read Markdown BODY with metadata and revision. offset is 1-based body line; continue until nextOffset=null before replacing the full body. Max 200 lines/30KB per page.',
    parameters: Type.Object({
      path: Type.String(),
      offset: Type.Optional(Type.Integer({ minimum: 1 })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
    }),
    async execute(_id, args) {
      const d = await (await need()).read(args.path);
      const lines = d.body.split('\n');
      const start = (args.offset ?? 1) - 1;
      let end = start, bytes = 0;
      while (end < lines.length && end < start + (args.limit ?? 100)) {
        const size = Buffer.byteLength(lines[end]!) + 1;
        if (size > 30000) throw new Error(`Body line ${end + 1} exceeds 30KB. Split it with your editor before using managed replacement.`);
        if (bytes + size > 30000) break;
        bytes += size; end++;
      }
      return output(JSON.stringify({
        path: d.path, id: d.meta.id, kind: d.meta.kind, title: d.meta.title,
        status: d.meta.status, aliases: d.meta.aliases ?? [],
        refs: d.meta.refs ?? [], sources: d.meta.sources ?? [],
        revision: d.revision, canonicalChanged: d.canonicalChanged,
        totalLines: lines.length,
        nextOffset: end < lines.length ? end + 1 : null,
        body: lines.slice(start, end).join('\n'),
      }, null, 2));
    },
  });

  pi.registerTool({
    name: 'novel_create', label: '创建小说资料',
    description: `Create a template-backed setting/continuity document. No prose is fabricated. Derived records (summary/state/event/relationship-state/review) require sources. refs and sources take stable document IDs, never paths.

可用种类：${Object.keys(kinds).join(', ')}`,
    parameters: Type.Object({
      kind: StringEnum(Object.keys(kinds)),
      title: Type.String(),
      refs: Type.Optional(Type.Array(Type.String())),
      sources: Type.Optional(Type.Array(sourceSchema)),
    }),
    async execute(_id, args, signal) {
      const p = await need();
      return output(JSON.stringify(await mutate(p, signal, () => p.create(args.kind, args.title, args.refs, args.sources))));
    },
  });

  pi.registerTool({
    name: 'novel_new_chapter', label: '新建章节',
    description: 'Create a chapter as three documents: 方案.md / 正文.md / 摘要.md. The plan must be approved by the author with /novel approve before 正文.md can be written.',
    parameters: Type.Object({ title: Type.String() }),
    async execute(_id, args, signal) {
      const p = await need();
      return output(JSON.stringify(await mutate(p, signal, () => p.newChapter(args.title))));
    },
  });

  pi.registerTool({
    name: 'novel_propose', label: '追加章节方案',
    description: `Append one round of a chapter plan as "## 方案 vN". This ONLY appends: it never rewrites existing sections, so the author's 要求 and 批注 sections cannot be overwritten. Appending resets the plan to draft, which withdraws any previous approval.

Use this only after discussing the plan with the author in conversation and being told to record it.`,
    parameters: Type.Object({
      chapterId: Type.String(),
      expectedRevision: Type.String(),
      body: Type.String(),
    }),
    async execute(_id, args, signal) {
      const p = await need();
      return output(JSON.stringify(await mutate(p, signal, () => p.propose(args.chapterId, args.body, args.expectedRevision))));
    },
  });

  pi.registerTool({
    name: 'novel_write', label: '保存小说文档',
    description: 'Replace ONLY the full Markdown body of an existing draft. Read all pages first. expectedRevision is mandatory. Writing 正文.md requires the chapter plan to be approved. Plugin preserves ID/kind/title/order/status.',
    parameters: Type.Object({
      path: Type.String(),
      expectedRevision: Type.String(),
      body: Type.String(),
      refs: Type.Optional(Type.Array(Type.String())),
      sources: Type.Optional(Type.Array(sourceSchema)),
    }),
    async execute(_id, args, signal) {
      const p = await need();
      const transaction = await mutate(p, signal, () => p.write(args.path, args.expectedRevision, args.body, args.refs, args.sources));
      return output(JSON.stringify({ transaction, path: args.path, revision: (await p.read(args.path)).revision }));
    },
  });

  pi.registerTool({
    name: 'novel_patch', label: '局部修改小说',
    description: 'Apply unique non-overlapping exact body replacements against expectedRevision. Does not alter metadata. Prefer for localized polishing.',
    parameters: Type.Object({
      path: Type.String(),
      expectedRevision: Type.String(),
      edits: Type.Array(Type.Object({ oldText: Type.String(), newText: Type.String() }), { minItems: 1 }),
    }),
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
    description: 'Create/update a factual chapter summary grounded in the exact chapter revision read. Source binding uses the chapter ID, so renaming files is safe. The author cannot accept a chapter without a current summary.',
    parameters: Type.Object({
      chapterId: Type.String(),
      expectedChapterRevision: Type.String(),
      expectedSummaryRevision: Type.String(),
      body: Type.String(),
    }),
    async execute(_id, args, signal) {
      const p = await need();
      return output(await mutate(p, signal, () => p.summary(args.chapterId, args.body, args.expectedChapterRevision, args.expectedSummaryRevision)));
    },
  });

  pi.registerTool({
    name: 'novel_context', label: '章节上下文清单',
    description: `Return relevant file paths, not full contents. Founding documents (${FOUNDING.map(f => f.path).join(', ')}) always come first, in that order, because they determine how everything after them is written. Read them with novel_read.`,
    parameters: Type.Object({ chapterId: Type.String() }),
    async execute(_id, args) { return output(await (await need()).context(args.chapterId)); },
  });

  pi.registerTool({
    name: 'novel_check', label: '检查小说资料',
    description: 'Deterministic structure/reference/revision checks plus founding-progress status. Not semantic plot validation.',
    parameters: Type.Object({ offset: Type.Optional(Type.Integer({ minimum: 0 })) }),
    async execute(_id, args) {
      const p = await need();
      const issues = await p.diagnostics();
      const founding = await p.founding();
      const start = args.offset ?? 0;
      return output(JSON.stringify({
        total: issues.length,
        issues: issues.slice(start, start + 100),
        nextOffset: start + 100 < issues.length ? start + 100 : null,
        // 立项进度是提示，不是故障，所以单独给，不混进 issues。
        founding: founding.map((f) => ({ path: f.path, label: f.label, state: f.state })),
      }, null, 2));
    },
  });

  // ── 命令 ────────────────────────────────────────────────────────────

  pi.registerCommand('novel', {
    description: '小说总管：项目、立项、设定、章节、方案批准、创作、审稿、版本恢复',
    getArgumentCompletions(prefix) {
      return ['init', 'adopt', 'setup', 'status', 'new', 'approve', 'create', 'write', 'polish', 'review', 'plan', 'check', 'accept', 'publish', 'confirm', 'reopen', 'reorder', 'history', 'recover', 'export', 'migrate', 'close', 'help']
        .filter(s => s.startsWith(prefix)).map(s => ({ value: s, label: s }));
    },
    async handler(args, ctx) {
      try {
        await ctx.waitForIdle();
        const match = /^(\S+)(?:\s+([\s\S]*))?$/.exec(args.trim());
        let command = match?.[1] ?? 'menu';
        let rest = match?.[2]?.trim() ?? '';

        if (command === 'menu') {
          if (!ctx.hasUI) { show(help); return; }
          const choice = await ctx.ui.select('小说总管', ['status · 进度', 'setup · 立项', 'write · 创作', 'polish · 润色', 'review · 审稿', 'check · 检查', 'help · 帮助']);
          if (!choice) return;
          command = choice.split(' ')[0]!;
        }
        if (command === 'help') { show(help); return; }
        if (command === 'close') { active = undefined; await refresh(ctx); show('已关闭小说管理保护。'); return; }

        if (command === 'migrate') {
          const plan = await planMigration(path.resolve(ctx.cwd));
          const lines = [
            `迁移计划（format 1 → 2）`,
            `书名：${plan.title}`,
            `需要搬迁：${plan.moves.length} 份文档`,
            `种类改名：${plan.kindRenames} 处（plan → chapter-plan）`,
            `来源改绑编号：${plan.sourceRewrites} 份文档`,
            plan.blockers.length ? `\n⚠ 阻塞项：\n${plan.blockers.map(b => `- ${b}`).join('\n')}` : '\n没有阻塞项。',
          ];
          if (plan.blockers.length) { show(lines.join('\n')); return; }
          if (!ctx.hasUI) throw new Error('迁移需要交互确认，请在 Pi 交互模式使用。');
          if (!await ctx.ui.confirm('迁移项目格式', '迁移会重写全部文档路径与来源绑定。请确认已经提交或备份整个目录。继续？')) return;
          const result = await locked(path.resolve(ctx.cwd), () => migrate(path.resolve(ctx.cwd)));
          active = new Project(result.plan.root);
          show(`迁移完成，事务 ${result.transaction}。\n如需退回：/novel recover ${result.transaction}\n请运行 /novel check 复核。`);
          await refresh(ctx);
          return;
        }

        if (command === 'init') {
          const report = await initProject(path.resolve(ctx.cwd), rest || undefined);
          active = new Project(report.root);
          await active.validate();
          show([
            `已在 ${report.root} 激活项目。`,
            report.created.length ? `\n新建：\n${report.created.map(f => `- ${f}`).join('\n')}` : '',
            report.adopted.length ? `\n沿用已有受管文档：${report.adopted.length} 份` : '',
            report.unmanaged.length
              ? `\n发现 ${report.unmanaged.length} 份没有 frontmatter 的笔记，没有自动改动：\n${report.unmanaged.map(f => `- ${f}`).join('\n')}\n要纳入管理请执行：/novel adopt <路径> --kind <种类>`
              : '',
            `\n下一步：/novel setup 开始立项。第一个要定的是文风。`,
          ].filter(Boolean).join('\n'));
        } else if (command === 'adopt') {
          const space = rest.indexOf(' ');
          const target = space < 0 ? rest : rest.slice(0, space);
          const flags = space < 0 ? '' : rest.slice(space + 1);
          if (!target) throw new Error('用法：/novel adopt <路径> --kind <种类> [--title <标题>]');
          const kindMatch = /--kind\s+(\S+)/.exec(flags);
          const titleMatch = /--title\s+(.+)$/.exec(flags);
          if (!kindMatch) throw new Error(`请用 --kind 指定种类。可用：${Object.keys(kinds).join(', ')}`);
          const p = await need();
          const result = await mutate(p, undefined, () => adoptDocument(p, target, kindMatch[1]!, titleMatch?.[1]));
          show(`已纳入管理：${result.path}\n编号：${result.id}\n事务：${result.transaction}`);
        } else if (command === 'setup') {
          const p = await need();
          const skill = await fs.readFile(fileURLToPath(new URL('../skills/novel-manager/SKILL.md', import.meta.url)), 'utf8');
          const order = FOUNDING.map((f, i) => `${i + 1}. ${f.path}（${labelOf(f.kind)}）`).join('\n');
          pi.sendUserMessage(`${skill}\n\nSkill directory: ${fileURLToPath(new URL('../skills/novel-manager/', import.meta.url))}\nActive novel root: ${p.root}\nMode: setup\n\n请按照下面的顺序，与作者逐项确定立项内容。每一项都要先提问、给出候选、得到作者明确的答复后才落盘，写完用 novel_write 保存，并提示作者用 /novel confirm 确认。全部完成前不要开始写任何正文。\n\n${order}`);
        } else if (command === 'approve') {
          const p = await need();
          const chapter = await resolveChapter(p, rest);
          const planPath = await p.planPath(chapter.meta.id);
          const plan = await p.read(planPath);
          if (!plan.body.includes('## 方案 v')) throw new Error(`${planPath} 里还没有任何方案内容；让模型先产出方案。`);
          if (!ctx.hasUI) throw new Error('批准方案需要交互确认，请在 Pi 交互模式使用。');
          if (!await ctx.ui.confirm('批准本章方案', `${chapter.meta.title}\n${planPath}\n\n批准后正文写作解锁。方案之后若被修改，批准会自动失效。`)) return;
          show(await mutate(p, undefined, () => p.transition(planPath, 'confirm', plan.revision)));
          show(`已批准《${chapter.meta.title}》的方案，可以开始写正文了。`);
        } else if (['write', 'polish', 'review', 'plan'].includes(command)) {
          if (!rest && ctx.hasUI) rest = (await ctx.ui.input('创作要求', '例如：写下一章；润色指定章节；完善人物关系')) ?? '';
          if (!rest) return;
          const p = await need();
          // Explicitly load the packaged skill even if skill auto-discovery is disabled.
          const skill = await fs.readFile(fileURLToPath(new URL('../skills/novel-manager/SKILL.md', import.meta.url)), 'utf8');
          pi.sendUserMessage(`${skill}\n\nSkill directory: ${fileURLToPath(new URL('../skills/novel-manager/', import.meta.url))}\nActive novel root: ${p.root}\nMode: ${command}\nUser request: ${rest}`);
        } else {
          const p = await need();
          if (command === 'status') {
            const chapters = await p.chapters();
            const rows = [];
            for (const d of chapters) {
              const plan = await p.read(`${d.path.replace(/正文\.md$/, '')}${PLAN_FILE}`).catch(() => undefined);
              const gate = plan?.meta.status === 'confirmed' ? '方案已批准' : '方案待批准';
              rows.push(`- ${d.meta.order}. ${d.meta.title} [${d.canonicalChanged ? '外部修改待确认' : d.meta.status}] · ${gate} · ${d.body.replace(/\s/g, '').length} 非空白字符\n  ${d.path}`);
            }
            show(`# 小说进度\n\n${p.root}\n\n${rows.join('\n') || '尚无章节。使用 /novel new 标题'}\n\n字数为含标题的非空白字符统计，不等于出版字数。`);
          } else if (command === 'new') {
            const result = await mutate(p, undefined, () => p.newChapter(rest));
            show(`已创建第 ${result.order} 章：${result.folder}\n\n下一步让模型产出方案，然后 /novel approve ${result.id}。`);
          } else if (command === 'create') {
            const space = rest.indexOf(' ');
            if (space < 0) throw new Error('用法：/novel create <种类> <名称>；带来源的记录请通过自然语言创建');
            show(JSON.stringify(await mutate(p, undefined, () => p.create(rest.slice(0, space), rest.slice(space + 1)))));
          } else if (command === 'check') {
            const founding = await p.founding();
            const labels = { missing: '缺失', empty: '空白', draft: '草稿', confirmed: '已确认' } as const;
            const progress = founding.map((f) => `- ${f.label}  ${f.path}  ${labels[f.state]}`).join('\n');
            const issues = await p.diagnostics();
            show(`# 立项进度（按顺序）\n\n${progress}\n\n# 结构检查\n\n${issues.join('\n') || '结构、引用和来源版本检查通过；这不代表剧情逻辑已经审查。'}`);
          } else if (['accept', 'publish', 'confirm', 'reopen'].includes(command)) {
            if (!ctx.hasUI) throw new Error('状态变更需要交互确认，请在 Pi 交互模式使用此命令。');
            const d = await p.read(rest);
            if (!await ctx.ui.confirm('确认状态变更', `${command}: ${d.meta.title}\n${rest}\n请先阅读正文。此操作保留可恢复记录。`)) return;
            show(await mutate(p, undefined, () => p.transition(rest, command as 'accept' | 'publish' | 'confirm' | 'reopen', d.revision)));
          } else if (command === 'reorder') {
            if (!ctx.hasUI || !await ctx.ui.confirm('调整章节顺序', '会重命名章节目录。因为来源按编号绑定，摘要不会因此过期。继续？')) return;
            show(await mutate(p, undefined, () => p.reorder(rest.split(/\s+/))));
          } else if (command === 'history') show((await transactionFiles(p.root)).join('\n') || '暂无变更记录');
          else if (command === 'recover') {
            if (!ctx.hasUI || !await ctx.ui.confirm('恢复旧版本', `回滚事务 ${rest}？有后续或外部修改时将拒绝恢复。`)) return;
            await mutate(p, undefined, () => locked(p.root, () => rollback(p.root, rest)));
            show('已恢复。请运行 /novel check。');
          } else if (command === 'export') show(JSON.stringify(await mutate(p, undefined, () => p.exportBook())));
          else throw new Error('未知命令；使用 /novel help');
        }
        await refresh(ctx);
      } catch (error) {
        show(`操作未完成：${error instanceof Error ? error.message : String(error)}`);
      }
    },
  });
}

/** `/novel approve` 接受章节编号或序号。 */
async function resolveChapter(p: Project, token: string) {
  if (!token) throw new Error('请提供章节编号或序号，例如 /novel approve 3 或 /novel approve <章节ID>');
  const chapters = await p.chapters();
  const byOrder = chapters.find((c) => String(c.meta.order) === token);
  if (byOrder) return byOrder;
  const byId = chapters.find((c) => c.meta.id === token);
  if (byId) return byId;
  const byFolder = chapters.find((c) => c.path.includes(chapterFolderName(Number(token), '')) || c.path.includes(token));
  if (byFolder) return byFolder;
  throw new Error(`找不到章节：${token}`);
}
