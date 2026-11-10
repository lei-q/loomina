"use client";

/**
 * 单写者锁（ADR-0034）。
 *
 * 同一浏览器里只让一个标签页往本地日志写：两个页面各写一半，日志就成了两条时间线，
 * 回放出来的项目谁也看不懂。Web Locks 是浏览器自带的，标签页关掉锁就自动放掉；
 * 不支持的环境（老浏览器、测试的 node）乐观放行，不为此拦住用户。
 */

let release: (() => void) | null = null;

export function claimWriter(): Promise<boolean> {
  const locks = typeof navigator === "undefined" ? undefined : navigator.locks;
  if (!locks) return Promise.resolve(true);

  return new Promise<boolean>((resolve) => {
    void locks.request("loomina-writer", { ifAvailable: true }, (lock) => {
      if (!lock) {
        resolve(false);
        return;
      }
      resolve(true);
      // 把锁一直握到标签页关闭；这里返回一个不结束的 Promise
      return new Promise<void>((done) => {
        release = done;
      });
    });
  });
}

/** 主动放锁（目前只有测试用得上；关标签页时浏览器自己会放）。 */
export function releaseWriter(): void {
  release?.();
  release = null;
}
