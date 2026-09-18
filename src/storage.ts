import * as fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { decode, encode, hash } from './markdown.ts';
import { AREAS, ROOT_DOCS } from './kinds.ts';

export interface Change { path: string; before: string | null; after: string | null }
/**
 * 受管路径判定。常目白名单来自 kinds.ts，因此新增种类时不可能忘记同步这里
 * ——改造前 `kinds` / `areas` / `paths()` 各有一份，三份必然漂移。
 */
export function contentPath(name: string): boolean {
  return ROOT_DOCS.has(name) || (AREAS.has(name.split('/')[0] ?? '') && name.endsWith('.md'));
}
export async function safePath(root: string, name: string): Promise<string> {
  if (!name || name.includes('\\') || name.includes('\0') || path.isAbsolute(name) || name.split('/').some(p => !p || p === '.' || p === '..' || /[<>:"|?*\x00-\x1f]/.test(p) || /[. ]$/.test(p) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p))) throw new Error(`Unsafe relative path: ${name}`);
  let current = root;
  for (const component of name.split('/')) {
    current = path.join(current, component);
    try {
      const stat = await fs.lstat(current);
      if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile()) || (stat.isFile() && stat.nlink > 1)) throw new Error(`Unsupported link/special file: ${name}`);
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  return current;
}
export async function readOptional(root: string, name: string): Promise<string | null> {
  try { return await fs.readFile(await safePath(root, name), 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
}
async function atomic(root: string, name: string, text: string | null): Promise<void> {
  const target = await safePath(root, name);
  if (text === null) { await fs.unlink(target).catch(error => { if (error.code !== 'ENOENT') throw error; }); return; }
  await fs.mkdir(path.dirname(target), { recursive: true });
  const temp = path.join(path.dirname(target), `.${path.basename(target)}.${randomUUID()}.md`);
  try {
    const handle = await fs.open(temp, 'wx');
    try { await handle.writeFile(text, 'utf8'); await handle.sync(); } finally { await handle.close(); }
    await fs.rename(temp, target);
  } finally { await fs.unlink(temp).catch(() => {}); }
}

/** Exclusive across cooperating plugin processes. Never steals a possibly-live lock. */
export async function locked<T>(root: string, work: () => Promise<T>): Promise<T> {
  const lock = await safePath(root, '.novel/lock');
  try { await fs.mkdir(lock); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('Project locked. Stop other writers; see docs/recovery.md before manually removing .novel/lock.');
    throw error;
  }
  try {
    await fs.writeFile(path.join(lock, 'owner.md'), `# Active writer\n\nPID: ${process.pid}\nStarted: ${new Date().toISOString()}\n`);
    return await work();
  } finally { await fs.rm(lock, { recursive: true }); }
}
async function journals(root: string, folder: string): Promise<string[]> {
  const dir = await safePath(root, folder);
  try { return (await fs.readdir(dir)).filter(n => !n.startsWith('.') && n.endsWith('.md')).sort().map(n => `${folder}/${n}`); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
}
export async function transactionFiles(root: string): Promise<string[]> {
  return [...await journals(root, '.novel/transactions'), ...await pending(root)].sort((a, b) => path.basename(a).localeCompare(path.basename(b)));
}
export async function pending(root: string): Promise<string[]> {
  // Do not parse years of full-text backups on every keystroke/save.
  return journals(root, '.novel/pending');
}
async function moveJournal(root: string, from: string, to: string): Promise<void> {
  const target = await safePath(root, to);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.rename(await safePath(root, from), target);
}
/** Caller holds the project lock and project mutation queue. Journals retain exact old/new Markdown. */
export async function commit(root: string, changes: Change[], title: string, options: { allowUnmanaged?: boolean } = {}): Promise<string> {
  if ((await pending(root)).length) throw new Error('Unfinished transaction: recover it before writing.');
  if (!changes.length) throw new Error('No changes');
  const seen = new Set<string>();
  for (const c of changes) {
    // 迁移需要删除位于旧目录（lore/、setting/ …）的文件，那些路径按新规则已不受管。
    // 收编要搬动的源文件本来就在受管目录之外，所以它需要这个放行；
    // 路径本身已在前面经过 readOptional → safePath 校验。
    if (!options.allowUnmanaged && !contentPath(c.path)) throw new Error(`Unmanaged write: ${c.path}`);
    await safePath(root, c.path);
    const key = c.path.toLowerCase();
    if (seen.has(key)) throw new Error('Duplicate transaction path');
    seen.add(key);
    if (await readOptional(root, c.path) !== c.before) throw new Error(`Revision conflict: ${c.path}`);
  }
  const id = `${Date.now()}-${randomUUID()}`;
  const journal = `.novel/pending/${id}.md`;
  // 权限随事务走：迁移需要删除位于旧目录的文件，那些路径按新规则已不受管。
  // 把标记写进 journal，这样恢复时不必依赖调用方记得传参，也防止普通事务意外获得这个权限。
  const meta = { id, kind: 'transaction', title, status: 'pending', ...(options.allowUnmanaged ? { allowUnmanaged: true } : {}), changes };
  await atomic(root, journal, encode(meta, '# Change transaction\n\nExact Markdown snapshots are stored above. Do not edit this journal.'));
  // Re-check immediately before each write; partial failure deliberately leaves a recoverable journal.
  for (const c of changes) {
    if (await readOptional(root, c.path) !== c.before) throw new Error(`Concurrent edit: ${c.path}; transaction ${id} requires recovery.`);
    await atomic(root, c.path, c.after);
  }
  await atomic(root, journal, encode({ ...meta, status: 'committed' }, '# Committed transaction'));
  await moveJournal(root, journal, `.novel/transactions/${id}.md`);
  return id;
}
export async function rollback(root: string, id: string): Promise<void> {
  if (!/^[0-9]+-[a-f0-9-]+$/.test(id)) throw new Error('Invalid transaction ID');
  const journal = `.novel/pending/${id}.md`;
  const archived = `.novel/transactions/${id}.md`;
  if ((await pending(root)).some(p => p !== journal)) throw new Error('Recover the unfinished transaction first');
  const pendingText = await readOptional(root, journal);
  const text = pendingText ?? await readOptional(root, archived);
  if (!text) throw new Error('Transaction not found');
  const { meta } = decode(text);
  if (meta.kind !== 'transaction' || meta.id !== id) throw new Error('Invalid transaction identity');
  if (!['pending', 'committed'].includes(meta.status) && !(pendingText && meta.status === 'rolled-back')) throw new Error('Transaction already recovered');
  const changes = meta.changes as Change[];
  if (!Array.isArray(changes) || !changes.length) throw new Error('Invalid transaction');
  // 收编一个不受管的文件时需要放行受管路径检查（adopt 的整个意义就在于此）。
  // 路径穿越仍然由 safePath 拦着（readOptional/atomic 都会调它）。
  const relaxPaths = meta.allowUnmanaged === true;
  const targets = new Set<string>();
  for (const c of changes) {
    if (!c || typeof c.path !== 'string' || (!relaxPaths && !contentPath(c.path)) || (c.before !== null && typeof c.before !== 'string') || (c.after !== null && typeof c.after !== 'string')) throw new Error('Invalid transaction target/snapshot');
    if (targets.has(c.path.toLowerCase())) throw new Error('Duplicate transaction target');
    targets.add(c.path.toLowerCase());
    const now = await readOptional(root, c.path);
    if (meta.status === 'rolled-back' ? now !== c.before : now !== c.after && !(meta.status === 'pending' && now === c.before)) throw new Error(`Recovery conflict: ${c.path}; preserve external edits first.`);
  }
  // Move the journal before touching content so interrupted rollback is discoverable.
  if (!pendingText) await moveJournal(root, archived, journal);
  // Write-ahead marker makes recovery itself restartable.
  await atomic(root, journal, encode({ ...meta, status: 'pending' }, '# Recovery in progress'));
  for (const c of [...changes].reverse()) {
    const now = await readOptional(root, c.path);
    if (now !== c.before && now !== c.after) throw new Error(`Recovery conflict: ${c.path}`);
    await atomic(root, c.path, c.before);
  }
  await atomic(root, journal, encode({ ...meta, status: 'rolled-back' }, '# Rolled back'));
  await moveJournal(root, journal, archived);
}
/**
 * 当前目录本身是不是小说项目根。
 *
 * **只看这一个目录，不往上找。** 一个目录就是一本书：只有在本目录放了
 * `.novel/project.md` 才算激活，父目录的标记与本目录无关。
 *
 * 早先的实现会一路向上找到文件系统根，于是「A 是小说、B 是 A 的子目录」时
 * 在 B 里打开 Pi 会激活 A —— 一本书悄悄变成了另一本书的一部分。
 * 而那种行为无法区分「B 是 A 的子目录」与「B 是还没初始化的新书」，
 * 所以直接取消上溯，让规则完全可预测。
 */
/** 解析真实路径；目录不存在时返回 null（不存在就不是小说根，不该抛异常）。 */
async function realRoot(cwd: string): Promise<string | null> {
  try {
    return await fs.realpath(cwd);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

export async function projectAt(cwd: string): Promise<string | undefined> {
  const root = await realRoot(cwd);
  if (root === null) return undefined;
  const marker = await readOptional(root, '.novel/project.md');
  if (marker === null) return undefined;
  return root;
}

/**
 * 向上找到最近的项目根。
 *
 * **只用于在界面上给一句提示，绝不用于激活。**
 * 开在小说的子目录里会静默失去写入保护（模型会拿到 bash/edit/write，skill 也不加载），
 * 这是很隐蔽的坑，值得提醒；但按「一个目录就是一本书」的规则，
 * 提醒不能变成替用户激活父目录。
 */
export async function projectAbove(cwd: string): Promise<string | undefined> {
  let root = await realRoot(cwd);
  if (root === null) return undefined;
  for (;;) {
    const parent = path.dirname(root);
    if (parent === root) return undefined;
    root = parent;
    if (await readOptional(root, '.novel/project.md') !== null) return root;
  }
}

export async function revision(root: string, name: string): Promise<string> {
  const text = await readOptional(root, name);
  if (text === null) throw new Error(`Not found: ${name}`);
  return hash(text);
}
