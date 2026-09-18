# 工具与创作流程

工具供 Pi 模型调用；所有路径相对当前打开的小说项目，而不是 Pi cwd。`/novel` 命令供作者使用。

| 工具 | 主要输入 | 结果 |
| --- | --- | --- |
| novel_catalog | query?, kind?, offset?, limit? | 标题、路径、ID、状态、revision；分页 |
| novel_read | path, offset?, limit? | metadata、正文 body、revision、nextOffset |
| novel_create | kind, title, refs?, sources? | 规范模板；chapter 同时创建正文和计划 |
| novel_write | path, expectedRevision, body, refs?, sources? | 替换草稿正文，保留管理字段；事务 ID |
| novel_patch | path, expectedRevision, edits | 唯一、不重叠的局部正文替换 |
| novel_rename | path, expectedRevision, title | 改草稿展示标题，ID/路径/正文不变 |
| novel_summary | chapterId, expectedChapterRevision, expectedSummaryRevision, body | 创建/更新事实摘要 |
| novel_context | chapterId | 创作上下文路径清单，不是文件正文 |
| novel_check | offset? | 结构、来源、引用等问题；分页 |

summary 的 expectedSummaryRevision：首次创建传 `new`，已有摘要则先 read 并传入该摘要 revision，防止覆盖作者并发修改。

所有正文写入参数 `body` 不包含文件 frontmatter。`novel_patch` 的 edits 为 `[{oldText,newText}]`，匹配原始正文，不带工具输出的行号。模型不能通过写 body 修改真实状态或稳定身份。

## 写一章

1. catalog 定位/创建章节。
2. context 得到候选路径，read 读完相关文件。
3. 填章节计划；起草正文，用 write/patch 保存。
4. 自审、修订、重新 read 最终版本。
5. summary 保存准确事实；按需要整理人物状态、事件与关系变化。
6. check 检查结构与版本。
7. 提供草稿给作者。作者阅读后执行 accept，插件再次验证版本和摘要。

## 改一章

小改优先 patch，整章重构用 write。受保护正文需要作者 reopen，或先写 proposal。不擅自更改后续章节。

改动后来源哈希变化，旧摘要、审稿、状态可能失效。核对事实后更新，不只刷新哈希。纯标点修改也可能触发版本过期，这是保守的一致性策略。

## 分页与预算

catalog 默认 30 条、最多 100 条；read 每页默认 100 行、最多 200 行/约 30KB。输出还有统一 40KB/1000 行上限；截断会显式提示，应减小分页或缩小查询，不能拿截断内容替换正文。

超过 30KB 的单行正文会要求先分段；写作时自然分段，不把整章压成一行。context 是清单，过长时可用 catalog 按类型与关键词分页查找，不宣称全部加载。

## 模型使用范围

工具不自行调用其他模型，不产生隐藏的审稿费用。write/polish/review/plan 命令把内置 Skill 和用户要求交给 Pi 当前模型。资料的文学质量、推理正确性仍取决于模型与作者审核。
