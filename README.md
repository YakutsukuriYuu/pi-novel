# pi-novel

**以插件为总管、以 Skill 为创作协作者的 Pi 小说工作室。所有小说内容和管理记录都存为 Markdown。**

人物、人物关系、世界观、规则、地点、势力、物品、大纲、章节、时间线、伏笔、审稿与版本恢复，统一放进可以长期维护、迁移和直接编辑的文件夹。

不是一个独立聊天网站，也不包含模型服务。创作使用 Pi 当前选择的模型和凭据；文件管理、校验与恢复不需要模型请求。

## 安装

需要 Node.js 22+ 和支持当前 Extension API 的 Pi；本版本使用 **Pi 0.85.1** 验证。旧版 `@mariozechner/pi-coding-agent` 未测试。

```bash
pi install git:github.com/YakutsukuriYuu/pi-novel
```

已有 Pi 会话执行 `/reload`，或重启 Pi。插件不自动创建书籍，也不修改现有小说。

## 从一本新书开始

在 Pi 中执行（目录含空格也可以，无需额外引号）：

```text
/novel init ./我的小说 | 雨城
```

目标必须是空目录或尚不存在的目录，防止覆盖已有文件。它会创建基础设定并打开项目。

接着直接说：

> 我要写一部近未来悬疑小说。先和我确定创作目标、世界规则、主人公、人物关系及大纲，把讨论后确定的候选设定分别保存，不要开始正文。

或者：

```text
/novel create character 林默
/novel create location 旧城区
/novel create relationship 林默与沈遥
/novel new 雨夜
/novel write 写刚创建的《雨夜》，先完善本章计划，再写正文并整理摘要。
/novel polish 润色《雨夜》的对白，不改变情节。
/novel review 检查《雨夜》的时间线、人物知识边界和世界规则。
```

插件自动分配稳定 ID 和路径。你可按标题与模型沟通，不必手写 UUID。`/novel status` 显示章节路径。

审阅后，由你执行：

```text
/novel accept chapters/ch-实际ID/text.md
/novel confirm lore/characters/character-实际ID.md
```

命令还会弹出确认。模型没有接受正文或确认设定的工具。`accept` 要求非空正文和与当前版本一致的事实摘要。

下次进入书籍目录再启动 Pi，即可自动找到项目：

```bash
cd 我的小说
pi
```

也可以 `/novel open /完整路径/我的小说`。open 只影响当前会话，不改变 Pi 的 cwd；重启、切换会话或 reload 后按 cwd 自动发现项目，需要时重新 open。

## 插件和 Skill 的分工

| 插件确定性管理 | 内置 novel-manager Skill |
| --- | --- |
| 文件、模板、稳定 ID、章节顺序 | 构思、人物塑造、世界构建、大纲 |
| 草稿/接受/发布/确认状态 | 续写、写章节、润色、审稿 |
| 精确版本检查、局部替换 | 判断因果、动机、语义连续性 |
| Markdown 事务、旧版本、冲突恢复 | 从正文整理事实摘要、状态与关系变化 |
| 目录检索、分页读取、上下文路径清单 | 挑选相关设定，区分人物/作者/读者知识 |

Skill 随包一起安装。`/novel write|polish|review|plan` 显式加载内置 Skill，因此不依赖模型是否碰巧触发技能。默认当前模型自审，不自动启动子代理。

### Skill 只在小说项目里出现

包清单不声明 skills。扩展在 `resources_discover` 时向上查找 `.novel/project.md`，只有找到项目根才把 `skills/` 注入本次会话。因此：

- 在论文、代码或其他目录：`novel-manager` 的描述**不进 system prompt**，不会因「修改章节」等词误匹配。
- 在小说项目目录（含任意子目录）：描述正常出现，可自动触发，也可用 `/skill:novel-manager`。
- `/novel` 命令和 `novel_*` 工具仍然全局注册，但在非项目目录下调用会明确报「没有活动小说」。

`/novel close` 只关闭当前会话的写入保护，已经注入的 Skill 描述会保留到该会话结束。

## 文件结构

目录按需创建，不为没有内容的对象批量生成空文件。

```text
我的小说/
├── AGENTS.md                         # 给 Pi 的简短指引
├── CREATOR.md                        # 创作目标、读者、边界和偏好
├── setting/
│   ├── world.md                      # 世界观、历史、文明与日常生活
│   ├── rules.md                      # 能力/科技规则、代价、限制
│   └── style.md                      # 视角、文风、对白与表达偏好
├── outline/
│   ├── main.md                       # 全书大纲
│   └── arcs/*.md                     # 分卷与故事阶段
├── lore/
│   ├── characters/*.md               # 人物长期与初始设定
│   ├── relationships/*.md            # 初始关系及双方认知
│   ├── locations/*.md                # 地点、距离、空间与感官信息
│   ├── factions/*.md                 # 势力
│   ├── items/*.md                    # 物品与限制
│   └── concepts/*.md                 # 其他重要概念
├── chapters/ch-稳定ID/
│   ├── plan.md                       # 计划：打算发生什么
│   ├── text.md                       # 当前唯一正文
│   └── summary.md                    # 事实：实际写了什么
├── continuity/
│   ├── states/*.md                   # 某人物在某章节的状态快照
│   ├── relationships/*.md            # 有来源的关系变化
│   ├── events/*.md                   # 故事内时间线事件
│   └── threads/*.md                  # 伏笔、悬念与支线
├── workspace/
│   ├── ideas/*.md                    # 未采纳想法
│   ├── research/*.md                 # 参考来源与研究笔记
│   └── proposals/*.md                # 改稿与设定变更提案
├── reviews/*.md                      # 有来源版本的审稿报告
├── exports/*.md                      # 已接受正文的导出快照
└── .novel/
    ├── project.md                    # 项目身份与格式版本
    ├── transactions/*.md             # 已完成的修改前后快照
    ├── pending/*.md                  # 尚未完成/恢复的事务
    └── lock/owner.md                 # 仅操作期间存在的写锁
```

**小说项目没有 JSON 数据库，也没有专用二进制格式。**元数据放在 `.md` 的 YAML frontmatter，正文是普通 Markdown。插件自身的 TypeScript、package.json、依赖锁文件不属于小说内容。Pi 的聊天日志由 Pi 管理，不在此承诺范围。

详见 [文件协议](docs/data-model.md)。

## 命令

输入 `/novel` 打开菜单，或使用以下命令：

| 命令 | 作用 |
| --- | --- |
| `init <目录> \| <书名>` | 在空目录初始化 |
| `open <目录>` / `close` | 打开/退出当前小说管理模式 |
| `status` | 章节、状态、非空白字符统计 |
| `new <标题>` | 创建章节正文与计划 |
| `create <类型> <标题>` | 创建对象模板 |
| `write <要求>` | 创作与续写 |
| `polish <要求>` | 润色和改稿 |
| `review <要求>` | 审稿，默认不改正文 |
| `plan <要求>` | 构思、设定、大纲与章节规划 |
| `check` | 结构、引用、来源版本与外部改动检查 |
| `accept <正文路径>` | 接受草稿章节 |
| `publish <正文路径>` | 将已接受章节标记发布，不会上传任何平台 |
| `confirm <设定路径>` | 将候选设定标记为正式设定 |
| `reopen <路径>` | 解锁受保护文档，重新进入草稿 |
| `reorder <全部章节ID，以空格分隔>` | 修改显示顺序，稳定 ID 和路径不变 |
| `history` / `recover <事务ID>` | 查看记录、冲突安全地回滚 |
| `export` | 按顺序导出已接受/发布正文到 Markdown |
| `help` | 完整帮助 |

对象类型：`character`、`relationship`、`location`、`faction`、`item`、`concept`、`arc`、`state`、`event`、`relationship-state`、`thread`、`review`、`idea`、`research`、`proposal`。需要来源的派生记录请通过自然语言让模型调用工具创建。

工具接口详见 [工具协议](docs/tools.md)。

## 长期写作的保护规则

- **草稿不等于正史**：模型不能自行接受章节、发布或确认设定。
- **计划不等于事实**：大纲、计划和想法与事实摘要分开存储。
- **派生资料可追溯**：摘要、人物状态、关系变化、事件和审稿引用源文件 SHA-256；原文变化后检查会报告过期。
- **旧章不读未来状态**：上下文清单排除未来章节和过期来源对应的派生记录；世界设定中的作者秘密仍由 Skill 区分。
- **变更有记录**：受管操作保留前后 Markdown；恢复遇到后续修改会拒绝覆盖。
- **外部编辑可发现**：读取始终从磁盘获取；已接受/确认正文保存内容校验值，外部改动不会静默成为已确认内容。
- **默认受管工具保护**：打开小说时阻止模型使用 Bash、write、edit 以及未知第三方工具，只允许本插件工具和已知只读工具。退出用 `/novel close`。

### 明确的边界

这不是操作系统沙箱：用户手动编辑、`!` 命令、其他进程、恶意扩展仍可以改文件；只读工具名假设未被其他插件替换成写工具。请保持正常备份，不要把运行不受信任插件的 Pi 当隔离环境。

文件哈希校验和写锁保护合作进程，不提供对任意外部进程的文件系统级 compare-and-swap。保存时避免在其他编辑器同时改同一文件；逐文件原子替换和 Markdown 日志支持进程中断恢复，但不宣称断电级全目录事务。

插件不会自动发现所有剧情漏洞，不自动推断完整依赖图，不提供多人实时协作或 Denova UI。上下文工具是路径清单而非“已经读完资料”；内容由模型按需读取。索引目前从 Markdown 实时扫描，可迁移且无缓存漂移，大量资料时查询成本随文件数增加。

安全、恢复和初始化中断处理见 [恢复说明](docs/recovery.md)。

## 开发与验证

```bash
npm ci --ignore-scripts
npm run check
npm pack --dry-run
```

包含真实 Pi ResourceLoader 的包/Skill 加载测试，以及文件创建、版本冲突、精确修改、接受/发布、未来状态隔离、来源过期、事务恢复、路径穿越、符号链接/硬链接等测试。测试不调用在线模型、不读取用户模型密钥、不改真实小说。

CI 配置覆盖 macOS/Linux、Node 22/24。本次本地验证为 macOS、Node 26；CI 配置不等于其远程运行结果。Windows 原生和真实模型创作质量需单独验证。

## 设计参考

受到 [Denova](https://github.com/alfredxw/denova) 将创作规则、长期设定、正文与人物状态分离的思路启发。本项目独立实现 Pi 插件，不调用 Denova 的专用 API，不复制其数据库或 UI。

- [Pi Extension 文档](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md)
- [Pi Skills 文档](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/skills.md)

MIT License。
