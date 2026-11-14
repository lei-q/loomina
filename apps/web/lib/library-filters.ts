/**
 * 版本库 / 废片库的通用筛选与分页（C14 第六档 / ADR-0205）。
 *
 * 全部是纯函数：从日志重建出来的清单很长，但「看哪几条」只是界面状态，
 * 不写 IR、不进事件日志、不改日志版本。
 */

/** 搜索：大小写无关，多个词用空格分开，全部命中才算 */
export function matchQuery(haystack: string[], query: string): boolean {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const text = haystack.join("\n").toLowerCase();
  return words.every((word) => text.includes(word));
}

/** 分页：页码从 0 数，越界自动收回到最后一页 */
export function paginate<T>(items: T[], page: number, pageSize: number): {
  rows: T[];
  page: number;
  pageCount: number;
  total: number;
} {
  const total = items.length;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const safe = Math.min(Math.max(0, page), pageCount - 1);
  return {
    rows: items.slice(safe * pageSize, (safe + 1) * pageSize),
    page: safe,
    pageCount,
    total,
  };
}
