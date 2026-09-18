/**
 * 插件自己的配置：`~/.pi/agent/pi-novel.json`
 *
 * 放全局而不是每本书一份 ——「你装了哪些扩展」是**你的环境**属性，
 * 不是某本书的属性。每本书复制一份必然漂移。
 *
 * 插件**不主动创建**这个文件：不往你的 pi 配置目录里塞东西。需要时你自己建。
 * 文件不存在、读不了、格式坏，一律退回默认值继续工作 —— 但会把问题报出来，
 * 因为「以为加了工具其实没生效」比直接报错更难查。
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

export interface NovelConfig {
  /**
   * 额外放行的工具名。**只能追加**，无法通过它缩减内置白名单。
   *
   * 加什么就完全信任什么 —— 插件不检查「你加的是不是写工具」，
   * 因为那需要一张「已知能写」的清单，而清单永远不全（`ast_grep_replace`
   * 能改文件，名字里却没有任何写工具的痕迹）。用 `novel_check` 看当前生效的边界。
   */
  additionalAllowedTools: string[];
  /** 关闭只读工具的项目边界。默认 false，即边界生效。 */
  allowReadOutsideProject: boolean;
}

export const DEFAULT_CONFIG: NovelConfig = {
  additionalAllowedTools: [],
  allowReadOutsideProject: false,
};

export interface ConfigLoad {
  config: NovelConfig;
  /** 实际读取的路径，供界面显示。 */
  path: string;
  /** 文件存在但有问题时的说明。为 null 表示一切正常或文件本来就不存在。 */
  problem: string | null;
}

export function defaultConfigPath(): string {
  return path.join(os.homedir(), '.pi', 'agent', 'pi-novel.json');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export async function loadConfig(file = defaultConfigPath()): Promise<ConfigLoad> {
  const config: NovelConfig = { ...DEFAULT_CONFIG };
  let text: string;
  try {
    text = await fs.readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { config, path: file, problem: null };
    return { config, path: file, problem: `读不了：${(error as Error).message}` };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return { config, path: file, problem: `不是合法 JSON：${(error as Error).message}` };
  }
  if (!isRecord(parsed)) return { config, path: file, problem: '顶层必须是一个对象' };

  const problems: string[] = [];

  const extra = parsed.additionalAllowedTools;
  if (extra !== undefined) {
    if (!Array.isArray(extra)) {
      problems.push('additionalAllowedTools 必须是字符串数组');
    } else {
      const bad = extra.filter((n) => typeof n !== 'string' || n.trim() === '');
      if (bad.length) problems.push(`additionalAllowedTools 里有 ${bad.length} 项不是非空字符串，已忽略`);
      config.additionalAllowedTools = extra
        .filter((n): n is string => typeof n === 'string' && n.trim() !== '')
        .map((n) => n.trim());
    }
  }

  const outside = parsed.allowReadOutsideProject;
  if (outside !== undefined) {
    if (typeof outside !== 'boolean') problems.push('allowReadOutsideProject 必须是 true 或 false');
    else config.allowReadOutsideProject = outside;
  }

  return { config, path: file, problem: problems.length ? problems.join('；') : null };
}
