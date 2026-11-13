/**
 * 版本对比（C2 / C14 / ADR-0205）。
 *
 * 两个版本都是作者写的整份文本：按行多重集比，不追求逐行 diff。
 * 改一个字会同时出现在「多 / 少」两栏——这是有意的：一眼能看出
 * 「少了哪句、多了哪句」，不需要 LCS 把两行糊成一个改动块。
 */
export type TextDiff = { added: string[]; removed: string[] };

function lineCounts(text: string): Map<string, number> {
  const map = new Map<string, number>();
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    map.set(line, (map.get(line) ?? 0) + 1);
  }
  return map;
}

function excess(from: Map<string, number>, to: Map<string, number>): string[] {
  const out: string[] = [];
  for (const [line, n] of from) {
    const rest = n - (to.get(line) ?? 0);
    for (let i = 0; i < rest; i += 1) out.push(line);
  }
  return out;
}

/** `added` = 后者比前者多出来的行；`removed` = 前者有、后者没有的行 */
export function textDiff(before: string, after: string): TextDiff {
  const a = lineCounts(before);
  const b = lineCounts(after);
  return { added: excess(b, a), removed: excess(a, b) };
}
