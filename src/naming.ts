import * as fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { safePath } from './storage.ts';

/** Human-readable, cross-platform filename stem. Never produces a safePath-rejecting name. */
export function slugify(title: string, maxBytes = 60): string {
  let s = title.trim()
    .replace(/[<>:"|?*\x00-\x1f\\/]/g, '')
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
