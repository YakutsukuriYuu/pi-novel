# Markdown 文件协议（format 1）

## 单一事实源

没有数据库，没有隐藏的章节清单副本：文档 frontmatter 存稳定身份与管理信息，正文存作者内容。章节顺序来自章节正文的 `order` 字段。列表、状态面板、搜索结果实时从文件生成。

AGENTS.md 为普通 Markdown；受管文档使用 YAML frontmatter：

```yaml
---
id: character-稳定UUID
kind: character
title: 林默
status: draft
refs: []
sources: []
---
```

随后写标准 Markdown 正文。人物名是 title，角色类型、身份、声线、性格和能力等放在 Markdown 小节，不强制一堆结构化字段。

## 字段

| 字段 | 含义 |
| --- | --- |
| id | 稳定身份，不因标题/顺序变化而改变 |
| kind | 文档类别；使用对应模板 |
| title | 展示标题，允许中文 |
| status | 由插件维护的状态 |
| order | 仅章节正文使用的正整数显示顺序 |
| refs | 关联对象的稳定 ID，不是依赖证明 |
| sources | 派生记录依据的路径与精确文件版本 |
| canonicalBodyHash | 接受/确认时正文的 SHA-256，发现外部改动 |

`revision` 不写回源文件，而是在读取时对文件完整字节计算 SHA-256。派生文件用 `sources: [{ path, revision }]` 引用它。即使修改只有标点，精确版本也会改变，必须核对摘要后再更新来源。

作者通过命令执行的状态变更不改变正文；插件在同一事务中重绑直接引用该精确版本的记录，避免仅因接受状态变化就使摘要过期。导出快照不重绑。多层引用仍可能显示过期，需要核对，不假装做了语义证明。

## 状态

- chapter：`draft → accepted → published`。published 仅本地标记，不上传平台。
- lore、world、rules、style、creator：`draft → confirmed`。
- `reopen` 将上述受保护内容退回 draft。
- 计划、想法、审稿和连续性资料保留 draft；事实可信度取决于其来源是否已接受且版本一致，而不是自身状态。
- export：snapshot，不允许模型修改。

派生类型 summary/state/event/relationship-state/review 必须有 sources。thread 可先保存计划，无需伪造已发生来源；实际推进时应增加真实来源。

## 关系与时点

人物长期/初始信息放 lore/characters；初始关系放 lore/relationships。变化不直接覆盖初始设定：按章节创建 continuity/states 或 continuity/relationships 记录，通过 sources 绑定章节，通过 refs 关联人物或关系对象。

状态正文区分人物知道、人物误解、读者知道、作者秘密。上下文清单只收录来源全为目标章节之前的已接受且未改变正文的章节、且源版本匹配的派生资料。

若记录混合了设定源与章节源，清单采取保守排除；仍可通过 catalog 查找并人工判断。它不是自动时态数据库，也不通过解析任意中文推断时点。

## 路径与迁移

路径持久化使用相对路径和 `/`。**文件名取自建文件时的标题**（如 `林默.md`、`0001-雨夜/`），重名自动加 `-2` 后缀，跨平台不安全字符会被清理。真正的稳定身份是 frontmatter 里的 `id`（UUID），所有引用都走 id，不依赖文件名。

注意两点：

- **改标题不改文件名**（`novel_rename` 只改元数据），避免破坏引用。文件浏览时按标题认内容即可。
- **调整章节顺序会重命名章节文件夹**（`0001-` 前缀始终等于当前顺序），并在同一事务里同步修复所有指向旧路径的引用。老项目的 `ch-UUID` 文件夹在执行一次 reorder 后也会迁移为可读命名。

目前不支持自动升级未知格式；不是 format 1 时拒绝受管写入。迁移前应复制完整项目。不要只复制正文而丢弃设定、关系、来源和版本记录。

外部编辑应保留 frontmatter。插件检测坏 YAML、重复 ID、失效引用和旧来源，但不自动“猜测修好”。对已接受正文的改动需要 reopen、更新摘要、重新 accept。

## 变更记录

`.novel/transactions/时间戳-UUID.md` 包含状态、每个路径的 before/after 完整 Markdown 字符串。YAML 会用块文本存储多行内容，普通文本编辑器即可查看；不要手工改写这些记录。

未完成事务存放在 `.novel/pending/`，完成后移动到 transactions；普通写入只扫描 pending，不重复解析全部历史备份。

这些备份会随写作增长，没有自动删除政策，避免悄悄丢失历史。请定期对完整小说目录做外部备份；本插件不会自动推送你的小说到 GitHub。
