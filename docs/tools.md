# 工具契约

模型能调用的 17 个工具。你不必记它们 —— 你说话，模型用它。

这份文档写给两类人：想理解插件到底能做什么的作者，以及写 Skill 或扩展的人。

## 总览

| 工具 | 参数 | 会弹确认框 |
| --- | --- | --- |
| `novel_check` | `offset?` | |
| `novel_catalog` | `query?` `kind?` `offset?` `limit?` | |
| `novel_read` | `path` `offset?` `limit?` | |
| `novel_context` | `chapterId` | |
| `novel_history` | | |
| `novel_create` | `kind` `title` `refs?` `sources?` | |
| `novel_new_chapter` | `title` | |
| `novel_propose` | `chapterId` `expectedRevision` `body` | |
| `novel_write` | `path` `expectedRevision` `body` `refs?` `sources?` | |
| `novel_patch` | `path` `expectedRevision` `edits[]` | |
| `novel_rename` | `path` `expectedRevision` `title` | |
| `novel_summary` | `chapterId` `expectedChapterRevision` `expectedSummaryRevision` `body` | |
| `novel_authorize` | `action` `path` | ✓ |
| `novel_adopt` | `path` `kind` `title?` | ✓ |
| `novel_reorder` | `ids[]` | ✓ |
| `novel_recover` | `id?` | ✓ |
| `novel_export` | | |

路径一律相对项目根，例如 `人物/林默.md`。

## 三条全局契约

**1. 所有写入都要带 `expectedRevision`。**

写入前先读，把读到的版本原样传回。版本不匹配直接拒绝（`版本冲突：请重新读取后再写入`），
而不是覆盖。这是乐观锁，防止「读了半天再写」期间作者在 Obsidian 里改了东西。

**2. 受保护内容拒绝写入。**

`accepted` / `published` / `confirmed` 的文档，`novel_write` / `novel_patch` /
`novel_rename` 一律拒绝：

```text
受保护内容：…已采纳，请先在 UI 上退回草稿再修改
```

**3. `refs` 与 `sources` 只能填编号，不能填路径。**

派生资料（摘要、状态、事件、关系变化、审稿）**必须**有 `sources`，否则拒绝创建。

## 只读工具

### `novel_check`

一站式的现状。返回：

```jsonc
{
  "total": 3,
  "issues": ["...结构/引用/版本问题..."],
  "nextOffset": null,
  "founding": [{ "path": "设定/文风.md", "label": "文风", "state": "confirmed" }],
  "chapters": [{ "order": 1, "title": "雨夜", "path": "章节/0001-雨夜/正文.md",
                 "status": "accepted", "plan": "approved" }],
  "unmanaged": ["随手记.md"],
  "toolAccess": { "builtinReadonly": [...], "extraAllowed": [],
                  "readOutsideProject": false, "configProblem": null }
}
```

- `founding[].state`：`missing` / `empty` / `draft` / `confirmed`
- `chapters[].plan`：`missing` / `pending` / `approved`
- `unmanaged`：作者手写、还没纳入管理的 `.md`。对话里说「我写了个东西」时先看这里。
- `issues` 只报**故障**，不报进度 —— 立项进度单独在 `founding` 里，两者不混。

### `novel_catalog`

分页检索，**只给路径、编号、状态，不含正文**。`query` 会匹配标题、路径、编号、别名和正文。
每页默认 30 条、最多 100 条。

### `novel_read`

分页读取正文。每页最多 200 行 / 30KB。返回 `nextOffset`，**非空就必须继续读**，
不能把分页结果当完整正文写回。

单行超过 30KB 会明确报错并要求先用编辑器分段。

### `novel_context`

列出写这一章之前该读哪些文件。**按立项顺序排列**（文风 → 背景 → 世界观 → 规则 → 大纲），
因为文风决定后面每一句话怎么写。

它只给路径，不是内容 —— 这是刻意的，免得「清单」被当成「已经读过了」。

已经定稿的前两章、「绑定这些章节」的派生资料会进清单；未来章节和过期来源不会。
草稿前文会带上 `[draft]` 标记。

### `novel_history`

列出历史事务文件名（含 ID），供 `novel_recover` 引用。

## 写作工具

### `novel_create`

新建设定类文档，用模板填充，自动分配编号与路径。
**不适用于章节三件套**（走 `novel_new_chapter`），也不适用于 `export`（工具生成）。

拒绝的情况：未知种类、章节三件套、`export`、派生资料缺 `sources`、`refs` 指向不存在的编号。

### `novel_new_chapter`

一次生成 `方案.md` / `正文.md` / `摘要.md` 三份文档，分配三个编号，并自动排到最后一章之后。

### `novel_propose`

**只能追加**一节 `## 方案 vN`。

它**永远不会改写已有段落** —— 你写的「作者要求」和「作者批注」在结构上不可能被覆盖。
追加会把方案状态退回草稿，因此**之前的批准自动失效**。

方案处于已批准状态时，`novel_propose` 会拒绝并要求你先 `reopen`。这是有意的：
改一份已经批准过的方案，语义上就是撤回批准。

### `novel_write`

整篇替换正文。必须传刚读到的 `expectedRevision`。

**写 `正文.md` 时额外要求：**

1. 同目录的 `方案.md` 存在
2. 方案状态是已批准
3. 方案自批准后没有被改动过

任一不满足都会被拒绝：

```text
本章方案尚未被作者批准，不能写正文。先调 novel_propose 产出方案，再用 novel_authorize 请作者批准。
```

或

```text
方案在批准之后又被改动，批准已失效。请重新讨论方案，并请作者再次批准。
```

### `novel_patch`

局部替换。每处 `oldText` 必须在正文中**恰好出现一次**，且各区间互不重叠。
润色首选 —— 不要为了改几句话就重写整章。

### `novel_rename`

改显示标题。**编号不变，所以引用不会失效**，路径也不动。

### `novel_summary`

保存章节事实摘要，并**自动把该章正文的精确版本绑进 `sources`**。

正文和摘要版本都在 `expectedChapterRevision` / `expectedSummaryRevision` 里校验，
防止覆盖你并发改过的摘要。

**没有绑定当前正文版本的摘要，章节无法被采纳。** 这是采纳的前置条件。

## 作者授权

### `novel_authorize`

```jsonc
{ "action": "accept" | "publish" | "confirm" | "reopen", "path": "..." }
```

**这是唯一能改变受保护状态的入口。** 它会弹一个确认框，**由你点**。
模型能发起请求，但无法自己批准任何东西。

| action | 前置条件 |
| --- | --- |
| `accept` | 是章节正文；正文非空；存在绑定当前正文版本的摘要 |
| `publish` | 当前状态是 `accepted`；正文未被外部改动 |
| `confirm` | 属于 19 种可确认种类且当前是 `draft`；章节方案还要求已有 `## 方案 v` 内容 |
| `reopen` | 当前处于受保护状态 |

你拒绝时工具返回固定回话，模型被要求停止而不是换个说法再问。

**这个工具（以及下面三个）标了 `executionMode: 'sequential'`。**
pi 默认并行执行一条消息里的多个工具调用，而并发确认框会把界面卡死 ——
所以它们必须排队执行。另外还有一道门闩：已有确认框在等待时，第二次请求立即报错返回。

## 维护工具

### `novel_adopt`

把你手写的、没有 frontmatter 的 `.md` 纳入管理：补 frontmatter、分配编号、
必要时移进该种类的规范目录（**正文内容一字不改**）。

派生种类（摘要、状态、事件、关系变化、审稿）不能收编 —— 那些必须有来源版本。

会弹确认框，因为它是在改你的文件。

### `novel_reorder`

按给定顺序重排章节。必须把**每个章节编号恰好提供一次**。

会重命名章节目录，所以弹确认框。重新排序会改写正文的 `order` 字段，
**因此正文的版本会变** —— 指向它的摘要会自动重绑到新版本（这一点是刻意的：
路径无关不等于内容无关）。

### `novel_recover`

回滚一个事务，把涉及的文件恢复到修改前的原文。省略 `id` 就回滚最近一次。

**有后续或外部修改时拒绝执行**，而不是覆盖：

```text
Recovery conflict: <路径>; preserve external edits first.
```

### `novel_export`

把已采纳/已发布的章节按顺序拼成一个 Markdown，输出到 `导出/`。

前置检查：已采纳正文未被外部改动、每章摘要都绑定当前版本。任一不满足就拒绝导出。

## 模型拿不到的能力

以下都**不是工具**，模型无法执行：

- **`bash` / `edit` / `write` / `powershell`** —— 在受管会话里被整体拦下
- **`subagent` / MCP / 一切未知工具** —— 默认拒绝，白名单之外全挡
- **自己批准自己** —— 只能通过 `novel_authorize` 请你点确认框

模型只能通过 `novel_*` 写文件。这不是洁癖：一旦它能直接写，索引、版本追踪、
事务记录和状态机会同时失效。

只读工具（`read` `grep` `find` `ls` `ffgrep` `fffind`）的路径参数被限制在本书目录内。
`web_search` / `web_fetch` 按 URL 工作，不受此限制。

详见 README 的「安全边界」一节。
