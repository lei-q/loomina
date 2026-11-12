import { randomUUID } from "node:crypto";

/**
 * 长任务的同一条队列（H2 / ADR-0135）。
 *
 * 渲染早就有一条自己的队列（ADR-0093），但它只排渲染：出图与出视频是
 * 另外两个同步请求，可以和 ffmpeg 同时跑，一起抢 CPU 和网络。作者的真实
 * 操作恰恰是「出完图顺手点视频，再点导出」，三条一起跑时机器会卡住，
 * 而且界面上没有任何地方说得清「现在到底在忙什么」。
 *
 * 这里只做两件事：**全局同时只跑一个长任务**，以及**把队伍摊开给人看**。
 *
 * 为什么挂在 `globalThis` 上：`next start` 下每个 route 是独立的 bundle，
 * 模块级变量不共享——渲染队列能工作只是因为它整条都在同一个 route 文件里。
 * 跨 route 要共享一份状态，只能挂到进程的全局对象上。
 */

export type LongJobKind = "render" | "image" | "video";

export const LONG_JOB_LABEL: Record<LongJobKind, string> = {
  render: "渲染成片",
  image: "出图",
  video: "出视频",
};

export type LongJobEntry = {
  id: string;
  kind: LongJobKind;
  /** 人话：渲的是哪条片子、出的是哪一格 */
  label: string;
  enqueuedAt: number;
  startedAt?: number;
};

type LongJobState = {
  active: LongJobEntry | null;
  waiting: LongJobEntry[];
  /** 释放时叫醒所有等待者，让它们各自再判一次是否轮到自己 */
  listeners: Set<() => void>;
};

const KEY = Symbol.for("loomina.long-job-queue");

function state(): LongJobState {
  const holder = globalThis as typeof globalThis & { [KEY]?: LongJobState };
  holder[KEY] ??= { active: null, waiting: [], listeners: new Set() };
  return holder[KEY];
}

/**
 * 占住唯一的长任务位置，跑完自动让给下一个。
 *
 * `task` 抛错也一定会让位：一个失败的出图不能把整条队列卡死。
 * `onWait` 只在真的排上了队时同步调用一次——界面据此把「等前面的跑完」
 * 写进状态，而不是先写一句马上又被覆盖。
 */
export async function withLongJobSlot<T>(
  kind: LongJobKind,
  label: string,
  task: () => Promise<T>,
  onWait?: () => void,
): Promise<T> {
  const s = state();
  const entry: LongJobEntry = {
    id: randomUUID(),
    kind,
    label: label.slice(0, 60),
    enqueuedAt: Date.now(),
  };
  // 能不能立刻开跑，在入队之前就知道：有人占着、或前面还排着别人，就得等
  const immediate = !s.active && s.waiting.length === 0;
  s.waiting.push(entry);
  if (!immediate) onWait?.();
  try {
    await acquire(s, entry);
    return await task();
  } finally {
    release(s, entry);
  }
}

function acquire(s: LongJobState, entry: LongJobEntry): Promise<void> {
  return new Promise<void>((resolve) => {
    const attempt = () => {
      // 必须同时满足「没人占」与「排在最前」：只看「没人占」会让后到的插队
      if (!s.active && s.waiting[0] === entry) {
        s.waiting.shift();
        s.active = entry;
        entry.startedAt = Date.now();
        resolve();
        return;
      }
      s.listeners.add(attempt);
    };
    attempt();
  });
}

function release(s: LongJobState, entry: LongJobEntry): void {
  if (s.active === entry) {
    s.active = null;
  } else {
    const at = s.waiting.indexOf(entry);
    if (at >= 0) s.waiting.splice(at, 1);
  }
  const listeners = [...s.listeners];
  s.listeners.clear();
  for (const listener of listeners) listener();
}

export type LongJobSnapshot = {
  active: { kind: LongJobKind; label: string; seconds: number } | null;
  waiting: { kind: LongJobKind; label: string; seconds: number }[];
};

/** 给健康面板看：现在在跑什么、后面还排着几个、各自等了多久 */
export function longJobSnapshot(now = Date.now()): LongJobSnapshot {
  const s = state();
  return {
    active: s.active
      ? {
          kind: s.active.kind,
          label: s.active.label,
          seconds: Math.round(((now - (s.active.startedAt ?? s.active.enqueuedAt)) / 1000) * 10) / 10,
        }
      : null,
    waiting: s.waiting.map((entry) => ({
      kind: entry.kind,
      label: entry.label,
      seconds: Math.round(((now - entry.enqueuedAt) / 1000) * 10) / 10,
    })),
  };
}

/** 测试用：队列是进程级的，每个用例之间要清干净 */
export function resetLongJobQueueForTests(): void {
  const s = state();
  s.active = null;
  s.waiting.length = 0;
  s.listeners.clear();
}
