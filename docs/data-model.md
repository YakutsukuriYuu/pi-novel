# 文件协议

## 两条原则

**一、正文纯净。** `.md` 里除了 frontmatter 之外全是作者能直接读到的内容。
没有编号、没有状态、没有隐藏字段混在正文里。

**二、能推导的绝不存。** `kind` 由 frontmatter 声明，`title` 是显示名，
`order` 是章节在作品中的位置 —— 除此之外不存任何可以算出来的东西。

## frontmatter

受管文档用 YAML frontmatter。Obsidian 会把它渲染成 **Properties 面板**，
折叠显示、可视化编辑、可按字段筛选 —— 所以它留在文件里是对的。

```yaml
---
id: 8f3a2b1c-6d4e-4a92-b1f0-2c7e9d3a5b18
kind: character
title: 林默
status: draft
aliases: [老林, 林队]
refs: [1a2b3c4d-...]
sources: []
---

# 林默

三十四岁，前刑警。
```

| 字段 | 必填 | 含义 |
| --- | --- | --- |
| `id` | ✓ | 稳定身份，创建时分配，永不改变 |
| `kind` | ✓ | 文档种类，见下方对照表 |
| `title` | ✓ | 显示标题 |
| `status` | ✓ | 状态，见下方状态机 |
| `order` | | 仅章节正文：在作品中的位置（正整数） |
| `refs` | | 关联对象的**编号**列表。只表示关联，不构成事实证明 |
| `sources` | | 派生资料的来源：`[{ id, revision }]` |
| `aliases` | | Obsidian 别名。让 `[[老林]]` 也能链到这张卡 |
| `tags` | | Obsidian 标签 |
| `approvedRevision` | | 仅章节方案：被批准时**方案正文**的哈希 |
| `canonicalBodyHash` | | 受保护内容被采纳/确认时**正文**的哈希，用于发现外部改动 |

额外字段不受限制，不会被拒绝（Obsidian 可能自己加字段）。

### 为什么 `sources` 记编号而不是路径

这是本协议里最重要的一条决定。

作者会在 Obsidian 里按 F2 重命名 `正文.md`，或者把整个章节目录拖到别处 —— 这是日常操作，
插件拦不住。如果来源记的是路径，**每重命名一次，所有状态、事件、审稿的来源就全部失效**。

改成编号之后，重命名、移动、重排章节顺序都不影响任何追溯链。

代价是 frontmatter 里看到的是 uuid，不可读。所以**人读的来源写进正文**：

```markdown
依据：[[章节/0001-雨夜/正文]]
```

人读的用双方括号（Obsidian 能跳转、能看到反向链接），机器校验的放 frontmatter。
两条轨道各司其职，不会互相漂移。

## 状态机

```text
章节正文    draft ──accept──> accepted ──publish──> published
                  <──────────── reopen ────────────

可确认内容  draft ──confirm──> confirmed
                  <──────── reopen ────────

章节方案    draft ──confirm（＝批准）──> confirmed
```

**可确认的种类**（19 种）：
`style` `background` `world` `rules` `outline` `writing` `taboo` `system`
`location` `faction` `item` `concept` `character` `relationship` `volume` `arc`
`chapter-plan` `emotion` `timeline`

**派生资料**（4 种，只有 `draft`，且必须带 `sources`）：
`relationship-state` `state` `event` `review`
  
**其余**：`chapter`（走 accept/publish）、`thread` `idea` `research` `proposal` `creator`
（保留草稿）、`export`（工具生成，状态为 `snapshot`，不接受直接创建）。
  
### 状态写错会被报出来
  
每个种类只接受特定状态（声明在 `src/kinds.ts`，`transition()` 与 `diagnostics()` 共用同一份）。
作者手改 frontmatter 时很容易写成别的种类的值 ——
最常见的错是给章节写 `confirmed`（那是设定类用的）。
  
这种错以前会被**静默忽略**：文件看着改了，状态栏和采纳流程却什么也不动。
现在 `novel_check` 会报：
  
```text
状态「confirmed」对章节正文无效：章节/0001-雨夜/正文.md；它只能是 draft / accepted / published
```
  
`accepted` / `published` / `confirmed` 的内容**拒绝任何正文写入**，必须先 `reopen`。

## 章节两件套

一章是**一个目录**里的三份文档：

```text
章节/0001-雨夜/
├── 方案.md     kind: chapter-plan
└── 正文.md     kind: chapter      ← 作品的正文
```

**方案必须先被作者批准，`正文.md` 才允许写入。**

批准时把方案**正文**的哈希记进 `approvedRevision`。为什么不记整份文件的哈希？
因为批准这个动作本身就要改写 frontmatter（`status: draft` → `confirmed`），
记整文件哈希会当场自我失效。

于是：**方案文字一改，批准立即失效**，正文重新上锁 —— 包括你在 Obsidian 里直接改的情况。

## 版本

`revision` **不落盘**，而是每次读取时对文件完整字节计算 SHA-256。

这意味着：哪怕只改一个标点，来源引用的精确版本就失效，`novel_check` 会报
`来源已过期`。这是**保守策略** —— 宁可多提示一次，也不假装知道语义是否变了。

派生资料通过 `sources` 绑定来源的精确版本，因此：

- 状态/事件绑定章节 → 章节一改，旧记录被标为过期

## 事务

每次写入都是一个事务，落在 `.novel/transactions/<时间戳>-<随机>.md`，
含每个路径的完整 `before` / `after` Markdown。

流程：

1. 先写 `.novel/pending/<id>.md` 标记
2. 逐个原子替换（临时文件 + rename）
3. 归档到 `.novel/transactions/`
4. 删除 pending 标记

中途崩溃会留下 pending 标记，`novel_check` 能发现，写入会被拦住直到恢复。
**不会被误当作正常状态。**

同一事务里重复写同一路径会被拒绝；所有写入排在同一把跨进程文件锁之后。

## 目录与种类对照

```text
顶层 13 个目录
创作约定.md / AGENTS.md        （根级，不受 frontmatter 管辖）
```

| 目录 | 种类 |
| --- | --- |
| `规则/` | `rules` `writing` `taboo` |
| `设定/` | `style` `background` `world` `system` |
| `设定/地点` `设定/势力` `设定/物品` `设定/概念` | `location` `faction` `item` `concept` |
| `人物/` | `character` |
| `人物/关系/` | `relationship` |
| `大纲/` | `outline` `volume` |
| `大纲/剧情线/` | `arc` |
| `章节/<NNNN-标题>/` | `chapter-plan` `chapter` |
| `当前状态/人物` `当前状态/关系` | `state` `relationship-state` |
| `时间线/` | `event` `timeline` |
| `伏笔/` | `thread` |
| `情感线/` | `emotion` |
| `审稿/` | `review` |
| `灵感/` `灵感/考据/` | `idea` `research` |
| `提案/` | `proposal` |
| `导出/` | `export` |

### 立项五件套

```text
设定/文风.md          设定/背景.md       设定/世界观.md
规则/世界规则.md       大纲/全书大纲.md
```

顺序即立项顺序，文风排第一是刻意的：调子不定，后面写的每一句话都是返工。
`novel_check` 报出它们的进度（`缺失` / `空白` / `草稿` / `已确认`）—— **不硬拦**写作。

## 读宽容，写严格

作者会在小说文件夹里放任何东西：图片、附件、自己的笔记、Obsidian 的 `.obsidian/`。

- **读**：顶层只进入上表里的目录（你的 `我的素材/` 不会被误读）；进入之后一路向下，
  所以 `人物/主要角色/林默.md` 这种你自己的分类是受支持的。
- 没有 frontmatter 的 `.md` 不会让扫描崩掉，而是被报为「还没纳入管理」，
  可以用收编把它补上 frontmatter 并移进规范目录。
- **写**：文件名里的 `[ ] # ^ |` 会被自动剥掉 —— 这几个字符在 Obsidian 链接里有语法含义，
  带 `#` 的文件名**永远无法被 `[[链接]]` 引用**。作者自己建的文件若带这些字符不会被拒绝读取，
  但 `novel_check` 会提醒。

## 外部改动

作者随时可以用 Obsidian 改任何文件。插件的态度是**如实记录，不假装**：

| 你改了什么 | 会发生什么 |
| --- | --- |
| 草稿 | 没有影响，继续写 |
| `accepted` / `published` / `confirmed` 的正文 | `novel_check` 报「受保护内容被外部改动」，需要 reopen 后重新确认 |
| 已批准的章节方案 | 批准自动失效，正文重新上锁 |
| frontmatter 的 `status`（比如手动改成 `accepted`） | `novel_check` 根据保护哈希发现正文被改过 |

这些都不是错误，是「你动了原文」被如实记录。
