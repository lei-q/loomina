"use client";

import { openDb } from "@/lib/event-log";
import type { ProjectTemplate } from "@/lib/project-template";
import { looksLikeShotTemplate, type ShotTemplate } from "@/lib/shot-template";

/**
 * 项目模板的本地仓（F3 / ADR-0180）。
 *
 * 与事件日志同一个 IndexedDB（库 `loomina`，仓 `templates`），但**不进事件日志**：
 * 模板不是某个项目的历史，而是「这台机器上我攒下的班底」。
 * 放进日志会让每个项目的回放都多一条与它无关的记录。
 */

const STORE = "templates";

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

/** 像不像一份模板：读回来的数据可能来自旧版本，宁可丢掉也不让它把界面弄崩 */
function looksLikeTemplate(value: unknown): value is ProjectTemplate {
  if (!value || typeof value !== "object") return false;
  const template = value as Partial<ProjectTemplate>;
  return (
    template.format === "loomina.template" &&
    typeof template.id === "string" &&
    typeof template.name === "string" &&
    Array.isArray(template.cast) &&
    Array.isArray(template.locations) &&
    Array.isArray(template.props) &&
    Array.isArray(template.assets)
  );
}

/** 存一份模板（同名不合并：id 不同就是两份，作者自己删） */
export async function saveTemplate(template: ProjectTemplate): Promise<void> {
  const db = await openDb();
  try {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(template);
    await committed(tx);
  } finally {
    db.close();
  }
}

/** 列出所有模板，最近存的在前 */
export async function listTemplates(): Promise<ProjectTemplate[]> {
  const db = await openDb();
  try {
    const rows = await settle(
      db.transaction(STORE, "readonly").objectStore(STORE).getAll() as IDBRequest<unknown[]>,
    );
    return rows
      .filter(looksLikeTemplate)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  } catch {
    // 没有模板仓（第一次打开、或别的标签页还在旧版本）时当空的处理
    return [];
  } finally {
    db.close();
  }
}

/** 镜头模板（F3 / ADR-0207）：与班底模板同一个仓，靠 `format` 区分 */
export async function saveShotTemplate(template: ShotTemplate): Promise<void> {
  const db = await openDb();
  try {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(template);
    await committed(tx);
  } finally {
    db.close();
  }
}

/** 列出镜头模板，最近存的在前；班底模板与坏数据都跳过 */
export async function listShotTemplates(): Promise<ShotTemplate[]> {
  const db = await openDb();
  try {
    const rows = await settle(
      db.transaction(STORE, "readonly").objectStore(STORE).getAll() as IDBRequest<unknown[]>,
    );
    return rows
      .filter(looksLikeShotTemplate)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  } catch {
    // 没有模板仓时当空的处理，与班底模板同一口径
    return [];
  } finally {
    db.close();
  }
}

export async function removeShotTemplate(id: string): Promise<void> {
  const db = await openDb();
  try {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).delete(id);
    await committed(tx);
  } finally {
    db.close();
  }
}

export async function removeTemplate(id: string): Promise<void> {
  const db = await openDb();
  try {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).delete(id);
    await committed(tx);
  } finally {
    db.close();
  }
}
