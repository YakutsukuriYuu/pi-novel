import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { truncateHead, withFileMutationQueue } from '@earendil-works/pi-coding-agent';
import { StringEnum } from '@earendil-works/pi-ai';
import { Type } from 'typebox';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Project, adoptDocument, initProject, kinds, labelOf } from './project.ts';
import { decode } from './markdown.ts';
import { FOUNDING, PLAN_FILE } from './kinds.ts';
import { locked, projectAbove, projectAt, readOptional, rollback, transactionFiles } from './storage.ts';

const sourceSchema = Type.Object({ id: Type.String(), revision: Type.String() });

/**
 * 命令只有两个：**激活**和**解除保护**。
 *
 * 前者必须手输，因为在那之前插件的 skill 不会加载，对话里也表达不了「这就是那本书」。
 * 其他所有操作都通过和模型说话完成 —— 需要作者本人授权的那几步（采纳、确认、
 * 退回……）由模型发起请求，你在终端上点一下确认框。
 */
const help = `# pi-novel

一个目录就是一本书。只有在这个目录里启动 Pi 才会激活小说模式，
子目录不继承父目录的激活状态。

前端用 Obsidian 读写，Pi 负责生成。所有内容都是普通 Markdown。

/novel init [书名] — 在当前文件夹激活（允许非空目录）
/novel close — 关闭本会话的管理保护

其余全部直接和模型说就行：
  「我们立项吧，先定文风」    「新建一章叫雨夜」
  「按这个方案写」            「这章可以了」（会弹确认框让你点）
  「加个人物叫林默」          「检查一下」
  「概要把第三段改冷一点」    「把第 3 章挪到第 2 章前面」

采纳、发布、确认、退回由你点确认框决定，模型无法代替你。`;

export function output(text: string) {
  const t = truncateHead(text, { maxBytes: 40000, maxLines: 1000 });
  return {
    content: [{ type: 'text' as const, text: t.content + (t.truncated ? '\n[输出已截断；请使用分页或缩小查询范围，不要把截断内容写回文件。]' : '') }],
    details: {},
  };
}

// Guard is deliberately allowlist-based: unknown tool implementations may write via arbitrary APIs.
export const readOnlyTools = new Set(['read', 'grep', 'find', 'ls']);

export const NOVEL_TOOLS = [
  // 只读
  'novel_check', 'novel_catalog', 'novel_read', 'novel_context', 'novel_history',
  // 写作
  'novel_create', 'novel_new_chapter', 'novel_propose', 'novel_write',
  'novel_patch', 'novel_rename', 'novel_summary',
  // 作者授权（弹确认框）
  'novel_authorize',
  // 维护
  'novel_adopt', 'novel_reorder', 'novel_recover', 'novel_export',
] as const;

export function allowedTool(name: string): boolean {
  return readOnlyTools.has(name) || (NOVEL_TOOLS as readonly string[]).includes(name);
}

/** 作者取消时的固定回话，避免模型换个说法反复问。 */
const DECLINED = '作者取消了这次操作。不要重试，也不要换一种说法再问 —— 等他明确要求。';

export default function novelExtension(pi: ExtensionAPI) {
  let active: Project | undefined;

  const need = async (): Promise<Project> => {
    if (!active) throw new Error('没有打开的小说。请在小说文件夹里用 /novel init 激活，或从该目录启动 Pi。');
    await active.validate();
    return active;
  };

  const show = (text: string) => pi.sendMessage({ customType: 'pi-novel', content: text, display: true });

  /**
   * 作者授权闸门。
   *
   * 这是本次改造的关键：过去采纳/确认只能是命令，模型连「请求」都做不到；
   * 现在模型可以发起请求，但**必须由作者在终端上点确认框**才会执行。
   * 授权仍然只在作者手里，而作者不必再输命令、也不必记住文件路径。
   */
  const askAuthor = async (ctx: ExtensionContext, title: string, message: string): Promise<boolean> => {
    if (!ctx.hasUI) throw new Error('这一步需要作者确认，请在交互模式下操作。');
    return ctx.ui.confirm(title, message);
  };

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
    // 只有当前目录本身算小说根，不向上找。
    const root = await projectAt(ctx.cwd);
    // 看到标记文件就进入受管模式，**即使项目本身有问题**。
    // 这是刻意的 fail-closed：项目坏了不能成为「任模型自由使用 bash/write/edit」的理由。
    // 具体问题由 need() 里的 validate() 报出来。
    if (root) active = new Project(root);
    else if (ctx.hasUI) {
      // 开在小说的子目录里会静默失去写入保护，这个坑很隐蔽，所以提醒一句。
      // 注意：只提醒，不替用户激活父目录 —— 「一个目录就是一本书」。
      const above = await projectAbove(ctx.cwd).catch(() => undefined);
      if (above) ctx.ui.notify(`当前目录不是小说根（${above} 才是）。子目录不会激活小说模式，文件也不受保护；请在小说根目录启动 Pi。`, 'warning');
    }
    await refresh(ctx);
  });

  pi.on('tool_call', async event => {
    if (active && !allowedTool(event.toolName)) {
      return { block: true, reason: 'pi-novel managed session: use novel_* tools. Arbitrary shell/write/edit/other extension tools are blocked. The author can /novel close to leave managed mode.' };
    }
  });

  // The package manifest deliberately does not declare skills: novel-manager is injected only when the
  // current directory is itself a project root, so paper/code sessions never carry its description.
  pi.on('resources_discover', async event => {
    const root = await projectAt(event.cwd);
    if (!root) return;
    try { await new Project(root).validate(); } catch { return; }
    return { skillPaths: [fileURLToPath(new URL('../skills', import.meta.url))] };
  });

  pi.on('before_agent_start', async event => {
    if (!active) return;
    try {
      await active.validate();
    } catch (error) {
      // 项目不可用也不要让整轮对话起不来：写入保持封锁，但要把原因告诉模型，
      // 它才能转告作者发生了什么。
      return {
        systemPrompt: event.systemPrompt + `

pi-novel found a project marker at ${active.root} but the project is not usable: ${(error as Error).message}
All file writes stay blocked. Tell the author exactly what is wrong. Do not try to repair the files yourself.`,
      };
    }
    return {
      systemPrompt: event.systemPrompt + `

pi-novel is managing a Markdown novel whose front end is Obsidian. The author talks to you in plain language and maintains the Markdown files himself. Load the novel-manager skill before creative work.

You drive the workflow; the author should never need to type a slash command except /novel init and /novel close.

Workflow that must be respected:
- Before writing any chapter body, build a chapter plan with novel_propose. Writing 正文.md before the author approves the plan is rejected by the tool.
- Ask the author to approve by calling novel_authorize; that shows a confirmation dialog the author answers. Never claim approval you did not receive.
- Start a project by settling 文风, 背景, 世界观, 规则, 大纲 with the author, in that order.

Rules:
- Use novel_catalog / novel_read / novel_context before every change; write with novel_write and the exact revision.
- All paths are relative to the active project, not necessarily cwd. Do not bypass managed tools.
- refs and sources use stable document IDs, never paths. Renaming a file in Obsidian must not break anything.
- In prose, link other notes with [[双方括号]] so Obsidian's graph and backlinks work.
- Draft and planned information is not canon.
- Never call novel_authorize speculatively. Ask once, when the work is genuinely ready, and accept a refusal without repeating it.
- No subagents unless the user explicitly requests delegation.`,
    };
  });

  pi.on('agent_end', async (_e, ctx) => { await refresh(ctx); });

  // ── 只读工具 ────────────────────────────────────────────────────────

  pi.registerTool({
    name: 'novel_catalog', label: '小说资料目录',
    description: 'List/search managed Markdown by literal query across title/body/ID/aliases/path; paginated, no full bodies. Read selected files with novel_read. kind optional. Paths are relative to active novel.',
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
    name: 'novel_context', label: '章节上下文清单',
    description: `Return relevant file paths, not full contents. Founding documents (${FOUNDING.map(f => f.path).join(', ')}) always come first, in that order, because they determine how everything after them is written. Read them with novel_read.`,
    parameters: Type.Object({ chapterId: Type.String() }),
    async execute(_id, args) { return output(await (await need()).context(args.chapterId)); },
  });

  pi.registerTool({
    name: 'novel_check', label: '检查小说资料',
    description: 'One-stop status: structural/reference/revision issues, founding progress, per-chapter plan state, and Markdown files the author wrote but that are not under management yet. Deterministic checks only, not semantic plot validation.',
    parameters: Type.Object({ offset: Type.Optional(Type.Integer({ minimum: 0 })) }),
    async execute(_id, args) {
      const p = await need();
      const issues = await p.diagnostics();
      const founding = await p.founding();
      const unmanaged = await p.unmanaged();

      const chapters = [];
      for (const chapter of await p.chapters()) {
        const folder = chapter.path.slice(0, chapter.path.lastIndexOf('/'));
        const planRaw = await readOptional(p.root, `${folder}/${PLAN_FILE}`);
        let plan: string = 'missing';
        if (planRaw !== null) {
          plan = decode(planRaw).meta.status === 'confirmed' ? 'approved' : 'pending';
        }
        chapters.push({ order: chapter.meta.order, title: chapter.meta.title, path: chapter.path, status: chapter.meta.status, plan });
      }

      const start = args.offset ?? 0;
      return output(JSON.stringify({
        total: issues.length,
        issues: issues.slice(start, start + 100),
        nextOffset: start + 100 < issues.length ? start + 100 : null,
        founding: founding.map((f) => ({ path: f.path, label: f.label, state: f.state })),
        chapters,
        // 作者手写但还没纳入管理的笔记。对话里说「我写了个东西」时先看这里。
        unmanaged,
      }, null, 2));
    },
  });

  pi.registerTool({
    name: 'novel_history', label: '修改历史',
    description: 'List past transactions (newest last). Each entry can be rolled back with novel_recover. Use this before recovering so you quote the right ID.',
    parameters: Type.Object({}),
    async execute() {
      const p = await need();
      const files = await transactionFiles(p.root);
      return output(files.length ? files.join('\n') : '还没有任何修改记录。');
    },
  });

  // ── 写作工具 ────────────────────────────────────────────────────────

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
    description: 'Create a chapter as three documents: 方案.md / 正文.md / 摘要.md. The plan must be approved by the author before 正文.md can be written.',
    parameters: Type.Object({ title: Type.String() }),
    async execute(_id, args, signal) {
      const p = await need();
      return output(JSON.stringify(await mutate(p, signal, () => p.newChapter(args.title))));
    },
  });

  pi.registerTool({
    name: 'novel_propose', label: '追加章节方案',
    description: `Append one round of a chapter plan as "## 方案 vN". This ONLY appends: it never rewrites existing sections, so the author's 要求 and 批注 sections cannot be overwritten.

Use this only after discussing the plan with the author in conversation and being told to record it. After it lands, tell the author and offer to request approval.`,
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

  // ── 作者授权（唯一能改变受保护状态的入口） ──────────────────────────

  // as const 是必需的：StringEnum 会从数组元素推出字面量联合，
  // 内联数组会被推成 string[]，于是索引 AUTHORIZE 和 transition 都会失败。
  const AUTHORIZE_ACTIONS = ['accept', 'publish', 'confirm', 'reopen'] as const;
  type AuthorizeAction = (typeof AUTHORIZE_ACTIONS)[number];

  const AUTHORIZE: Record<AuthorizeAction, { title: string; why: string }> = {
    accept: { title: '采纳这一章？', why: '正文会被锁定。之后要改，需要先退回草稿。' },
    publish: { title: '发布这一章？', why: '标记为已发布（只在本地记录，不上传任何平台）。' },
    confirm: { title: '确认这份内容？', why: '它会成为长期设定，之后修改需要先退回草稿。' },
    reopen: { title: '退回草稿？', why: '会解除保护，正文或设定可以重新修改。' },
  };

  pi.registerTool({
    name: 'novel_authorize', label: '请求作者授权',
    description: `Ask the AUTHOR to approve a protected state change. This is the only way canon changes state, and it always shows a confirmation dialog the author answers — you cannot approve anything yourself.

action:
- accept  — 采纳章节正文（要求已有绑定当前版本的摘要）
- publish — 发布已采纳的章节
- confirm — 确认设定类内容或章节方案
- reopen  — 退回草稿，解除保护

Call this at most once, only when the work is genuinely ready and the author has indicated so. If the author declines, report that and stop; do not ask again.`,
    parameters: Type.Object({
      action: StringEnum(AUTHORIZE_ACTIONS),
      path: Type.String(),
    }),
    async execute(_id, args, signal, _onUpdate, ctx) {
      const p = await need();
      const doc = await p.read(args.path);
      const intent = AUTHORIZE[args.action];
      const label = labelOf(doc.meta.kind);

      const approved = await askAuthor(
        ctx,
        intent.title,
        `${doc.meta.title}（${label}）\n${args.path}\n\n${intent.why}\n\n此操作保留可恢复记录。`,
      );
      if (!approved) return output(DECLINED);

      const transaction = await mutate(p, signal, () => p.transition(args.path, args.action, doc.revision));
      return output(JSON.stringify({ ok: true, action: args.action, path: args.path, transaction }));
    },
  });

  // ── 维护 ────────────────────────────────────────────────────────────

  pi.registerTool({
    name: 'novel_adopt', label: '收编作者的笔记',
    description: 'Bring a Markdown file the author wrote (no frontmatter yet) under management: add frontmatter, assign a stable ID, and move it into the canonical folder for its kind if it is outside the managed areas. Asks the author to confirm because it rewrites their file.',
    parameters: Type.Object({
      path: Type.String(),
      kind: StringEnum(Object.keys(kinds)),
      title: Type.Optional(Type.String()),
    }),
    async execute(_id, args, signal, _onUpdate, ctx) {
      const p = await need();
      const approved = await askAuthor(
        ctx,
        '把这个笔记纳入管理？',
        `${args.path}\n种类：${labelOf(args.kind)}\n\n会补上 frontmatter 并分配编号；如果不在受管目录里，还会移动到规范目录。正文内容不动。`,
      );
      if (!approved) return output(DECLINED);
      return output(JSON.stringify(await mutate(p, signal, () => adoptDocument(p, args.path, args.kind, args.title))));
    },
  });

  pi.registerTool({
    name: 'novel_reorder', label: '调整章节顺序',
    description: 'Reorder chapters. Provide every chapter ID exactly once, in the desired order (get IDs from novel_check or novel_catalog). Renames chapter folders, so it asks the author to confirm.',
    parameters: Type.Object({ ids: Type.Array(Type.String(), { minItems: 1 }) }),
    async execute(_id, args, signal, _onUpdate, ctx) {
      const p = await need();
      const chapters = await p.chapters();
      const before = chapters.map((c) => `${c.meta.order}. ${c.meta.title}`).join('\n');
      const approved = await askAuthor(ctx, '调整章节顺序？', `当前顺序：\n${before}\n\n会重命名章节目录。摘要与状态记录按编号绑定，不会因此过期。`);
      if (!approved) return output(DECLINED);
      return output(await mutate(p, signal, () => p.reorder(args.ids)));
    },
  });

  pi.registerTool({
    name: 'novel_recover', label: '撤销一次修改',
    description: 'Roll back a transaction, restoring every file to its exact previous content. Omit id to roll back the most recent one. Refuses if later or external edits would be clobbered. Asks the author to confirm.',
    parameters: Type.Object({ id: Type.Optional(Type.String()) }),
    async execute(_id, args, signal, _onUpdate, ctx) {
      const p = await need();
      let id = args.id;
      if (!id) {
        const files = await transactionFiles(p.root);
        const last = files.at(-1);
        if (!last) throw new Error('还没有任何可撤销的修改。');
        id = last.slice(last.lastIndexOf('/') + 1).replace(/\.md$/, '');
      }
      const approved = await askAuthor(ctx, '撤销这次修改？', `事务 ${id}\n\n所有涉及的文件会恢复到修改前的原文。如果之后又有别的改动，会拒绝执行。`);
      if (!approved) return output(DECLINED);
      await mutate(p, signal, () => locked(p.root, () => rollback(p.root, id!)));
      return output(`已恢复到事务 ${id} 之前的状态。建议再跑一次 novel_check 复核。`);
    },
  });

  pi.registerTool({
    name: 'novel_export', label: '导出已采纳章节',
    description: 'Concatenate every accepted/published chapter into one Markdown file under 导出/. Refuses if accepted prose changed externally or a summary is stale.',
    parameters: Type.Object({}),
    async execute(_id, _args, signal) {
      const p = await need();
      return output(JSON.stringify(await mutate(p, signal, () => p.exportBook())));
    },
  });

  // ── 命令：只有激活、迁移、关闭 ──────────────────────────────────────

  pi.registerCommand('novel', {
    description: '小说项目：激活、迁移旧格式、关闭管理保护',
    getArgumentCompletions(prefix) {
      return ['init', 'close', 'help'].filter(s => s.startsWith(prefix)).map(s => ({ value: s, label: s }));
    },
    async handler(args, ctx) {
      try {
        await ctx.waitForIdle();
        const match = /^(\S+)(?:\s+([\s\S]*))?$/.exec(args.trim());
        const command = match?.[1] ?? 'help';
        const rest = match?.[2]?.trim() ?? '';

        if (command === 'help' || command === 'menu') { show(help); return; }

        if (command === 'close') {
          active = undefined;
          await refresh(ctx);
          show('已关闭小说管理保护。现在可以自由使用其他工具；重新进入小说目录并启动 Pi 会再次激活。');
          return;
        }

        if (command === 'init') {
          const report = await initProject(path.resolve(ctx.cwd), rest || undefined);
          active = new Project(report.root);
          await active.validate();
          show([
            `已在 ${report.root} 激活。`,
            report.created.length ? `\n已铺好骨架（都是空的，等着填）：\n${report.created.map(f => `- ${f}`).join('\n')}` : '',
            report.unmanaged.length
              ? `\n发现 ${report.unmanaged.length} 份你自己写的笔记，我没有动它们：\n${report.unmanaged.map(f => `- ${f}`).join('\n')}\n想纳入管理就告诉我，或直接说「把 X 收编成人物」。`
              : '',
            '\n接下来直接和模型说「我们立项吧」就行。第一个要定的是文风。',
          ].filter(Boolean).join('\n'));
          await refresh(ctx);
          return;
        }

        show(`未知命令。\n\n${help}`);
      } catch (error) {
        show(`操作未完成：${error instanceof Error ? error.message : String(error)}`);
      }
    },
  });
}
