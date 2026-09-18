import * as fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { safePath } from './storage.ts';

/**
 * Obsidian 链接里有语法含义的字符，绝不能出现在文件名中：
 *
 * - `#` 标题引用分隔符：`[[老张#简介]]` 会被当成「老张笔记的简介小节」，
 *   文件名里带 `#` 的笔记**永远无法被链接**。
 * - `|` 显示文本分隔符：`[[老张|张叔]]`。
 * - `^` 块引用分隔符。
 * - `[` `]` 链接定界符：`[[老张[旧版]]]` 解析有歧义。
 *
 * 这些字符在文件系统层面是合法的（macOS/Linux 都允许），所以不会有任何报错，
 * 只会在 Obsidian 里静默地链接不上 —— 因此必须在生成文件名时就剥掉。
 */
const OBSIDIAN_UNSAFE = /[[\]#^|]/;

/** 文件系统层面非法的字符，另加 Windows 保留名与尾随点号空格。 */
const FS_UNSAFE = /[<>:"|?*\x00-\x1f\\/]/;

/** 名字里是否含有会破坏 Obsidian 链接的字符。用于提醒作者，不用于拒绝读取。 */
export function obsidianUnsafe(name: string): boolean {
  return OBSIDIAN_UNSAFE.test(name);
}

/** Human-readable, cross-platform, Obsidian-link-safe filename stem. */
export function slugify(title: string, maxBytes = 60): string {
  let s = title.trim()
    .replace(new RegExp(FS_UNSAFE.source, 'g'), '')
    .replace(new RegExp(OBSIDIAN_UNSAFE.source, 'g'), '')
    .replace(/\s+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-. ]+|[-. ]+$/g, '');
  while (Buffer.byteLength(s, 'utf8') > maxBytes) s = Array.from(s).slice(0, -1).join('').replace(/[-. ]+$/, '');
  if (!s || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(s)) s = `untitled-${randomUUID().slice(0, 8)}`;
  return s;
}

/** Unique relative path dir/base(-N)ext, compared case-insensitively against real siblings. */
export async function uniquePath(root: string, dir: string, base: string, ext = '.md'): Promise<string> {
  let existing: Set<string>;
  try {
    existing = new Set((await fs.readdir(path.join(root, dir))).map(n => n.toLowerCase()));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    existing = new Set();
  }
  for (let i = 1; ; i++) {
    const name = i === 1 ? `${base}${ext}` : `${base}-${i}${ext}`;
    if (!existing.has(name.toLowerCase())) {
      const rel = `${dir}/${name}`;
      await safePath(root, rel);
      return rel;
    }
  }
}
