"use client";

import {
  AssetSchema,
  ProjectSchema,
  rebuild,
  type ProjectEvent,
} from "@loomina/ir";

/**
 * 事件日志的本地落点（ADR-0034）。
 *
 * 日志是事实，项目是它跑出来的结果（ADR-0011）。存日志而不是存快照：
 * 追加一条很便宜，回放一次就能拿到当前项目，也不需要为每种改动写序列化。
 *
 * 用 IndexedDB 而不是 localStorage：一张定妆图约 2.4MB 的 data URI，
 * 四个角色就顶破 localStorage 的 5MB 额度；IndexedDB 存得下，而且按条追加。
 */

/**
 * 本地日志的格式版本。**改动事件或项目结构时把它 +1**，并在 `migrateLog` 里补一段。
 * 没有版本号，一次 schema 改动就会让用户存下的项目整份判废。
 */
export const LOG_VERSION = 4;

export type StoredLog = {
  version: number;
  events: unknown[];
};

export type EventLog = {
  /** 版本与事件分开返回：版本决定要不要迁移，事件才决定能不能用 */
  load(): Promise<StoredLog>;
  append(event: ProjectEvent): Promise<void>;
  replace(events: ProjectEvent[]): Promise<void>;
};

/**
 * 认得的事件类型。
 *
 * 写成 record 而不是 Set：事件联合类型多一种，这里少一行就编译不过——
 * 2026-11-10 就是漏了 `dialogue.updated`，读回来整份日志判废、被示例项目覆盖。
 */
const EVENT_TYPES: Record<ProjectEvent["type"], true> = {
  "project.created": true,
  "project.updated": true,
  "shot.updated": true,
  "scene.updated": true,
  "scene.added": true,
  "shot.added": true,
  "scene.moved": true,
  "scene.removed": true,
  "shot.removed": true,
  "location.added": true,
  "location.updated": true,
  "location.removed": true,
  "character.added": true,
  "character.updated": true,
  "prop.added": true,
  "prop.updated": true,
  "character.removed": true,
  "prop.removed": true,
  "story.updated": true,
  "dialogue.updated": true,
  "dialogue.speaker.updated": true,
  "dialogue.added": true,
  "dialogue.removed": true,
  "subtitle.updated": true,
  "subtitle.layout.updated": true,
  "subtitle.translation.updated": true,
  "dialogue.translation.updated": true,
  "brand.updated": true,
  "voice.take.added": true,
  "voice.take.removed": true,
  "take.added": true,
  "approval.updated": true,
  "take.updated": true,
  "take.removed": true,
  "asset.updated": true,
  "asset.reviewed": true,
  "asset.removed": true,
  "timeline.updated": true,
  "timeline.music.updated": true,
  "timeline.sfx.updated": true,
  "timeline.mix.updated": true,
  "motif.updated": true,
  "motif.removed": true,
  "gate.confirmed": true,
  "gate.reopened": true,
  "publish.recorded": true,
  "publish.updated": true,
  "rights.updated": true,
  "rights.removed": true,
  "project.restored": true,
};

/**
 * 把读回来的东西变成可信的事件日志；有任何一条不像话就整份丢掉。
 *
 * 宁可从示例项目重来，也不要拿半截日志跑出一个坏项目——
 * 坏项目会让后面的每个事件都落在错误的前提上。
 */
export function parseEvents(raw: unknown): ProjectEvent[] | null {
  if (!Array.isArray(raw) || raw.length === 0) return null;

  const events: ProjectEvent[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") return null;
    const event = item as { type?: unknown; at?: unknown };
    if (typeof event.type !== "string" || !Object.hasOwn(EVENT_TYPES, event.type)) return null;
    if (typeof event.at !== "string") return null;
    events.push(item as ProjectEvent);
  }

  const first = events[0];
  if (!first || first.type !== "project.created") return null;

  try {
    // 快照按当前 schema 解析：缺省字段补齐，坏字段在这里就暴露
    first.project = ProjectSchema.parse(first.project);
    for (const event of events) {
      if (event.type === "asset.updated") {
        event.asset = AssetSchema.parse(event.asset);
      }
    }
    rebuild(events);
  } catch {
    return null;
  }

  return events;
}

/**
 * 按版本迁移旧日志，再交给 `parseEvents` 把关。
 *
 * - 比当前版本新：别的标签页/旧版本应用写的，别乱降级，直接放弃；
 * - 比当前版本旧：按顺序跑迁移函数。第 1 版之前没有版本号，按 1 处理；
 * - 迁移只改形状，不做猜测：猜错的东西比丢掉更难查。
 */
export function migrateLog(stored: StoredLog): ProjectEvent[] | null {
  if (!Number.isInteger(stored.version) || stored.version < 1) return null;
  if (stored.version > LOG_VERSION) return null;

  let events = stored.events;

  // 迁移链：
  // 1 → 2：Project 增加 `story`（ADR-0088），zod 默认值会补齐，事件本身不用改。
  // 2 → 3：Project 增加 `subtitleLayout`（D3），同样有默认值，事件不用改形状。
  // 3 → 4：Project 增加 `timeline.sfx` / `timeline.mix`（C7 / ADR-0184），
  //        同样有默认值；新事件类型只有新版本才写得出来。
  // 目前没有需要改形状的迁移，链保持空实现。
  if (stored.version < 2) {
    events = v1ToV2(events);
  }
  if (stored.version < 3) {
    events = v2ToV3(events);
  }
  if (stored.version < 4) {
    events = v3ToV4(events);
  }

  return parseEvents(events);
}

/** v2 → v3 同样只靠 zod 默认值补 `subtitleLayout`（D3），形状不变。 */
function v2ToV3(events: unknown[]): unknown[] {
  return events;
}

/** v3 → v4 靠 zod 默认值补音效层与三路平衡（C7 / ADR-0184），形状不变。 */
function v3ToV4(events: unknown[]): unknown[] {
  return events;
}

/** v1 的日志可以直接按当前 schema 解析：新增字段都有默认值（ADR-0088）。 */
function v1ToV2(events: unknown[]): unknown[] {
  return events;
}

/** 两次事件数组之间的差别：只追加就逐条写，重来一遍就整份覆盖。 */
export type EventSync =
  | { kind: "none" }
  | { kind: "append"; events: ProjectEvent[] }
  | { kind: "replace" };

export function diffEvents(prev: ProjectEvent[], next: ProjectEvent[]): EventSync {
  if (next === prev) return { kind: "none" };
  const appended =
    next.length > prev.length && prev.every((event, i) => event === next[i]);
  if (appended) return { kind: "append", events: next.slice(prev.length) };
  return { kind: "replace" };
}

// ── IndexedDB 实现 ───────────────────────────────────────────────

const DB_NAME = "loomina";
/**
 * 第 3 版加了模板仓（F3 / ADR-0180）；第 4 版加工作空间仓（C3 / ADR-0188）。
 * 事件、meta 与模板三仓升上来原样保留。
 */
const DB_VERSION = 4;
const STORE = "events";
const META = "meta";
const TEMPLATES = "templates";
const WORKSPACES = "workspaces";

/** 老日志（没有 workspaceId 的行）归这个工作空间：升级不搬家 */
export const DEFAULT_WORKSPACE_ID = "w-default";

export type WorkspaceMeta = {
  id: string;
  name: string;
  createdAt: string;
  lastOpenedAt: string;
};

type Row = { seq: number; event: ProjectEvent; workspaceId?: string };
type MetaRow = { key: string; version: number };

/** 本地库的连接：事件日志与模板（F3）共用，升级时一起建仓 */
export function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: "seq", autoIncrement: true });
      }
      // 第 1 版没有 meta：老的本地库升级上来后，`load` 会把版本当 1 处理
      if (!db.objectStoreNames.contains(META)) {
        db.createObjectStore(META, { keyPath: "key" });
      }
      // 第 3 版：项目模板（F3 / ADR-0180），主键是模板自带的 id
      if (!db.objectStoreNames.contains(TEMPLATES)) {
        db.createObjectStore(TEMPLATES, { keyPath: "id" });
      }
      // 第 4 版：工作空间（C3 / ADR-0188），主键是工作空间 id
      if (!db.objectStoreNames.contains(WORKSPACES)) {
        db.createObjectStore(WORKSPACES, { keyPath: "id" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("打不开本地库"));
  });
}

function settle<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("本地库读写失败"));
  });
}

function committed(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("本地库事务失败"));
    tx.onabort = () => reject(tx.error ?? new Error("本地库事务中止"));
  });
}

/** 一条行的所属工作空间：老行没有这个字段，归默认空间 */
const workspaceOfRow = (row: Row): string => row.workspaceId ?? DEFAULT_WORKSPACE_ID;

/**
 * 某个工作空间的事件日志（C3 / ADR-0188）。
 *
 * 所有工作空间共用 `events` 仓，按 `workspaceId` 过滤：老日志（没有这个字段）
 * 原样归 `w-default`，升级时不搬行、不改内容。meta 里的版本也按工作空间分开。
 */
export function indexedDbLogFor(workspaceId: string = DEFAULT_WORKSPACE_ID): EventLog {
  return {
    async load() {
      const db = await openDb();
      try {
        const tx = db.transaction([STORE, META], "readonly");
        const rows = await settle(tx.objectStore(STORE).getAll() as IDBRequest<Row[]>);
        const meta = await settle(
          tx.objectStore(META).get(`log:${workspaceId}`) as IDBRequest<MetaRow | undefined>,
        );
        return {
          version: meta?.version ?? 1,
          events: rows
            .filter((row) => workspaceOfRow(row) === workspaceId)
            .sort((a, b) => a.seq - b.seq)
            .map((row) => row.event),
        };
      } finally {
        db.close();
      }
    },

    async append(event) {
      const db = await openDb();
      try {
        const tx = db.transaction(STORE, "readwrite");
        tx.objectStore(STORE).add({ event, workspaceId });
        await committed(tx);
      } finally {
        db.close();
      }
    },

    async replace(events) {
      const db = await openDb();
      try {
        const tx = db.transaction([STORE, META], "readwrite");
        const store = tx.objectStore(STORE);
        // 只清这个工作空间的行：别的空间还在写，不能一起抹掉
        const cursor = store.openCursor();
        await new Promise<void>((resolve, reject) => {
          cursor.onsuccess = () => {
            const position = cursor.result;
            if (!position) {
              resolve();
              return;
            }
            if (workspaceOfRow(position.value as Row) === workspaceId) position.delete();
            position.continue();
          };
          cursor.onerror = () => reject(cursor.error ?? new Error("清工作空间失败"));
        });
        for (const event of events) store.add({ event, workspaceId });
        tx.objectStore(META).put({
          key: `log:${workspaceId}`,
          version: LOG_VERSION,
        } satisfies MetaRow);
        await committed(tx);
      } finally {
        db.close();
      }
    },
  };
}

export const indexedDbLog: EventLog = indexedDbLogFor(DEFAULT_WORKSPACE_ID);

// ── 工作空间（C3 / ADR-0188）────────────────────────────────────

/** 测试 / 非浏览器环境没有 IndexedDB：调用方据此跳过工作空间管理 */
export function hasWorkspaces(): boolean {
  return typeof indexedDB !== "undefined";
}

export async function listWorkspaces(): Promise<WorkspaceMeta[]> {
  if (!hasWorkspaces()) return [];
  const db = await openDb();
  try {
    const tx = db.transaction(WORKSPACES, "readonly");
    const rows = await settle(
      tx.objectStore(WORKSPACES).getAll() as IDBRequest<WorkspaceMeta[]>,
    );
    return rows.sort((a, b) => b.lastOpenedAt.localeCompare(a.lastOpenedAt));
  } finally {
    db.close();
  }
}

export async function saveWorkspace(meta: WorkspaceMeta): Promise<void> {
  if (!hasWorkspaces()) return;
  const db = await openDb();
  try {
    const tx = db.transaction(WORKSPACES, "readwrite");
    tx.objectStore(WORKSPACES).put(meta);
    await committed(tx);
  } finally {
    db.close();
  }
}

/**
 * 删掉一个工作空间（C15 / ADR-0201）：事件行、日志版本、登记表一起清。
 *
 * 只动这个空间自己的行：别的空间还在写，不能一起抹掉。
 * 素材文件不在这里删——字节是内容寻址、可能被别的空间用着（H3 管清理）。
 * 返回删掉了几条事件。
 */
export async function deleteWorkspace(workspaceId: string): Promise<number> {
  if (!hasWorkspaces()) return 0;
  const db = await openDb();
  try {
    const tx = db.transaction([STORE, META, WORKSPACES], "readwrite");
    const store = tx.objectStore(STORE);
    let removed = 0;
    const cursor = store.openCursor();
    await new Promise<void>((resolve, reject) => {
      cursor.onsuccess = () => {
        const position = cursor.result;
        if (!position) {
          resolve();
          return;
        }
        if (workspaceOfRow(position.value as Row) === workspaceId) {
          position.delete();
          removed += 1;
        }
        position.continue();
      };
      cursor.onerror = () => reject(cursor.error ?? new Error("删工作空间失败"));
    });
    tx.objectStore(META).delete(`log:${workspaceId}`);
    tx.objectStore(WORKSPACES).delete(workspaceId);
    await committed(tx);
    return removed;
  } finally {
    db.close();
  }
}

/**
 * 记住当前工作空间：换工作空间走整页加载（ADR-0188），
 * 下次打开还停在这个空间。
 */
const REMEMBERED_KEY = "loomina.workspace";

export function rememberWorkspace(id: string): void {
  try {
    localStorage.setItem(REMEMBERED_KEY, id);
  } catch {
    // 隐私模式 / 配额：记不住就回默认空间，不影响当前这一页
  }
}

export function rememberedWorkspace(): string {
  try {
    return localStorage.getItem(REMEMBERED_KEY) || DEFAULT_WORKSPACE_ID;
  } catch {
    return DEFAULT_WORKSPACE_ID;
  }
}

let current: EventLog = indexedDbLog;

export function getEventLog(): EventLog {
  return current;
}

/** 换掉存储实现：测试用，也可以在别的宿主里换成服务端。 */
export function setEventLog(log: EventLog): void {
  current = log;
}
