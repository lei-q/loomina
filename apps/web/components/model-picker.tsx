"use client";

import Link from "next/link";
import { useEffect } from "react";
import { MODALITY_LABEL, type Modality } from "@/lib/config-types";
import { useModelCatalog, useModelChoice } from "@/lib/model-choice";
import { useWorkbench } from "@/lib/workbench-store";
import { cn } from "@/lib/utils";

/**
 * 页面里的模型下拉（H22）。
 *
 * 不作为时请求不带 modelId，服务端用默认；选了才覆盖本页。
 * 选项来自 `/api/config` 的脱敏目录，密钥不会经过浏览器。
 *
 * 「钉住」把当前模型写进项目（H22）：提示词、报价与生成都跟着项目走，
 * 换浏览器打开同一个项目也还是这个模型；不钉就只是这台浏览器的页面选择。
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
  const [localChoice, chooseLocal] = useModelChoice(modality);
  const pin = useWorkbench((state) => state.project.models[modality]);
  const setModelPin = useWorkbench((state) => state.setModelPin);
  const readOnly = useWorkbench((state) => state.readOnly);
  const choice = pin ?? localChoice;
  const choose = (id?: string) => {
    // 钉住时改下拉就是改项目；选回「默认」则取消钉住，回到本机选择
    if (pin !== undefined) setModelPin(modality, id ?? null);
    else chooseLocal(id);
  };
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
    <span className={cn("flex items-center gap-1.5 text-[9.5px] text-muted-2", className)}>
      <label className="flex items-center gap-1.5">
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
      <button
        type="button"
        disabled={readOnly || (!pin && !valid)}
        onClick={() => setModelPin(modality, pin ? null : (valid ?? null))}
        title={
          pin
            ? "已固定到本项目：换浏览器打开也用它。点一下取消固定。"
            : "把这个模型固定到本项目，跟着项目走；不固定就只影响这台浏览器。"
        }
        className={cn(
          "shrink-0 rounded-token border px-1.5 py-1 text-[9px] transition-colors duration-[var(--dur)] disabled:opacity-40",
          pin
            ? "border-pick/50 text-pick hover:border-pick"
            : "border-line text-muted-2 hover:border-line-2 hover:text-muted",
        )}
      >
        {pin ? "已钉住" : "钉住"}
      </button>
    </span>
  );
}
