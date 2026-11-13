"use client";

/**
 * 单写者锁（ADR-0034 / ADR-0188）。
 *
 * 同一浏览器里只让一个标签页往**同一个工作空间**的日志写：两个页面各写一半，
 * 日志就成了两条时间线，回放出来的项目谁也看不懂。不同工作空间各有各的锁，
 * 两个标签页可以同时开两条完整流程（C3）。
 *
 * Web Locks 是浏览器自带的，标签页关掉锁就自动放掉；不支持的环境
 * （老浏览器、测试的 node）乐观放行，不为此拦住用户。
 */

const releases = new Map<string, () => void>();

export function claimWriter(workspaceId = "w-default"): Promise<boolean> {
  const locks = typeof navigator === "undefined" ? undefined : navigator.locks;
  if (!locks) return Promise.resolve(true);

  const name = `loomina-writer:${workspaceId}`;
  return new Promise<boolean>((resolve) => {
    void locks.request(name, { ifAvailable: true }, (lock) => {
      if (!lock) {
        resolve(false);
        return;
      }
      resolve(true);
      // 把锁一直握到标签页关闭；这里返回一个不结束的 Promise
      return new Promise<void>((done) => {
        releases.set(workspaceId, done);
      });
    });
  });
}

/** 主动放锁（换工作空间 / 测试用；关标签页时浏览器自己会放）。 */
export function releaseWriter(workspaceId?: string): void {
  if (workspaceId !== undefined) {
    releases.get(workspaceId)?.();
    releases.delete(workspaceId);
    return;
  }
  for (const release of releases.values()) release();
  releases.clear();
}
