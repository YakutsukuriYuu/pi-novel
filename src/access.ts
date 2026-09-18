/**
 * 工具准入与只读边界。
 *
 * 这里是插件唯一的安全边界，所以规则必须是**默认拒绝**：
 * 不在白名单里的一律拦下。理由不是洁癖，而是两种失败模式的代价差太远 ——
 *
 * - 白名单漏一项 → 某个只读工具不能用。烦，但无损，改一行就好。
 * - 黑名单漏一项 → 模型绕过保护改坏原稿，而且**事务系统记不到**：
 *   `commit()` 只被插件自己的操作调用，`bash`/`edit`/`write`/子代理写出来的改动
 *   不进 `.novel/transactions/`，等于没有回滚点。
 *
 * 实测过的三个「朴素黑名单会漏掉」的口子，都在同一台机器上：
 * - `subagent`：子代理自带 `read, grep, find, ls, bash, edit, write`
 * - `ast_grep_replace`：能改文件（`apply: true` 落盘），名字里却没有任何写工具的痕迹
 * - `pi_lens_activate_tools`：一句话就能把上面那个激活
 *
 * 所以：**只往白名单加只读工具，绝不因为「这个扩展我信任」就放宽成白名单之外。**
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * pi 内建里可以放行的只读工具。
 *
 * `bash` / `edit` / `write` / `powershell` 永远不在此列 —— 它们就是这道边界要拦的东西。
 */
export const BUILTIN_READONLY = ['read', 'grep', 'find', 'ls'] as const;

/**
 * 额外放行的只读外部工具。
 *
 * - `ffgrep` / `fffind`：fff 的只读搜索，比内建 grep/find 更快。
 * - `web_search` / `web_fetch`：写小说要考据（地名、年代、专业细节），只读、不碰文件。
 *
 * 这些都是**只读**的。放行它们不削弱保护，只是别让作者为了查个资料就得 /novel close。
 */
export const EXTERNAL_READONLY = ['ffgrep', 'fffind', 'web_search', 'web_fetch'] as const;

export const readOnlyTools: ReadonlySet<string> = new Set<string>([...BUILTIN_READONLY, ...EXTERNAL_READONLY]);

/** 插件自己提供的工具。 */
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

/**
 * 允许调用的工具。
 *
 * `extra` 来自作者的 `~/.pi/agent/pi-novel.json`，**只能追加**：内置白名单永远生效，
 * 无法通过配置缩减。凭据是作者的，所以他不被禁止放宽边界 —— 但不能靠改配置把
 * 内置的只读集变小。
 */
export function allowedTool(name: string, extra: readonly string[] = []): boolean {
  return readOnlyTools.has(name) || (NOVEL_TOOLS as readonly string[]).includes(name) || extra.includes(name);
}

/** 带 `path` 参数、因此需要做边界检查的只读工具。 */
export const READ_PATH_TOOLS: ReadonlySet<string> = new Set([
  'read', 'grep', 'find', 'ls', 'ffgrep', 'fffind',
]);

function inside(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

/**
 * 解析到真实路径；路径本身不存在时，沿不存在的部分向上找到第一个存在的祖先再拼回去。
 *
 * 必须**两边都用它**，把词法解析与真实路径解析合成一步。
 * 分开做会自相矛盾：macOS 上 `/var` 是指向 `/private/var` 的链接，
 * 用未规范化的绝对路径做词法判定、拿规范化后的 root 去比，两者必然对不上。
 * 测试就是这么发现问题的。
 */
async function canonical(target: string): Promise<string> {
  const direct = await fs.realpath(target).catch(() => null);
  if (direct !== null) return direct;
  const parent = path.dirname(target);
  if (parent === target) return target;
  return path.join(await canonical(parent), path.basename(target));
}

/**
 * 只读工具想访问的路径是否跑出了项目。
 *
 * `../别的书/x.md`、绝对路径、`~/x` 都会解析到项目外 → 拦下。
 * 项目内指向外部的符号链接也会被发现 —— 因为候选路径要解析真实路径。
 * glob 不会误伤：`**\/*.md` 解析后仍在 root 之内。
 */
export async function escapesProject(root: string, candidate: string): Promise<boolean> {
  const canonRoot = await canonical(root);
  const expanded = candidate.startsWith('~/') ? path.join(os.homedir(), candidate.slice(2)) : candidate;
  const canonTarget = await canonical(path.resolve(canonRoot, expanded));
  return !inside(canonRoot, canonTarget);
}

/** 从工具参数里取出待检查的路径。只认 `path` —— 实测内建与 fff 都用这个名字。 */
export function pathArgument(input: unknown): string | null {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return null;
  const value = (input as Record<string, unknown>).path;
  return typeof value === 'string' && value.length > 0 ? value : null;
}
