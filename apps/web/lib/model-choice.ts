"use client";

import { useCallback, useEffect, useState } from "react";
import type { ModelPins } from "@loomina/ir";
import type { Modality, PublicConfig } from "./config-types";

/**
 * 页面级模型选择（H22）。
 *
 * 选择存 localStorage，按模态分开：故事页选文本模型，不影响声音页的配音模型。
 * 没选就是空字符串——请求不带 modelId，服务端用该模态的默认。
 */

const EVENT = "loomina:model-choice";

function keyOf(modality: Modality): string {
  return `loomina.model.${modality}`;
}

export function getModelChoice(modality: Modality): string | undefined {
  if (typeof window === "undefined") return undefined;
  try {
    return window.localStorage.getItem(keyOf(modality)) || undefined;
  } catch {
    return undefined;
  }
}

/**
 * 这次请求该用哪个模型：项目固定优先，没固定才看本机选择。
 *
 * 固定值写进 IR（H22），换浏览器、刷新、重放日志都还在；
 * 本机选择只影响没固定的模态。
 */
export function modelIdFor(
  modality: Modality,
  pinned?: ModelPins,
): string | undefined {
  return pinned?.[modality] ?? getModelChoice(modality);
}

export function setModelChoice(modality: Modality, id?: string): void {
  if (typeof window === "undefined") return;
  try {
    if (id) window.localStorage.setItem(keyOf(modality), id);
    else window.localStorage.removeItem(keyOf(modality));
  } catch {
    // 隐私模式写不进就不记；这次请求仍然按当前值发
  }
  window.dispatchEvent(new CustomEvent(EVENT, { detail: { modality, id } }));
}

export function useModelChoice(
  modality: Modality,
): [string | undefined, (id?: string) => void] {
  const [choice, setChoice] = useState<string | undefined>();
  useEffect(() => {
    setChoice(getModelChoice(modality));
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<{ modality: Modality; id?: string }>).detail;
      if (detail?.modality === modality) setChoice(detail.id);
    };
    window.addEventListener(EVENT, handler);
    return () => window.removeEventListener(EVENT, handler);
  }, [modality]);
  const choose = useCallback((id?: string) => setModelChoice(modality, id), [modality]);
  return [choice, choose];
}

let cached: PublicConfig | null = null;
let pending: Promise<PublicConfig | null> | null = null;

export function fetchModelConfig(force = false): Promise<PublicConfig | null> {
  if (force) {
    cached = null;
    pending = null;
  }
  if (cached) return Promise.resolve(cached);
  pending ??= fetch("/api/config", { cache: "no-store" })
    .then(async (response) => {
      if (!response.ok) throw new Error(String(response.status));
      const config = (await response.json()) as PublicConfig;
      cached = config;
      return config;
    })
    .catch(() => {
      pending = null;
      return null;
    });
  return pending;
}

export function invalidateModelConfig(): void {
  cached = null;
  pending = null;
}

/** 配置页保存后，让所有页面重新拉一次选项。 */
export function useModelCatalog(): PublicConfig | null {
  const [config, setConfig] = useState<PublicConfig | null>(cached);
  useEffect(() => {
    let alive = true;
    void fetchModelConfig().then((next) => {
      if (alive && next) setConfig(next);
    });
    return () => {
      alive = false;
    };
  }, []);
  return config;
}
