"use client";

import Link from "next/link";
import { useEffect } from "react";
import { MODALITY_LABEL, type Modality } from "@/lib/config-types";
import { useModelCatalog, useModelChoice } from "@/lib/model-choice";
import { cn } from "@/lib/utils";

/**
 * 页面里的模型下拉（H22）。
 *
 * 不作为时请求不带 modelId，服务端用默认；选了才覆盖本页。
 * 选项来自 `/api/config` 的脱敏目录，密钥不会经过浏览器。
 */
export function ModelPicker({
  modality,
  className,
  label,
}: {
  modality: Modality;
  className?: string;
  label?: string;
}) {
  const config = useModelCatalog();
  const [choice, choose] = useModelChoice(modality);
  const name = label ?? `${MODALITY_LABEL[modality]}模型`;

  // 配置里删掉的模型不再存在于目录：清掉旧选择，别让之后每次请求都带一个死 id
  const options = config?.catalog[modality];
  useEffect(() => {
    if (!options || !choice) return;
    if (!options.some((option) => option.id === choice)) choose(undefined);
  }, [options, choice, choose]);

  if (!config) return null;
  if (!options || options.length === 0) {
    return (
      <Link
        href="/settings"
        className={cn(
          "rounded-token border border-line px-2.5 py-1 text-[10px] text-muted transition-colors duration-[var(--dur)] hover:border-line-2 hover:text-text",
          className,
        )}
      >
        配置{name}
      </Link>
    );
  }

  const valid = options.some((option) => option.id === choice) ? choice : undefined;
  const fallback = options.find((option) => option.id === config.defaults[modality]);
  // 只有一家供应商时不必每行都重复供应商名，下拉只写模型名
  const oneProvider = new Set(options.map((option) => option.providerName)).size <= 1;

  return (
    <label className={cn("flex items-center gap-1.5 text-[9.5px] text-muted-2", className)}>
      <span className="whitespace-nowrap">{name}</span>
      <select
        value={valid ?? ""}
        onChange={(event) => choose(event.target.value || undefined)}
        className="max-w-[220px] rounded-token border border-line bg-bg px-1.5 py-1 text-[10px] text-muted focus:border-line-2 focus:outline-none"
      >
        <option value="">默认 · {fallback?.model ?? "未设"}</option>
        {options.map((option) => (
          <option key={option.id} value={option.id}>
            {oneProvider ? option.model : `${option.providerName} / ${option.model}`}
          </option>
        ))}
      </select>
    </label>
  );
}
