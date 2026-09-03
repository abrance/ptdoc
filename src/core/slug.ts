/** 由标题文本生成稳定锚点 slug。中英文混排均可；确定性生成，供 TOC 与静态站点共用。 */
export function slugify(text: string): string {
  const s = text.trim().toLowerCase();
  const base = s
    .replace(/[`~!@#$%^&*()+=|{}[\]\\:;"'<>,.?/]/g, ' ')
    .replace(/\s+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return base || 'sec';
}

/** 为一组标题文本生成互不冲突的锚点 id（按出现顺序，冲突追加 -2、-3…）。 */
export function headingSlugs(texts: string[]): string[] {
  const seen = new Map<string, number>();
  return texts.map((t) => {
    const base = slugify(t);
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    return n === 1 ? base : `${base}-${n}`;
  });
}
