"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { HealthPanel } from "@/components/health-panel";
import { Logomark } from "@/components/icons";
import { SharedSkillPicker } from "@/components/shared-skill-picker";
import { SKILLS_FILE_BYTES, parseSkillsFile, skillsFileOf } from "@/lib/skills-file";
import { ShotTemplateSection } from "@/components/shot-template-section";
import { SeriesSection } from "@/components/series-section";
import {
  MODALITIES,
  MODALITY_HINT,
  MODALITY_LABEL,
  type Modality,
  type PublicConfig,
  type PublicStorage,
  type VideoApiName,
} from "@/lib/config-types";
import { fetchModelConfig, invalidateModelConfig } from "@/lib/model-choice";
import { useWorkbench } from "@/lib/workbench-store";
import {
  SKILL_BODY_MAX,
  SKILL_NAME_MAX,
  type ProjectSkill,
  type SkillStage,
} from "@loomina/ir";
import { SKILL_STAGE_CN } from "@loomina/pipeline";
import { DataSection } from "@/components/data-section";
import type { CapabilityResponse, ModelCapabilityView } from "@/lib/capabilities";
import type { ProbeReportView, ProbeTrend } from "@/lib/probes";
import {
  inventoryOf,
  orphanAssets,
  referencedUrisOfProjects,
} from "@/lib/asset-inventory";
import { inlinePayloadsOf } from "@/lib/log-compact";
import { canProxy } from "@/lib/preview-proxy";
import { templateNameOf, templateOf, type ProjectTemplate } from "@/lib/project-template";
import { listTemplates, removeTemplate, saveTemplate } from "@/lib/template-store";
import {
  TEMPLATE_NAME_MAX,
  TEMPLATE_NOTE_MAX,
  findSameProjectTemplate,
  renameProjectTemplate,
  templateNameProblem,
  templateNoteProblem,
  withProjectTemplateNote,
} from "@/lib/template-edit";
import { projectSegments } from "@/lib/spend-report";
import { cn } from "@/lib/utils";

/**
 * 供应商与模型配置页（H22 / ADR-0094）。
 *
 * 密钥只从浏览器往服务端单向传：已保存的密钥只显示「已保存」，
 * 请求返回的配置里连字段都没有。页面切换模型不在这里改，在各自阶段的顶栏。
 */

type ProviderDraft = {
  key: string;
  id: string;
  isNew: boolean;
  name: string;
  baseUrl: string;
  /** 用户新输入的密钥；空表示不改 */
  apiKey: string;
  /** 已保存的密钥来自哪里 */
  keyHint: string;
  hasKey: boolean;
  clearKey: boolean;
  videoApi: "" | VideoApiName;
};

type ModelDraft = {
  key: string;
  /** 已保存的模型 id；新行没有 */
  id?: string;
  providerId: string;
  modality: Modality;
  model: string;
  label: string;
  resolution: string;
  voice: string;
  /** 按用量计价的单价（H4）：文本元 / 百万 token，配音元 / 千字；空表示不知道 */
  unitPrice: string;
  /** 自定义媒体单价（H22）：图像元 / 张、视频元 / 秒；空表示用价目表 */
  mediaPrice: string;
  /** 商用条款 / 能力备注（B12）；空表示未确认 */
  terms: string;
};

type Probe = { ok: boolean; message: string };

const EMPTY_VIDEO_API: "" | VideoApiName = "";

const PRICE_UNIT: Record<
  "per_second" | "per_image" | "per_million_tokens" | "per_thousand_chars",
  string
> = {
  per_second: "秒",
  per_image: "张",
  per_million_tokens: "百万 token",
  per_thousand_chars: "千字",
};

function blankProvider(index: number, used: Set<string>): ProviderDraft {
  let n = index;
  let id = `provider-${n}`;
  while (used.has(id)) id = `provider-${++n}`;
  used.add(id);
  return {
    key: `new-provider-${id}`,
    id,
    isNew: true,
    name: "",
    baseUrl: "",
    apiKey: "",
    keyHint: "",
    hasKey: false,
    clearKey: false,
    videoApi: EMPTY_VIDEO_API,
  };
}

function draftsFrom(config: PublicConfig) {
  const providers: ProviderDraft[] = config.providers.map((provider) => ({
    key: provider.id,
    id: provider.id,
    isNew: false,
    name: provider.name,
    baseUrl: provider.baseUrl,
    apiKey: "",
    keyHint: provider.keyFromEnv ? "来自 secrity.env" : provider.hasKey ? "已保存" : "未设置",
    hasKey: provider.hasKey,
    clearKey: false,
    videoApi: provider.videoApi ?? EMPTY_VIDEO_API,
  }));
  const models: ModelDraft[] = config.models.map((model) => ({
    key: model.id,
    id: model.id,
    providerId: model.providerId,
    modality: model.modality,
    model: model.model,
    label: model.label,
    resolution: model.resolution ?? "",
    voice: model.voice ?? "",
    unitPrice: model.unitPriceCny !== undefined ? String(model.unitPriceCny) : "",
    mediaPrice:
      model.perImageCny !== undefined
        ? String(model.perImageCny)
        : model.perSecondCny !== undefined
          ? String(model.perSecondCny)
          : "",
    terms: model.terms ?? "",
  }));
  const defaults: Partial<Record<Modality, string>> = {};
  for (const modality of MODALITIES) {
    const wanted = config.defaults[modality];
    if (models.some((model) => model.id === wanted)) defaults[modality] = wanted;
  }
  return { providers, models, defaults };
}

function finalIds(models: ModelDraft[], providers: ProviderDraft[]): string[] {
  const used = new Set(models.map((model) => model.id).filter((id): id is string => Boolean(id)));
  return models.map((model) => {
    if (model.id) return model.id;
    const provider = providers.find((item) => item.id === model.providerId);
    const base = `${provider?.id ?? "provider"}:${model.model.trim().replace(/\s+/g, "-") || "model"}`;
    let id = base;
    let n = 2;
    while (used.has(id)) id = `${base}-${n++}`;
    used.add(id);
    return id;
  });
}

function Field({
  label,
  hint,
  children,
  className,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <label className={cn("flex min-w-0 flex-col gap-1", className)}>
      <span className="text-[9px] tracking-[.06em] text-muted-2">{label}</span>
      {children}
      {hint && <span className="text-[9px] leading-4 text-muted-2">{hint}</span>}
    </label>
  );
}

const inputClass =
  "h-7 min-w-0 rounded-token border border-line bg-bg px-2 text-[10.5px] text-text placeholder:text-muted-2 focus:border-line-2 focus:outline-none";

const selectClass = `${inputClass} appearance-none`;

export function SettingsScreen() {
  const reset = useWorkbench((state) => state.reset);
  const hydrate = useWorkbench((state) => state.hydrate);
  const readOnly = useWorkbench((state) => state.readOnly);
  const eventCount = useWorkbench((state) => state.events.length);
  const [providers, setProviders] = useState<ProviderDraft[]>([]);
  const [models, setModels] = useState<ModelDraft[]>([]);
  const [defaults, setDefaults] = useState<Partial<Record<Modality, string>>>({});
  const [path, setPath] = useState("");
  const [saved, setSaved] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [loadError, setLoadError] = useState<string>();
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [probes, setProbes] = useState<Record<string, Probe>>({});
  const [probing, setProbing] = useState<string>();
  const [capability, setCapability] = useState<CapabilityResponse>();
  const [capabilityLoading, setCapabilityLoading] = useState(true);
  const [capabilityError, setCapabilityError] = useState<string>();
  /** 对象存储（H3）：这块单独保存，见 ObjectStorageSection */
  const [storage, setStorage] = useState<PublicStorage>();

  const applyConfig = useCallback((config: PublicConfig) => {
    const next = draftsFrom(config);
    setProviders(next.providers);
    setModels(next.models);
    setDefaults(next.defaults);
    setPath(config.path);
    setSaved(config.saved);
    if (config.storage) setStorage(config.storage);
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(undefined);
    const config = await fetchModelConfig(true);
    if (!config) {
      setLoadError("读不到服务端配置。确认开发服务器在运行，再刷新这一页。");
      setLoading(false);
      return;
    }
    applyConfig(config);
    setLoading(false);
  }, [applyConfig]);

  const loadCapability = useCallback(async () => {
    setCapabilityLoading(true);
    setCapabilityError(undefined);
    try {
      const response = await fetch("/api/capability", { cache: "no-store" });
      const payload = (await response.json()) as CapabilityResponse & { error?: string };
      if (!response.ok) throw new Error(payload.error || `读不到能力矩阵（${response.status}）`);
      setCapability(payload);
    } catch (caught) {
      setCapabilityError(caught instanceof Error ? caught.message : "读不到能力矩阵");
    } finally {
      setCapabilityLoading(false);
    }
  }, []);

  useEffect(() => {
    // 这一页也要读本地项目：重置要覆盖的是真实日志，不是内存里的示例
    void hydrate();
    void load();
    void loadCapability();
  }, [hydrate, load, loadCapability]);

  const providerIds = useMemo(() => new Set(providers.map((item) => item.id)), [providers]);
  const providerName = useCallback(
    (id: string) => providers.find((item) => item.id === id)?.name || id,
    [providers],
  );

  const countOf = useCallback(
    (modality: Modality) => models.filter((model) => model.modality === modality).length,
    [models],
  );

  function updateProvider(key: string, patch: Partial<ProviderDraft>) {
    setProviders((current) =>
      current.map((item) => (item.key === key ? { ...item, ...patch } : item)),
    );
    setNotice(undefined);
  }

  function updateModel(key: string, patch: Partial<ModelDraft>) {
    setModels((current) =>
      current.map((item) => (item.key === key ? { ...item, ...patch } : item)),
    );
    setNotice(undefined);
    setError(undefined);
  }

  function addProvider() {
    const used = new Set(providers.map((item) => item.id));
    setProviders((current) => [...current, blankProvider(current.length + 1, used)]);
    setNotice(undefined);
  }

  function removeProvider(key: string) {
    const provider = providers.find((item) => item.key === key);
    if (!provider) return;
    if (models.some((model) => model.providerId === provider.id)) {
      setError(`供应商「${provider.name || provider.id}」下还有模型，先把模型删掉或换供应商`);
      return;
    }
    setProviders((current) => current.filter((item) => item.key !== key));
    setProbes((current) => {
      const next = { ...current };
      delete next[key];
      return next;
    });
    setNotice(undefined);
  }

  function addModel(modality: Modality) {
    const providerId = providers[0]?.id ?? "";
    const key = `new-model-${modality}-${Date.now()}-${models.length}`;
    const row: ModelDraft = {
      key,
      providerId,
      modality,
      model: "",
      label: "",
      resolution: "",
      voice: "",
      unitPrice: "",
      mediaPrice: "",
      terms: "",
    };
    // 该模态第一个模型自动成为默认，避免保存时还要回头点一次
    if (!models.some((item) => item.modality === modality)) {
      setDefaults((current) => ({ ...current, [modality]: key }));
    }
    setModels((current) => [...current, row]);
    setNotice(undefined);
    setError(undefined);
  }

  function removeModel(key: string) {
    const model = models.find((item) => item.key === key);
    if (!model) return;
    setModels((current) => current.filter((item) => item.key !== key));
    setDefaults((current) => {
      const next = { ...current };
      if (next[model.modality] === key) {
        const fallback = models.find(
          (item) => item.modality === model.modality && item.key !== key,
        );
        if (fallback) next[model.modality] = fallback.key;
        else delete next[model.modality];
      }
      return next;
    });
    setNotice(undefined);
  }

  async function probe(provider: ProviderDraft) {
    setProbes((current) => {
      const next = { ...current };
      delete next[provider.key];
      return next;
    });
    setProbing(provider.key);
    try {
      const response = await fetch("/api/config/probe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ providerId: provider.id }),
      });
      const payload = (await response.json()) as { message?: string; error?: string };
      setProbes((current) => ({
        ...current,
        [provider.key]: {
          ok: response.ok && !payload.error,
          message: response.ok ? (payload.message ?? "连通") : (payload.error ?? "探测失败"),
        },
      }));
    } catch {
      setProbes((current) => ({
        ...current,
        [provider.key]: { ok: false, message: "探测请求发不出去" },
      }));
    } finally {
      setProbing(undefined);
    }
  }

  function validate(): string | undefined {
    if (providers.length === 0) return "至少留一个供应商";
    for (const provider of providers) {
      if (!provider.name.trim()) return "每个供应商都要有名字";
      if (!/^https?:\/\//i.test(provider.baseUrl.trim())) {
        return `供应商「${provider.name}」的 Base URL 要以 http(s):// 开头`;
      }
    }
    const signatures = new Set<string>();
    for (const model of models) {
      if (!modelIdValid(model)) return "每个模型都要选供应商并填写模型名";
      const signature = `${model.providerId}|${model.modality}|${model.model.trim()}`;
      if (signatures.has(signature)) {
        return `模型「${providerName(model.providerId)} / ${model.model.trim()}」重复，删掉其中一条`;
      }
      signatures.add(signature);
    }
    for (const modality of MODALITIES) {
      if (countOf(modality) > 0 && !defaults[modality]) {
        return `${MODALITY_LABEL[modality]}模型要指定一个默认`;
      }
    }
    if (models.length === 0) return "至少配一个模型；图像、视频、配音可以空着，但文本或你实际要用的那个不能空";
    return undefined;
  }

  async function save() {
    const problem = validate();
    if (problem) {
      setError(problem);
      setNotice(undefined);
      return;
    }
    setBusy(true);
    setError(undefined);
    setNotice(undefined);
    const ids = finalIds(models, providers);
    const payload = {
      providers: providers.map((provider) => ({
        id: provider.id,
        name: provider.name.trim(),
        baseUrl: provider.baseUrl.trim().replace(/\/+$/, ""),
        ...(provider.apiKey.trim()
          ? { apiKey: provider.apiKey.trim() }
          : provider.clearKey
            ? { apiKey: "" }
            : {}),
        ...(provider.videoApi ? { videoApi: provider.videoApi } : {}),
      })),
      models: models.map((model, index) => ({
        id: ids[index]!,
        providerId: model.providerId,
        modality: model.modality,
        model: model.model.trim(),
        ...(model.label.trim() ? { label: model.label.trim() } : {}),
        ...(model.modality === "video" && model.resolution.trim()
          ? { resolution: model.resolution.trim() }
          : {}),
        ...(model.modality === "tts" && model.voice.trim() ? { voice: model.voice.trim() } : {}),
        ...((model.modality === "text" || model.modality === "tts") &&
        Number.isFinite(Number(model.unitPrice)) &&
        model.unitPrice.trim() !== ""
          ? { unitPriceCny: Math.max(0, Number(model.unitPrice)) }
          : {}),
        ...((model.modality === "image" || model.modality === "video") &&
        Number.isFinite(Number(model.mediaPrice)) &&
        model.mediaPrice.trim() !== ""
          ? model.modality === "image"
            ? { perImageCny: Math.max(0, Number(model.mediaPrice)) }
            : { perSecondCny: Math.max(0, Number(model.mediaPrice)) }
          : {}),
        ...(model.terms.trim() ? { terms: model.terms.trim() } : {}),
      })),
      defaults: Object.fromEntries(
        MODALITIES.flatMap((modality) => {
          const index = models.findIndex((model) => model.key === defaults[modality]);
          return index >= 0 && models[index]!.modality === modality
            ? [[modality, ids[index]!]]
            : [];
        }),
      ),
    };

    try {
      const response = await fetch("/api/config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const result = (await response.json()) as PublicConfig & { error?: string };
      if (!response.ok) throw new Error(result.error || `保存失败（${response.status}）`);
      applyConfig(result);
      invalidateModelConfig();
      await fetchModelConfig(true);
      void loadCapability();
      setSaved(true);
      setNotice("已保存。各阶段的顶栏下拉会立刻用新配置。");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "保存失败");
    } finally {
      setBusy(false);
    }
  }

  const totalModels = models.length;

  return (
    <div className="min-h-full bg-bg text-text">
      <header className="sticky top-0 z-10 flex h-[46px] items-center gap-4 border-b border-line bg-bg px-4">
        <Logomark className="h-[21px] w-[21px] text-text" />
        <span className="text-[13px] tracking-[.08em]">供应商与模型</span>
        <span className="tnum text-[9px] text-muted-2">H22</span>
        <Link
          href="/"
          className="ml-auto text-[10px] text-muted transition-colors duration-[var(--dur)] hover:text-text"
        >
          ← 返回工作台
        </Link>
      </header>

      <main className="mx-auto w-full max-w-[980px] px-5 pb-24 pt-6">
        <section className="flex flex-wrap items-end justify-between gap-3 border-b border-line pb-4">
          <div className="max-w-[560px]">
            <h1 className="text-[18px] leading-7">模型怎么接、用哪个</h1>
            <p className="mt-1.5 text-[10.5px] leading-[1.7] text-muted">
              可配多个供应商，每种模态可配多个模型并指定默认。密钥只写进本机配置文件，
              不会出现在页面或接口返回里；页面顶栏的选择只影响当前浏览器。
            </p>
          </div>
          <div className="tnum flex items-center gap-3 text-[9px] text-muted-2">
            <span>{providers.length} 个供应商</span>
            <span className="text-line-2">·</span>
            <span>{totalModels} 个模型</span>
          </div>
        </section>

        <div
          className={cn(
            "mt-4 rounded-token border px-3 py-2 text-[10px] leading-5",
            saved ? "border-line text-muted" : "border-line-2 text-muted",
          )}
        >
          {loading ? (
            "正在读配置…"
          ) : loadError ? (
            <span className="text-pick">{loadError}</span>
          ) : (
            <>
              <span className="text-muted-2">配置文件</span>{" "}
              <span className="tnum break-all text-text">{path}</span>
              <span className="ml-2 rounded-token border border-line px-1.5 py-px text-[8.5px] text-muted-2">
                {saved ? "已落盘 · 0600" : "尚未落盘 · 当前由 secrity.env 生成"}
              </span>
              {!saved && (
                <div className="mt-1 text-[9.5px] text-muted-2">
                  第一次保存之前，这一页显示的是环境变量里的配置；保存后会以配置文件为准。
                </div>
              )}
            </>
          )}
        </div>

        {/* 供应商 */}
        <section className="mt-8">
          <div className="flex items-baseline justify-between gap-3">
            <h2 className="text-[12px] tracking-[.04em]">供应商</h2>
            <button
              type="button"
              onClick={addProvider}
              className="rounded-token border border-line px-2.5 py-1 text-[10px] text-muted transition-colors duration-[var(--dur)] hover:border-line-2 hover:text-text"
            >
              + 添加供应商
            </button>
          </div>

          <div className="mt-3 space-y-2">
            {providers.length === 0 && (
              <p className="rounded-token border border-dashed border-line px-3 py-4 text-[10px] text-muted-2">
                还没有供应商。加一个，填 Base URL 和 API Key，再在下面挂模型。
              </p>
            )}
            {providers.map((provider) => {
              const probeResult = probes[provider.key];
              const keyPlaceholder = provider.hasKey
                ? provider.keyHint === "来自 secrity.env"
                  ? "沿用 secrity.env 的密钥，输入可覆盖"
                  : "已保存，留空沿用"
                : "粘贴 API Key";
              return (
                <div key={provider.key} className="rounded-token border border-line bg-surface p-3">
                  <div className="flex flex-wrap items-end gap-2">
                    <Field label="名字" className="w-[140px]">
                      <input
                        value={provider.name}
                        onChange={(event) =>
                          updateProvider(provider.key, { name: event.target.value })
                        }
                        placeholder="例如 Treecloud"
                        className={inputClass}
                      />
                    </Field>
                    <Field label="Base URL" className="min-w-[220px] flex-1" hint="不带 /v1；密钥只走服务端">
                      <input
                        value={provider.baseUrl}
                        onChange={(event) =>
                          updateProvider(provider.key, { baseUrl: event.target.value })
                        }
                        placeholder="https://api.example.com"
                        spellCheck={false}
                        className={`${inputClass} tnum`}
                      />
                    </Field>
                    <Field
                      label={`API Key · ${provider.keyHint}`}
                      className="min-w-[200px] flex-1"
                      hint={
                        provider.clearKey
                          ? "保存后会清空这个供应商的密钥"
                          : "留空 = 不改动已保存的密钥"
                      }
                    >
                      <input
                        value={provider.apiKey}
                        onChange={(event) =>
                          updateProvider(provider.key, {
                            apiKey: event.target.value,
                            clearKey: false,
                          })
                        }
                        placeholder={keyPlaceholder}
                        type="password"
                        autoComplete="off"
                        spellCheck={false}
                        className={inputClass}
                      />
                    </Field>
                  </div>
                  <div className="mt-2 flex flex-wrap items-end gap-2">
                    <Field label="视频接口" className="w-[124px]">
                      <select
                        value={provider.videoApi}
                        onChange={(event) =>
                          updateProvider(provider.key, {
                            videoApi: event.target.value as "" | VideoApiName,
                          })
                        }
                        className={selectClass}
                      >
                        <option value="">跟随环境</option>
                        <option value="treecloud">treecloud</option>
                        <option value="litellm">litellm</option>
                      </select>
                    </Field>
                    <div className="flex items-center gap-2 pb-0.5">
                      <button
                        type="button"
                        onClick={() => void probe(provider)}
                        disabled={provider.isNew || probing === provider.key || loading}
                        title={provider.isNew ? "先保存，再探测" : "只读 GET /v1/models，不花钱"}
                        className="rounded-token border border-line px-2 py-1 text-[10px] text-muted transition-colors duration-[var(--dur)] hover:border-line-2 hover:text-text disabled:opacity-35"
                      >
                        {probing === provider.key ? "探测中…" : "探测"}
                      </button>
                      <button
                        type="button"
                        onClick={() => removeProvider(provider.key)}
                        className="rounded-token border border-line px-2 py-1 text-[10px] text-muted-2 transition-colors duration-[var(--dur)] hover:border-line-2 hover:text-pick"
                      >
                        删除
                      </button>
                    </div>
                  </div>
                  <div className="mt-1.5 flex flex-wrap items-center gap-3 text-[9px] text-muted-2">
                    <span>
                      密钥：
                      {provider.apiKey.trim()
                        ? "本次会写入新值"
                        : provider.clearKey
                          ? "保存后清空"
                          : provider.hasKey
                            ? provider.keyHint
                            : "未设置"}
                    </span>
                    {provider.hasKey && (
                      <button
                        type="button"
                        onClick={() =>
                          updateProvider(provider.key, {
                            clearKey: !provider.clearKey,
                            apiKey: "",
                          })
                        }
                        className="underline decoration-line-2 underline-offset-2 transition-colors duration-[var(--dur)] hover:text-pick"
                      >
                        {provider.clearKey ? "取消清空" : "清空密钥"}
                      </button>
                    )}
                    <span className="tnum">id · {provider.id}</span>
                    {provider.isNew && <span>保存后可以探测</span>}
                    {probeResult && (
                      <span className={probeResult.ok ? "text-muted" : "text-pick"}>
                        {probeResult.message}
                      </span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </section>

        {/* 模型 */}
        <section className="mt-9">
          <div className="flex items-baseline justify-between gap-3 border-b border-line pb-2">
            <h2 className="text-[12px] tracking-[.04em]">模型</h2>
            <span className="text-[9px] text-muted-2">每种模态的第一个会自动成为默认，之后可改</span>
          </div>

          <div className="mt-4 space-y-5">
            {MODALITIES.map((modality) => {
              const rows = models.filter((model) => model.modality === modality);
              const defaultKey = defaults[modality];
              return (
                <div key={modality}>
                  <div className="flex items-baseline gap-2">
                    <h3 className="text-[10.5px] text-text">{MODALITY_LABEL[modality]}</h3>
                    <span className="text-[9px] text-muted-2">{MODALITY_HINT[modality]}</span>
                    <span className="tnum ml-auto text-[9px] text-muted-2">
                      {rows.length} 个
                    </span>
                    <button
                      type="button"
                      onClick={() => addModel(modality)}
                      disabled={providers.length === 0}
                      title={providers.length === 0 ? "先加供应商" : undefined}
                      className="rounded-token border border-line px-2 py-0.5 text-[9.5px] text-muted transition-colors duration-[var(--dur)] hover:border-line-2 hover:text-text disabled:opacity-35"
                    >
                      + 添加
                    </button>
                  </div>

                  {rows.length === 0 ? (
                    <p className="mt-1.5 text-[9.5px] text-muted-2">
                      没配。需要用到时再到这里的加一个。
                    </p>
                  ) : (
                    <div className="mt-1.5 divide-y divide-line rounded-token border border-line">
                      {rows.map((model) => {
                        const isDefault = defaultKey === model.key;
                        return (
                          <div
                            key={model.key}
                            className={cn(
                              "flex flex-wrap items-end gap-2 px-2.5 py-2",
                              isDefault && "bg-surface",
                            )}
                          >
                            <Field label="供应商" className="w-[168px]">
                              <select
                                value={model.providerId}
                                onChange={(event) => {
                                  const providerId = event.target.value;
                                  updateModel(model.key, {
                                    providerId,
                                    label: model.id ? model.label : "",
                                  });
                                }}
                                className={`${selectClass} truncate`}
                              >
                                {providers.map((provider) => (
                                  <option key={provider.id} value={provider.id}>
                                    {provider.name || provider.id}
                                  </option>
                                ))}
                              </select>
                            </Field>
                            <Field label="模型名" className="min-w-[180px] flex-1">
                              <input
                                value={model.model}
                                onChange={(event) =>
                                  updateModel(model.key, { model: event.target.value })
                                }
                                placeholder="例如 deepseek-v4.1-pro"
                                spellCheck={false}
                                className={`${inputClass} tnum`}
                              />
                            </Field>
                            <Field label="显示名" className="min-w-[130px] flex-1">
                              <input
                                value={model.label}
                                onChange={(event) =>
                                  updateModel(model.key, { label: event.target.value })
                                }
                                placeholder="自动"
                                className={`${inputClass} truncate`}
                              />
                            </Field>
                            <Field
                              label="商用条款 / 备注"
                              className="min-w-[160px] flex-1"
                              hint="可选；会显示在能力矩阵里"
                            >
                              <input
                                value={model.terms}
                                onChange={(event) =>
                                  updateModel(model.key, { terms: event.target.value })
                                }
                                placeholder="例如：商用需单独申请"
                                className={`${inputClass} truncate`}
                              />
                            </Field>
                            {modality === "video" && (
                              <Field label="分辨率" className="w-[78px]">
                                <input
                                  value={model.resolution}
                                  onChange={(event) =>
                                    updateModel(model.key, { resolution: event.target.value })
                                  }
                                  placeholder="768p"
                                  className={`${inputClass} tnum`}
                                />
                              </Field>
                            )}
                            {modality === "tts" && (
                              <Field label="音色" className="w-[86px]">
                                <input
                                  value={model.voice}
                                  onChange={(event) =>
                                    updateModel(model.key, { voice: event.target.value })
                                  }
                                  placeholder="默认"
                                  className={inputClass}
                                />
                              </Field>
                            )}
                            {(modality === "text" || modality === "tts") && (
                              <Field
                                label={modality === "text" ? "单价（元/百万 token）" : "单价（元/千字）"}
                                className="w-[132px]"
                                hint="按账单填；不填就只记用量、不算钱"
                              >
                                <input
                                  value={model.unitPrice}
                                  onChange={(event) =>
                                    updateModel(model.key, { unitPrice: event.target.value })
                                  }
                                  inputMode="decimal"
                                  placeholder="未知"
                                  className={`${inputClass} tnum`}
                                />
                              </Field>
                            )}
                            {(modality === "image" || modality === "video") && (
                              <Field
                                label={modality === "image" ? "单价（元/张）" : "单价（元/秒）"}
                                className="w-[132px]"
                                hint="填了盖过价目表；按账单或测绘实测填，不填就报不出价"
                              >
                                <input
                                  value={model.mediaPrice}
                                  onChange={(event) =>
                                    updateModel(model.key, { mediaPrice: event.target.value })
                                  }
                                  inputMode="decimal"
                                  placeholder="用价目表"
                                  className={`${inputClass} tnum`}
                                />
                              </Field>
                            )}
                            <label className="flex h-7 items-center gap-1.5 text-[9.5px] text-muted">
                              <input
                                type="radio"
                                name={`default-${modality}`}
                                checked={isDefault}
                                onChange={() =>
                                  setDefaults((current) => ({ ...current, [modality]: model.key }))
                                }
                                className="accent-[var(--pick)]"
                              />
                              默认
                            </label>
                            <button
                              type="button"
                              onClick={() => removeModel(model.key)}
                              className="h-7 rounded-token border border-line px-2 text-[9.5px] text-muted-2 transition-colors duration-[var(--dur)] hover:border-line-2 hover:text-pick"
                            >
                              删除
                            </button>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </section>

        <section className="mt-9 rounded-token border border-line bg-surface p-3">
          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={() => void save()}
              disabled={busy || loading}
              className="rounded-token border border-text px-3 py-1.5 text-[10.5px] text-text transition-colors duration-[var(--dur)] hover:bg-bg disabled:opacity-40"
            >
              {busy ? "保存中…" : "保存配置"}
            </button>
            <button
              type="button"
              onClick={() => void load()}
              disabled={busy || loading}
              className="rounded-token border border-line px-3 py-1.5 text-[10.5px] text-muted transition-colors duration-[var(--dur)] hover:border-line-2 hover:text-text disabled:opacity-40"
            >
              放弃改动，重新读
            </button>
            <span className="text-[9.5px] text-muted-2">
              保存会校验：Base URL、模型名、每种模态的默认；密钥留空不改。
            </span>
          </div>
          {error && <p className="mt-2 text-[10px] leading-5 text-pick">{error}</p>}
          {notice && <p className="mt-2 text-[10px] leading-5 text-muted">{notice}</p>}
        </section>

        <HealthPanel />

        <section className="mt-9 border-t border-line pt-5">
          <div className="flex flex-wrap items-baseline justify-between gap-3">
            <div className="flex items-baseline gap-2">
              <h2 className="text-[12px] tracking-[.04em]">能力矩阵</h2>
              <span className="tnum text-[9px] text-muted-2">B12 · H16</span>
            </div>
            <button
              type="button"
              onClick={() => void loadCapability()}
              disabled={capabilityLoading}
              className="rounded-token border border-line px-2.5 py-1 text-[10px] text-muted transition-colors duration-[var(--dur)] hover:border-line-2 hover:text-text disabled:opacity-40"
            >
              {capabilityLoading ? "读取中…" : "刷新"}
            </button>
          </div>
          <p className="mt-1 max-w-[640px] text-[9.5px] leading-[1.7] text-muted-2">
            读的是已保存的配置。只列代码实际发送的能力、价目表里查得到的单价和匹配到的 S1 测绘；
            供应商侧没验证过的标「未测」。这张表不参与路由或降级。
          </p>

          {capabilityError && (
            <p className="mt-2 text-[10px] leading-5 text-pick">{capabilityError}</p>
          )}
          {capabilityLoading && !capability && (
            <p className="mt-3 text-[10px] text-muted-2">正在读能力与测绘报告…</p>
          )}

          {capability && (
            <>
              <div className="tnum mt-2 flex flex-wrap items-center gap-2 text-[9px] text-muted-2">
                <span>{capability.modelCount} 个模型</span>
                <span className="text-line-2">·</span>
                <span>{capability.saved ? "已保存配置" : "env 临时视图"}</span>
                {capability.termsUnconfirmed > 0 && (
                  <>
                    <span className="text-line-2">·</span>
                    <span className="text-pick">
                      {capability.termsUnconfirmed} 个商用条款未确认
                    </span>
                  </>
                )}
              </div>

              <div className="mt-4 space-y-5">
                {capability.groups.map((group) => (
                  <div key={group.modality}>
                    <div className="flex items-baseline gap-2 border-b border-line pb-1">
                      <h3 className="text-[10.5px] text-text">{group.label}</h3>
                      <span className="tnum text-[9px] text-muted-2">
                        {group.models.length} 个
                      </span>
                      {group.models.length === 0 && (
                        <span className="text-[9px] text-muted-2">
                          没配；这一模态暂时不可用
                        </span>
                      )}
                    </div>
                    <div className="mt-2 grid gap-2 lg:grid-cols-2">
                      {group.models.map((model) => (
                        <CapabilityCard key={model.id} model={model} />
                      ))}
                    </div>
                  </div>
                ))}
              </div>

              <ProbeReports
                probes={capability.probes}
                trends={capability.trends}
              />
            </>
          )}
        </section>

        <LocalProjectSection
          eventCount={eventCount}
          readOnly={Boolean(readOnly)}
          onReset={reset}
        />

        <TemplateSection readOnly={Boolean(readOnly)} />
        <ShotTemplateSection readOnly={Boolean(readOnly)} />
        <ReuseCacheSection />
        <SeriesSection />
        <SkillsSection readOnly={Boolean(readOnly)} />

        <DataSection
          readOnly={Boolean(readOnly)}
          storageConfigured={Boolean(storage?.configured)}
        />

        <AssetStoreSection
          readOnly={Boolean(readOnly)}
          storageConfigured={Boolean(storage?.configured)}
        />

        <ObjectStorageSection
          readOnly={Boolean(readOnly)}
          storage={storage}
          onSaved={(next) => {
            setStorage(next);
            void loadCapability();
          }}
        />

        <section className="mt-8 border-t border-line pt-4 text-[9.5px] leading-[1.8] text-muted-2">
          <p>
            页面里怎么切换：每个阶段顶栏的下拉只作用于当前浏览器，不选就用该模态的默认。
            例如故事页可选 deepseek-v4.1-pro 或 deepseek-v4.1-flash-1017。
          </p>
          <p className="mt-1">
            密钥安全：返回给浏览器的只有「有没有密钥」，没有密钥内容；配置文件 0600，
            目录 0700。改完配置不用重启服务。
          </p>
          <p className="mt-1 tnum">
            {providers.length > 0 && providerName(providers[0]!.id)
              ? `当前第一个供应商：${providerName(providers[0]!.id)}`
              : "当前没有供应商"}
            {providerIds.size > 0 ? ` · 已用 id 数 ${providerIds.size}` : ""}
          </p>
        </section>
      </main>
    </div>
  );
}

function CapabilityCard({ model }: { model: ModelCapabilityView }) {
  return (
    <div className="rounded-token border border-line bg-surface p-2.5">
      <div className="flex flex-wrap items-baseline gap-2">
        <span className="text-[10.5px] text-text">{model.label}</span>
        {model.label !== `${model.providerName} / ${model.model}` && (
          <>
            <span className="tnum text-[9px] text-muted-2">{model.model}</span>
            <span className="text-[9px] text-muted-2">· {model.providerName}</span>
          </>
        )}
        {model.isDefault && (
          <span className="rounded-token border border-line-2 px-1.5 py-px text-[8px] text-muted">
            默认
          </span>
        )}
      </div>

      <p className="mt-1.5 text-[9.5px] leading-4">
        {model.price.kind === "known" ? (
          <span className="tnum text-muted">
            ¥{model.price.cny.toFixed(2)} / {PRICE_UNIT[model.price.unit]}
            <span className="text-muted-2"> · {model.price.basis}</span>
          </span>
        ) : (
          <span className="text-muted-2">单价未知 · {model.price.reason}</span>
        )}
      </p>

      <ul className="mt-1.5 space-y-0.5">
        {model.facts.map((fact) => (
          <li
            key={fact.key}
            className="grid grid-cols-[64px_1fr] gap-2 text-[9px] leading-4"
          >
            <span className="text-muted-2">{fact.label}</span>
            <span
              className={cn(
                "min-w-0 break-words",
                fact.source === "unknown" ? "text-muted-2" : "text-muted",
              )}
            >
              {fact.value}
            </span>
          </li>
        ))}
      </ul>

      <p className="mt-1.5 text-[9px] leading-4">
        <span className="text-muted-2">商用条款</span>{" "}
        {model.terms ? (
          <span className="text-muted">{model.terms}</span>
        ) : (
          <span className="text-muted-2">未确认 · 需人工核对供应商条款</span>
        )}
      </p>

      {model.probe ? (
        <p className="tnum mt-1 text-[9px] leading-4 text-muted-2">
          S1 · {probeTime(model.probe.report.startedAt)} · {model.probe.report.attempts} 次 ·
          通过 {model.probe.report.passed} · ¥{model.probe.report.totalCny.toFixed(2)} ·{" "}
          {probeOutcome(model.probe.report)}
          {!model.probe.exact && (
            <span className="text-pick"> · {model.probe.note}</span>
          )}
        </p>
      ) : (
        <p className="mt-1 text-[9px] text-muted-2">S1 · 还没有这个模型的测绘报告</p>
      )}
    </div>
  );
}

function ProbeReports({
  probes,
  trends,
}: {
  probes: ProbeReportView[];
  trends: ProbeTrend[];
}) {
  return (
    <div className="mt-6">
      <div className="flex items-baseline justify-between gap-2 border-b border-line pb-1">
        <h3 className="text-[10.5px] text-text">S1 测绘报告</h3>
        <span className="tnum text-[9px] text-muted-2">最近 {probes.length} 次</span>
      </div>
      {trends.length > 0 && (
        <ul className="mt-2 grid gap-1.5 sm:grid-cols-2">
          {trends.map((trend) => (
            <li
              key={trend.model}
              className="rounded-token border border-line bg-surface p-2"
            >
              <div className="flex items-baseline justify-between gap-2">
                <span
                  className="min-w-0 truncate text-[9.5px] text-text"
                  title={trend.model}
                >
                  {trend.model}
                </span>
                <span className="tnum shrink-0 text-[9px] text-muted-2">
                  {trend.passRates.length} 次测绘
                </span>
              </div>
              <div className="mt-1.5 flex items-end gap-1.5">
                <ProbeSparkline rates={trend.passRates} />
                <span
                  className={cn(
                    "tnum shrink-0 text-[10px]",
                    trend.direction === "up"
                      ? "text-pick"
                      : trend.direction === "down"
                        ? "text-reject"
                        : "text-muted-2",
                  )}
                  title={`最近一次通过率 ${Math.round((trend.passRates.at(-1) ?? 0) * 100)}%`}
                >
                  {trend.direction === "up"
                    ? "↑"
                    : trend.direction === "down"
                      ? "↓"
                      : "→"}{" "}
                  {Math.round((trend.passRates.at(-1) ?? 0) * 100)}%
                </span>
              </div>
              <p className="tnum mt-1 text-[9px] text-muted-2">
                {trend.cnyPerShot === undefined
                  ? "镜单价：还没真花过钱"
                  : `实测 ¥${trend.cnyPerShot.toFixed(2)}/镜（最近一次花钱的测绘）`}
              </p>
            </li>
          ))}
        </ul>
      )}
      {probes.length === 0 ? (
        <p className="mt-1.5 text-[9.5px] leading-[1.7] text-muted-2">
          还没有测绘报告。运行 <span className="tnum">pnpm probe:s1</span>，成功后刷新这一块。
        </p>
      ) : (
        <ul className="divide-y divide-line">
          {probes.map((report) => (
            <li
              key={report.file}
              className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 py-1.5 text-[9px]"
            >
              <span className="tnum shrink-0 text-muted-2">
                {probeTime(report.startedAt)}
              </span>
              <span
                className="min-w-[180px] flex-1 truncate text-muted"
                title={report.file}
              >
                {report.videoModel ?? "?"}
                {report.resolution ? ` @ ${report.resolution}` : ""}{" "}
                <span className="text-muted-2">+ {report.imageModel ?? "?"}</span>
              </span>
              <span className="tnum shrink-0 text-muted-2">
                通过 {report.passed}/{report.attempts} · ¥{report.totalCny.toFixed(2)} ·{" "}
                {probeOutcome(report)}
              </span>
            </li>
          ))}
        </ul>
      )}
      <p className="mt-1.5 text-[9px] leading-[1.7] text-muted-2">
        只读本地 artifacts/s1 的汇总字段：不读密钥、不读 Base URL、不展示逐镜报错。
        失败码是供应商返回的分类，不是质量评分。走势只看同一模型前后两次通过率，
        实测单价取最近一次真花过钱的测绘，不回写配置。
      </p>
    </div>
  );
}

function ProbeSparkline({ rates }: { rates: number[] }) {
  const shown = rates.slice(-12);
  return (
    <span
      className="flex h-[18px] min-w-0 flex-1 items-end gap-[2px]"
      aria-label={`通过率走势：${shown.map((rate) => `${Math.round(rate * 100)}%`).join(" → ")}`}
    >
      {shown.map((rate, index) => (
        <span
          key={index}
          className={cn(
            "w-1 rounded-[1px]",
            index === shown.length - 1 ? "bg-pick" : "bg-pick/40",
          )}
          style={{ height: `${Math.max(2, Math.round(rate * 18))}px` }}
          title={`${Math.round(rate * 100)}%`}
        />
      ))}
    </span>
  );
}

function probeTime(value: string): string {
  return value.length >= 16
    ? `${value.slice(0, 10)} ${value.slice(11, 16)}`
    : value;
}

function probeOutcome(report: ProbeReportView): string {
  if (report.attempts === 0) return "没有有效尝试";
  const entries = Object.entries(report.failureCodes);
  if (entries.length === 0) return "全过";
  return `失败 ${entries.map(([code, n]) => `${code}×${n}`).join(" / ")}`;
}

/** 字节数说成人话：素材常是几 MB，也常有几十 KB */
function fmtBytes(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${bytes} B`;
}

function modelIdValid(model: ModelDraft): boolean {
  return Boolean(model.providerId && model.model.trim());
}

/**
 * 结果缓存（H14 / ADR-0208）。
 *
 * 同一套输入（模型 + 最终提示词 + 参考图内容）已经出过的图，默认直接复用，
 * 不再花钱。关掉之后每次都真去生成——换一张、抽卡时要关。
 */
function ReuseCacheSection() {
  const reuseCache = useWorkbench((state) => state.reuseCache);
  const setReuseCache = useWorkbench((state) => state.setReuseCache);
  return (
    <section className="mt-9 border-t border-line pt-5" aria-label="结果缓存">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <div className="flex items-baseline gap-2">
          <h2 className="text-[12px] tracking-[.04em]">结果缓存</h2>
          <span className="tnum text-[9px] text-muted-2">H14</span>
        </div>
        <button
          type="button"
          onClick={() => setReuseCache(!reuseCache)}
          className={cn(
            "rounded-token border px-2 py-0.5 text-[9.5px] transition-colors duration-[var(--dur)]",
            reuseCache
              ? "border-pick/60 text-pick"
              : "border-line text-muted-2 hover:border-line-2 hover:text-text",
          )}
        >
          {reuseCache ? "开着：输入没变就复用" : "关着：每次都真去生成"}
        </button>
      </div>
      <p className="mt-1 max-w-[640px] text-[9.5px] leading-[1.7] text-muted-2">
        同一套输入（模型 + 最终提示词 + 参考图内容）已经出过的图，生成时直接用那一张：
        不重新生成、不花钱，资产记「素材库」来源并保留当初的溯源。
        想换一张、抽卡，或改了参考图但提示词没变时，把它关掉再生成。
        这个开关只存在这台浏览器，不进项目日志。
      </p>
    </section>
  );
}

/**
 * 技能（C.5 / ADR-0191）。
 *
 * 技能是作者写好的、可复用的提示词要求：按阶段拼进出图提示词，
 * 排在风格那句之前。写进项目日志，回放、换设备都在；关掉只是不加，不删记录。
 */
function SkillsSection({ readOnly }: { readOnly: boolean }) {
  const skills = useWorkbench((state) => state.project.skills);
  const addSkill = useWorkbench((state) => state.addSkill);
  const updateSkill = useWorkbench((state) => state.updateSkill);
  const removeSkill = useWorkbench((state) => state.removeSkill);
  const importSkillsToProject = useWorkbench((state) => state.importSkills);
  const [open, setOpen] = useState(false);
  const [editingId, setEditingId] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [body, setBody] = useState("");
  const [stage, setStage] = useState<SkillStage>("all");
  const [error, setError] = useState<string>();

  const close = () => {
    setOpen(false);
    setEditingId(undefined);
    setName("");
    setDescription("");
    setBody("");
    setStage("all");
    setError(undefined);
  };

  /** 点「改」：把这条技能填回表单，存的时候走同一个 updateSkill（只写改过的字段） */
  const startEdit = (skill: ProjectSkill) => {
    setEditingId(skill.id);
    setName(skill.name);
    setDescription(skill.description);
    setBody(skill.body);
    setStage(skill.stage);
    setError(undefined);
    setOpen(true);
  };

  const submit = () => {
    if (editingId) {
      updateSkill(editingId, { name, description, stage, body });
      close();
      return;
    }
    const id = addSkill({ name, description, stage, body });
    if (!id) {
      setError(useWorkbench.getState().castError ?? "这条技能加不上。");
      return;
    }
    close();
  };

  /** 导出：一份 JSON 文件（C18 / ADR-0210） */
  const exportSkills = () => {
    const file = skillsFileOf(skills, new Date().toISOString());
    const blob = new Blob([JSON.stringify(file, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `loomina-skills-${new Date().toISOString().slice(0, 10)}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
    setError(undefined);
    setNotice(`导出了 ${skills.length} 条技能。`);
  };

  /** 导入：读文件 → 逐条校验 → 一次写一批 */
  const importSkills = async (file: File) => {
    setError(undefined);
    setNotice(undefined);
    if (file.size > SKILLS_FILE_BYTES) {
      setError("文件超过 200 KB：技能是短文本，先看看是不是选错了文件。");
      return;
    }
    try {
      const raw = JSON.parse(await file.text()) as unknown;
      const parsed = parseSkillsFile(raw, {
        existing: skills,
        at: new Date().toISOString(),
        tag: Date.now().toString(36),
      });
      if (parsed.skills.length === 0) {
        setError(
          parsed.invalid > 0
            ? `这个包里没有能用的技能：${parsed.invalid} 条格式不对。`
            : parsed.duplicates > 0
              ? `这些技能都已经在用了（${parsed.duplicates} 条）。`
              : "这个文件不是技能包。",
        );
        return;
      }
      if (importSkillsToProject(parsed.skills)) {
        setNotice(
          `导入了 ${parsed.skills.length} 条技能` +
            (parsed.duplicates > 0 ? `，跳过 ${parsed.duplicates} 条已经在用的` : "") +
            (parsed.invalid > 0 ? `，${parsed.invalid} 条格式不对没导入` : "") +
            "。",
        );
      } else {
        setError(useWorkbench.getState().castError ?? "技能没导入。");
      }
    } catch (cause) {
      setError(cause instanceof Error ? `读不了这个文件：${cause.message}` : "读不了这个文件。");
    }
  };

  return (
    <section className="mt-9 border-t border-line pt-5">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <div className="flex items-baseline gap-2">
          <h2 className="text-[12px] tracking-[.04em]">技能</h2>
          <span className="tnum text-[9px] text-muted-2">C.5</span>
        </div>
        <span className="flex flex-wrap items-center gap-2">
          <SharedSkillPicker />
          <button
            type="button"
            onClick={exportSkills}
            disabled={skills.length === 0}
            title="导出一个 JSON 文件：只带名字 / 说明 / 阶段 / 内容 / 启用状态，换机器可导入"
            className="rounded-token border border-line px-2 py-0.5 text-[9px] text-muted-2 transition-colors duration-[var(--dur)] enabled:hover:border-line-2 enabled:hover:text-text disabled:opacity-40"
          >
            导出技能
          </button>
          <label
            className={cn(
              "cursor-pointer rounded-token border border-line px-2 py-0.5 text-[9px] text-muted-2 transition-colors duration-[var(--dur)] hover:border-line-2 hover:text-text",
              readOnly && "pointer-events-none opacity-40",
            )}
            title="导入一个技能包：逐条校验、重编 id，同名同内容跳过"
          >
            导入技能
            <input
              type="file"
              accept="application/json,.json"
              className="hidden"
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = "";
                if (file) void importSkills(file);
              }}
            />
          </label>
          <span className="tnum text-[9.5px] text-muted-2">
            {skills.filter((skill) => skill.enabled).length} / {skills.length} 条生效
          </span>
        </span>
      </div>
      <p className="mt-1 max-w-[640px] text-[9.5px] leading-[1.7] text-muted-2">
        技能是一段可复用的提示词要求，按阶段拼进对应的提示词：故事、剧本（医生）、
        分镜（一句话指令）、定妆 / 场景主镜 / 道具 / 关键帧（出图）、视频、配音。
        出图类的技能排在风格那句之前；「全部阶段」对每个入口都生效。
        配乐生成还没做（C4），配乐阶段暂不开放，等 C4 落地再放出来。
        写进项目日志：刷新、换设备、回放都在。关掉只是不加进提示词，不删记录；
        已经生成的内容不会自动重做。
      </p>

      <div className="mt-3 space-y-1.5">
        {skills.map((skill) => (
          <div
            key={skill.id}
            className="flex flex-wrap items-start gap-2 border border-line px-2.5 py-2"
          >
            <button
              type="button"
              disabled={readOnly}
              onClick={() => updateSkill(skill.id, { enabled: !skill.enabled })}
              title={skill.enabled ? "关掉：不加进下一次提示词" : "打开：下一次提示词带上它"}
              className={cn(
                "shrink-0 rounded-[1px] border px-1.5 py-0.5 text-[9px] transition-colors duration-[var(--dur)] disabled:opacity-40",
                skill.enabled
                  ? "border-pick/60 text-pick"
                  : "border-line text-muted-2 hover:border-line-2 hover:text-text",
              )}
            >
              {skill.enabled ? "生效中" : "已关"}
            </button>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-baseline gap-x-2">
                <span className="text-[10.5px] text-text">{skill.name}</span>
                <span className="tnum text-[8.5px] text-muted-2">
                  {SKILL_STAGE_CN[skill.stage]}
                </span>
              </div>
              {skill.description && (
                <p className="mt-0.5 text-[9px] text-muted-2">{skill.description}</p>
              )}
              <p className="mt-1 whitespace-pre-wrap break-words text-[9.5px] leading-[1.7] text-muted">
                {skill.body}
              </p>
            </div>
            <span className="flex shrink-0 items-center gap-2">
              <button
                type="button"
                disabled={readOnly}
                onClick={() => startEdit(skill)}
                title="改名字 / 阶段 / 内容：存的时候写一条技能更新"
                className="text-[9px] text-muted-2 transition-colors duration-[var(--dur)] hover:text-text disabled:opacity-40"
              >
                改
              </button>
              <button
                type="button"
                disabled={readOnly}
                onClick={() => removeSkill(skill.id)}
                title="删掉这条技能：事件日志里仍留着记录"
                className="text-[9px] text-muted-2 transition-colors duration-[var(--dur)] hover:text-pick disabled:opacity-40"
              >
                删
              </button>
            </span>
          </div>
        ))}
        {skills.length === 0 && (
          <p className="text-[9.5px] text-muted-2">
            还没有技能。比如「所有提示词都不要出现现代物品」。
          </p>
        )}
      </div>

      {open ? (
        <div className="mt-3 space-y-2 border border-dashed border-line-2 px-3 py-2.5">
          <div className="flex flex-wrap items-center gap-1.5">
            <input
              value={name}
              maxLength={SKILL_NAME_MAX}
              aria-label="技能名字"
              placeholder="技能名字：禁止现代物品"
              onChange={(event) => setName(event.target.value)}
              className="min-w-[200px] flex-1 rounded-token border border-line-2 bg-surface px-2 py-1 text-[10.5px] text-text placeholder:text-muted-2 focus:border-pick focus:outline-none"
            />
            <select
              value={stage}
              aria-label="技能用在哪个阶段"
              onChange={(event) => setStage(event.target.value as SkillStage)}
              className="rounded-token border border-line-2 bg-surface px-1.5 py-1 text-[10px] text-text focus:border-pick focus:outline-none"
            >
              {/* 配乐生成（C4）还没做：阶段枚举保留，界面先不开放 */}
              {Object.entries(SKILL_STAGE_CN)
                .filter(([value]) => value !== "music")
                .map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
            </select>
          </div>
          <input
            value={description}
            maxLength={200}
            aria-label="技能说明"
            placeholder="给自己看的说明（不进提示词）"
            onChange={(event) => setDescription(event.target.value)}
            className="w-full rounded-token border border-line-2 bg-surface px-2 py-1 text-[10px] text-text placeholder:text-muted-2 focus:border-pick focus:outline-none"
          />
          <textarea
            value={body}
            maxLength={SKILL_BODY_MAX}
            rows={3}
            aria-label="技能内容"
            placeholder="真正拼进提示词的那一段：场景里不要出现现代物品，灯具一律是老式钨丝灯。"
            onChange={(event) => setBody(event.target.value)}
            className="w-full resize-y rounded-token border border-line-2 bg-surface px-2 py-1.5 text-[10.5px] leading-[1.7] text-text placeholder:text-muted-2 focus:border-pick focus:outline-none"
          />
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={submit}
              disabled={readOnly || !name.trim() || !body.trim()}
              className="rounded-token border border-line-2 px-2.5 py-1 text-[10.5px] text-text transition-colors duration-[var(--dur)] hover:border-pick hover:text-pick disabled:opacity-40"
            >
              {editingId ? "存下改动" : "存下这条"}
            </button>
            <button
              type="button"
              onClick={close}
              className="rounded-token border border-line px-2.5 py-1 text-[10.5px] text-muted transition-colors duration-[var(--dur)] hover:border-line-2 hover:text-text"
            >
              取消
            </button>
            <span className="tnum text-[8.5px] text-muted-2">
              {body.length} / {SKILL_BODY_MAX}
            </span>
          </div>
          {error && <p className="text-[9.5px] text-pick">{error}</p>}
        </div>
      ) : (
        !readOnly && (
          <button
            type="button"
            onClick={() => setOpen(true)}
            className="mt-3 rounded-token border border-line px-2.5 py-1 text-[10.5px] text-muted transition-colors duration-[var(--dur)] hover:border-line-2 hover:text-text"
          >
            加一条技能
          </button>
        )
      )}

      {notice && <p className="mt-2 text-[9.5px] leading-[1.7] text-muted">{notice}</p>}
      {!open && error && <p className="mt-2 text-[9.5px] leading-[1.7] text-pick">{error}</p>}
    </section>
  );
}

/**
 * 本地项目（H18）：说清这份项目存在哪、怎么重来。
 *
 * 重置走 store 的 `reset`：内存回到示例项目，订阅器把整份日志覆盖写回 IndexedDB。
 * 两步确认——这一步删的是作者的全部编辑，不该一点就中。
 */
function LocalProjectSection({
  eventCount,
  readOnly,
  onReset,
}: {
  eventCount: number;
  readOnly: boolean;
  onReset: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const [done, setDone] = useState(false);

  return (
    <section className="mt-9 border-t border-line pt-5">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <div className="flex items-baseline gap-2">
          <h2 className="text-[12px] tracking-[.04em]">本地项目</h2>
          <span className="tnum text-[9px] text-muted-2">H18</span>
        </div>
        <span className="tnum text-[9.5px] text-muted-2">{eventCount} 条事件</span>
      </div>
      <p className="mt-1 max-w-[640px] text-[9.5px] leading-[1.7] text-muted-2">
        项目就是这条事件日志，存在这个浏览器的 IndexedDB 里。清浏览器数据、换浏览器或换设备都会看不到它；
        项目本身没有云同步（F4 未做）；素材可以进对象存储，但那只是素材，不是项目。
      </p>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        {done ? (
          <span className="text-[10px] text-muted">
            已重置：回到示例项目「夜班」。刚才的项目已经从本地库里整份换掉，撤销也找不回来。
          </span>
        ) : confirming ? (
          <>
            <span className="text-[10px] leading-[1.6] text-pick">
              重置会把整条日志整份换成示例项目，{eventCount} 条事件一起消失，撤销也找不回来。确定？
            </span>
            <button
              type="button"
              onClick={() => {
                onReset();
                setConfirming(false);
                setDone(true);
              }}
              className="rounded-token border border-pick px-2.5 py-1 text-[10px] text-pick transition-colors duration-[var(--dur)] hover:bg-pick/10"
            >
              确认重置
            </button>
            <button
              type="button"
              onClick={() => setConfirming(false)}
              className="rounded-token border border-line px-2.5 py-1 text-[10px] text-muted transition-colors duration-[var(--dur)] hover:border-line-2 hover:text-text"
            >
              算了
            </button>
          </>
        ) : (
          <button
            type="button"
            onClick={() => setConfirming(true)}
            disabled={readOnly}
            title={readOnly ? "另一个标签页在编辑：这一页只读" : "回到示例项目"}
            className="rounded-token border border-line px-2.5 py-1 text-[10px] text-muted transition-colors duration-[var(--dur)] hover:border-line-2 hover:text-text disabled:opacity-40"
          >
            重置为示例项目
          </button>
        )}
      </div>
    </section>
  );
}

/**
 * 班底模板（F3 / ADR-0180）。
 *
 * 模板存的是「可以跨集复用的那一份」：人物、地点、道具与它们的定妆图 / 参考图地址，
 * 加画面风格、调色、画幅与品牌包。**不含**故事、场景、镜头、台词——那些是这一集自己的。
 * 存在这台浏览器的 `templates` 仓里，不进事件日志；只存地址，不复制素材。
 */
function TemplateSection({ readOnly }: { readOnly: boolean }) {
  const project = useWorkbench((state) => state.project);
  const startProjectFromTemplate = useWorkbench((state) => state.startProjectFromTemplate);
  const router = useRouter();
  const [templates, setTemplates] = useState<ProjectTemplate[]>();
  const [name, setName] = useState<string>();
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string>();
  const [error, setError] = useState<string>();
  /** 正在编辑的模板（改名 + 说明）：id → 草稿 */
  const [editing, setEditing] = useState<{ id: string; name: string; note: string }>();

  const suggested = templateNameOf(project.title, new Date().toISOString().slice(0, 10));

  const load = useCallback(async () => {
    try {
      setTemplates(await listTemplates());
    } catch {
      setTemplates([]);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const save = async () => {
    if (busy) return;
    setBusy(true);
    setError(undefined);
    setNotice(undefined);
    try {
      const at = new Date().toISOString();
      const template = templateOf(project, {
        id: `tpl-${Date.now().toString(36)}`,
        name: (name ?? suggested).trim() || suggested,
        at,
      });
      // 同一套参数已经存过就不重复存（F3 第二档）：重复的模板只会让列表变长
      const same = findSameProjectTemplate(templates ?? [], template);
      if (same) {
        setNotice(`这套班底已经存过了：「${same.name}」。改名字或删掉旧的那份都行。`);
        return;
      }
      await saveTemplate(template);
      setName(undefined);
      setNotice(
        `存下了「${template.name}」：${template.cast.length} 人 / ${template.locations.length} 地点 / ${template.props.length} 道具。模板只存地址，不复制素材。`,
      );
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "存不下这个模板");
    } finally {
      setBusy(false);
    }
  };

  const open = (template: ProjectTemplate) => {
    setError(undefined);
    setNotice(undefined);
    const nextTitle = title.trim() || template.name;
    if (!startProjectFromTemplate(template, nextTitle)) {
      setError(useWorkbench.getState().castError ?? "模板没能开工");
      return;
    }
    router.push("/cast");
  };

  const drop = async (template: ProjectTemplate) => {
    setError(undefined);
    try {
      await removeTemplate(template.id);
      setNotice(`删掉了模板「${template.name}」。正在用的项目不受影响。`);
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "删不掉这个模板");
    }
  };

  /** 存回改名 / 说明：只动这两个字段，createdAt 与 from 保留 */
  const commitEdit = async (template: ProjectTemplate) => {
    if (!editing || editing.id !== template.id) return;
    const problem = templateNameProblem(editing.name) ?? templateNoteProblem(editing.note);
    if (problem) {
      setError(problem);
      return;
    }
    setError(undefined);
    try {
      const renamed = withProjectTemplateNote(
        renameProjectTemplate(template, editing.name),
        editing.note,
      );
      await saveTemplate(renamed);
      setEditing(undefined);
      setNotice(`改好了：「${renamed.name}」。`);
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "改不了这个模板");
    }
  };

  return (
    <section className="mt-9 border-t border-line pt-5">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <div className="flex items-baseline gap-2">
          <h2 className="text-[12px] tracking-[.04em]">班底模板</h2>
          <span className="tnum text-[9px] text-muted-2">F3</span>
        </div>
        <span className="tnum text-[9.5px] text-muted-2">
          {project.characters.length} 人 / {project.locations.length} 地点 / {project.props.length} 道具
        </span>
      </div>
      <p className="mt-1 max-w-[640px] text-[9.5px] leading-[1.7] text-muted-2">
        模板带走的是可以跨集复用的那一份：人物、地点、道具与它们的定妆图 / 参考图地址，
        加画面风格、画幅与品牌包。故事、场景、镜头、台词不带——新的一集从零开始写。
        模板存这台浏览器，不进事件日志；只存地址，不复制素材。
      </p>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <input
          value={name ?? suggested}
          disabled={readOnly || busy}
          onChange={(event) => setName(event.target.value)}
          aria-label="模板名字"
          className="w-[220px] rounded-token border border-line bg-transparent px-2 py-1 text-[10px] text-text focus:border-line-2 focus:outline-none disabled:opacity-40"
        />
        <button
          type="button"
          onClick={() => void save()}
          disabled={readOnly || busy}
          title={
            readOnly
              ? "另一个标签页在编辑：这一页只读"
              : "把现在这套人、地点、道具与风格存成模板"
          }
          className="rounded-token border border-line px-2.5 py-1 text-[10px] text-muted transition-colors duration-[var(--dur)] hover:border-line-2 hover:text-text disabled:opacity-40"
        >
          {busy ? "正在存…" : "把现在的班底存成模板"}
        </button>
      </div>

      <div className="mt-3 rounded-token border border-line px-3 py-2">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h3 className="text-[10px] text-text">存下的模板</h3>
          <span className="tnum text-[9px] text-muted-2">
            {templates ? `${templates.length} 份` : "读不到模板仓"}
          </span>
        </div>
        <div className="mt-1.5 flex flex-wrap items-center gap-2">
          <input
            value={title}
            disabled={readOnly}
            onChange={(event) => setTitle(event.target.value)}
            placeholder="新片名（不填就用模板名）"
            aria-label="新片名"
            className="w-[200px] rounded-token border border-line bg-transparent px-2 py-1 text-[10px] text-text placeholder:text-muted-2/70 focus:border-line-2 focus:outline-none disabled:opacity-40"
          />
          <span className="text-[9px] text-muted-2">
            开工会在日志末尾写一条新的 project.created，旧项目仍在本地
          </span>
        </div>
        {templates && templates.length === 0 && (
          <p className="mt-1.5 text-[9px] text-muted-2">
            还没有模板：先把一集的班底摆好，再回来存一份。
          </p>
        )}
        <ul className="mt-1.5 space-y-1">
          {(templates ?? []).map((template) => (
            <li
              key={template.id}
              className="flex flex-wrap items-baseline justify-between gap-2 border-t border-line/60 pt-1.5 first:border-t-0 first:pt-0"
            >
              {editing?.id === template.id ? (
                <span className="min-w-0 flex-1">
                  <span className="flex flex-wrap items-center gap-1.5">
                    <input
                      value={editing.name}
                      maxLength={TEMPLATE_NAME_MAX}
                      aria-label="模板名字"
                      onChange={(event) => {
                        const value = event.target.value;
                        setEditing((prev) => (prev ? { ...prev, name: value } : prev));
                      }}
                      className="w-[160px] rounded-token border border-line-2 bg-surface px-1.5 py-0.5 text-[10px] text-text focus:border-pick focus:outline-none"
                    />
                    <input
                      value={editing.note}
                      maxLength={TEMPLATE_NOTE_MAX}
                      aria-label="模板说明"
                      placeholder="说明（可选）"
                      onChange={(event) => {
                        const value = event.target.value;
                        setEditing((prev) => (prev ? { ...prev, note: value } : prev));
                      }}
                      className="min-w-0 flex-1 rounded-token border border-line bg-surface px-1.5 py-0.5 text-[9.5px] text-text placeholder:text-muted-2 focus:border-pick focus:outline-none"
                    />
                  </span>
                </span>
              ) : (
                <span className="min-w-0">
                  <span className="text-[10px] text-text">{template.name}</span>
                  <span className="tnum ml-2 text-[9px] text-muted-2">
                    {template.cast.length} 人 / {template.locations.length} 地点 /{" "}
                    {template.props.length} 道具 · 从「{template.from.title}」·{" "}
                    {template.createdAt.slice(0, 10)}
                  </span>
                  {template.note && (
                    <span className="mt-0.5 block text-[9px] text-muted-2">{template.note}</span>
                  )}
                </span>
              )}
              <span className="flex items-center gap-2">
                {editing?.id === template.id ? (
                  <>
                    <button
                      type="button"
                      onClick={() => void commitEdit(template)}
                      disabled={readOnly}
                      className="rounded-token border border-line-2 px-2 py-0.5 text-[9.5px] text-text transition-colors duration-[var(--dur)] hover:bg-text/10 disabled:opacity-40"
                    >
                      存
                    </button>
                    <button
                      type="button"
                      onClick={() => setEditing(undefined)}
                      className="text-[9px] text-muted-2 hover:text-text"
                    >
                      算了
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    onClick={() =>
                      setEditing({ id: template.id, name: template.name, note: template.note ?? "" })
                    }
                    disabled={readOnly}
                    title="改名字或加说明：不会重置保存时间与来历"
                    className="text-[9px] text-muted-2 transition-colors duration-[var(--dur)] hover:text-text disabled:opacity-40"
                  >
                    改
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => open(template)}
                  disabled={readOnly}
                  title="班底照搬，故事与分镜从零开始"
                  className="rounded-token border border-line px-2 py-0.5 text-[9.5px] text-muted transition-colors duration-[var(--dur)] hover:border-line-2 hover:text-text disabled:opacity-40"
                >
                  用这个开工
                </button>
                <button
                  type="button"
                  onClick={() => void drop(template)}
                  disabled={readOnly}
                  title="只删模板，正在用的项目不受影响"
                  className="rounded-token border border-line px-2 py-0.5 text-[9.5px] text-muted-2 transition-colors duration-[var(--dur)] hover:border-pick/60 hover:text-pick disabled:opacity-40"
                >
                  删
                </button>
              </span>
            </li>
          ))}
        </ul>
      </div>

      {notice && <p className="mt-2 text-[9.5px] leading-[1.7] text-muted">{notice}</p>}
      {error && <p className="mt-2 text-[9.5px] leading-[1.7] text-pick">{error}</p>}
    </section>
  );
}

/**
 * 本机资产库（H3 / ADR-0128）。
 *
 * 说清三件事：素材现在存在哪、还能不能搬、谁没人引用。
 * 迁移与清理都是显式动作：几十兆的读写、删掉花钱生成的东西，都不该自动发生。
 */
function AssetStoreSection({ readOnly, storageConfigured }: { readOnly: boolean; storageConfigured: boolean }) {
  const project = useWorkbench((state) => state.project);
  const events = useWorkbench((state) => state.events);
  const migrateAssets = useWorkbench((state) => state.migrateAssets);
  const compactLog = useWorkbench((state) => state.compactLog);
  const inventory = useMemo(() => inventoryOf(project), [project]);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string>();
  const [error, setError] = useState<string>();
  const [cleaning, setCleaning] = useState(false);
  const [wouldRemove, setWouldRemove] = useState<{ count: number; bytes: number }>();
  const [storeCount, setStoreCount] = useState<number>();
  const [files, setFiles] = useState<{ uri: string; bytes: number }[]>();
  // 桶里的孤儿（H3 / ADR-0158 的远端那一半）：只有配了对象存储才有
  const [remoteFiles, setRemoteFiles] = useState<{ uri: string; bytes: number }[]>();
  const [remoteError, setRemoteError] = useState<string>();
  const [remoteCleaning, setRemoteCleaning] = useState(false);
  const [remoteWouldRemove, setRemoteWouldRemove] = useState<{ count: number; bytes: number }>();
  const [remoteNotice, setRemoteNotice] = useState<string>();
  // 日志瘦身（H3 / ADR-0177）：日志里还被 base64 占着的地方
  const [compactNotice, setCompactNotice] = useState<string>();
  const inlineLog = useMemo(() => inlinePayloadsOf(events), [events]);
  // 预演代理缓存（E7 / ADR-0178）：可删的派生物，超上限自动按最久没用先删
  const [proxyCache, setProxyCache] = useState<{ count: number; bytes: number; cap: number }>();
  const [clearingProxies, setClearingProxies] = useState(false);
  const [proxyNotice, setProxyNotice] = useState<string>();
  const [pregenBusy, setPregenBusy] = useState(false);
  const [pregenNotice, setPregenNotice] = useState<string>();
  /** 这条片子里用到的、在资产库里的素材：预生成代理时按地址去重送上去 */
  const proxyAssets = useMemo(() => {
    const byId = new Map(project.assets.map((asset) => [asset.id, asset]));
    const uris = new Set<string>();
    for (const take of project.takes) {
      const uri = byId.get(take.assetId)?.uri;
      if (uri && canProxy(uri)) uris.add(uri);
    }
    return [...uris];
  }, [project]);

  /**
   * 清理的白名单必须是「所有能回放的项目」的并集（H3）。
   *
   * 资产库是这台机器共享的；只看当前项目，会把别的项目还在用的文件删掉。
   * 有日志段回放不了时，我们不知道它引用了什么——这时只列孤儿，不给删。
   */
  const scope = useMemo(() => {
    const { segments, skipped } = projectSegments(events);
    const projects = [project, ...segments.map((segment) => segment.project)];
    return {
      keep: referencedUrisOfProjects(projects),
      projects: projects.length,
      skipped,
    };
  }, [project, events]);
  const orphans = useMemo(
    () => (files ? orphanAssets(files, scope.keep) : undefined),
    [files, scope.keep],
  );
  const remoteOrphans = useMemo(
    () => (remoteFiles ? orphanAssets(remoteFiles, scope.keep) : undefined),
    [remoteFiles, scope.keep],
  );

  const loadStore = useCallback(async () => {
    try {
      const response = await fetch("/api/asset/store", { cache: "no-store" });
      if (!response.ok) return;
      const payload = (await response.json()) as {
        count?: number;
        files?: { uri: string; bytes: number }[];
      };
      if (typeof payload.count === "number") setStoreCount(payload.count);
      if (Array.isArray(payload.files)) {
        setFiles(
          payload.files.filter(
            (file): file is { uri: string; bytes: number } =>
              typeof file?.uri === "string" && typeof file?.bytes === "number",
          ),
        );
      }
    } catch {
      // 读不到统计不影响这一页：迁移与清理各自会报错
    }
  }, []);

  useEffect(() => {
    void loadStore();
  }, [loadStore, project]);

  const loadRemote = useCallback(async () => {
    if (!storageConfigured) return;
    try {
      const response = await fetch("/api/asset/remote", { cache: "no-store" });
      const payload = (await response.json()) as {
        files?: { uri: string; bytes: number }[];
        error?: string;
      };
      if (!response.ok) throw new Error(payload.error || `列桶失败（${response.status}）`);
      setRemoteError(undefined);
      setRemoteFiles(
        (payload.files ?? []).filter(
          (file): file is { uri: string; bytes: number } =>
            typeof file?.uri === "string" && typeof file?.bytes === "number",
        ),
      );
    } catch (caught) {
      setRemoteError(caught instanceof Error ? caught.message : "列桶失败");
    }
  }, [storageConfigured]);

  useEffect(() => {
    void loadRemote();
  }, [loadRemote, project]);

  const loadProxyCache = useCallback(async () => {
    try {
      const response = await fetch("/api/preview/proxy?stats=1", { cache: "no-store" });
      if (!response.ok) return;
      const payload = (await response.json()) as { count?: number; bytes?: number; cap?: number };
      if (
        typeof payload.count === "number" &&
        typeof payload.bytes === "number" &&
        typeof payload.cap === "number"
      ) {
        setProxyCache({ count: payload.count, bytes: payload.bytes, cap: payload.cap });
      }
    } catch {
      // 读不到缓存统计不影响这一页：代理本来就可有可无
    }
  }, []);

  useEffect(() => {
    void loadProxyCache();
  }, [loadProxyCache]);

  /**
   * 预生成代理：把这条片子里用到的片子先转一遍，第一次开预演就不用等。
   *
   * 服务端逐个转、已转好的跳过；一次最多 24 条（路由时限 120 秒）。
   * 转不出来不影响预演——它会自动回原片。
   */
  const pregenProxies = async () => {
    if (pregenBusy) return;
    setPregenBusy(true);
    setPregenNotice(undefined);
    setError(undefined);
    try {
      const response = await fetch("/api/preview/proxy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ assets: proxyAssets }),
      });
      const payload = (await response.json()) as {
        done?: number;
        cached?: number;
        failed?: number;
        errors?: string[];
        error?: string;
      };
      if (!response.ok) throw new Error(payload.error || `预生成失败（${response.status}）`);
      setPregenNotice(
        `转好 ${payload.done ?? 0} 份代理${
          payload.cached ? `，${payload.cached} 份本来就在` : ""
        }${
          payload.failed
            ? `，${payload.failed} 份没转成${payload.errors?.[0] ? `：${payload.errors[0]}` : ""}`
            : ""
        }。`,
      );
      await loadProxyCache();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "预生成失败");
    } finally {
      setPregenBusy(false);
    }
  };

  /** 清代理缓存：原片还在，下次开预演按需重建，所以不需要确认词 */
  const clearProxies = async () => {
    setClearingProxies(true);
    setProxyNotice(undefined);
    setError(undefined);
    try {
      const response = await fetch("/api/preview/proxy", { method: "DELETE" });
      const payload = (await response.json()) as { removed?: number; bytes?: number; error?: string };
      if (!response.ok) throw new Error(payload.error || `清理失败（${response.status}）`);
      setProxyNotice(
        payload.removed
          ? `清掉 ${payload.removed} 份代理（约 ${fmtBytes(payload.bytes ?? 0)}）；下次开预演会按需重建。`
          : "代理缓存本来就是空的。",
      );
      await loadProxyCache();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "清不掉代理缓存");
    } finally {
      setClearingProxies(false);
    }
  };

  const migrate = async () => {
    if (busy) return;
    setBusy(true);
    setError(undefined);
    setNotice(undefined);
    try {
      const result = await migrateAssets();
      setNotice(
        result.moved === 0 && result.failed === 0
          ? "没有要搬的素材：都已经在资产库里了。"
          : `搬完 ${result.moved} 个素材（日志里约 ${fmtBytes(result.bytes)}）${
              result.failed > 0 ? `，${result.failed} 个没搬成` : ""
            }。新素材不再进日志；旧事件里那份 base64 还在，要等日志压缩。`,
      );
      await loadStore();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "迁移失败");
    } finally {
      setBusy(false);
    }
  };

  /**
   * 日志瘦身：把事件里的 base64 换成库里同一段字节的地址。
   *
   * 不写新事件——压缩不改变项目，只改变同一段字节在日志里的写法。
   * 库里找不到同一段字节的（没搬过、或文件已经被清掉）留着不动，
   * 回执里如实说有几处。
   */
  const compact = async () => {
    if (busy) return;
    setBusy(true);
    setError(undefined);
    setNotice(undefined);
    setCompactNotice(undefined);
    try {
      const result = await compactLog(files ?? []);
      setCompactNotice(
        result.rewritten === 0
          ? result.unmatched > 0
            ? `库里找不到这 ${result.unmatched} 段字节的对应文件：先把素材搬进资产库，再来压缩。`
            : "日志里没有能压缩的 base64。"
          : `改写 ${result.assets} 处素材地址（${result.rewritten} 条事件），日志 ${fmtBytes(
              result.beforeBytes,
            )} → ${fmtBytes(result.afterBytes)}${
              result.unmatched > 0 ? `；另有 ${result.unmatched} 段在库里找不到，留着没动` : ""
            }。`,
      );
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "压缩失败");
    } finally {
      setBusy(false);
    }
  };

  /** 第一步：先问服务端「会删几个」，把真实数字写进确认句，不靠客户端猜 */
  const askClean = async () => {
    if (busy) return;
    if (scope.skipped > 0) {
      setError("有日志段回放不了，没法确认它们引用了什么；这次只列孤儿，不清理。");
      return;
    }
    setBusy(true);
    setError(undefined);
    setNotice(undefined);
    try {
      const response = await fetch("/api/asset/store", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ keep: scope.keep, dryRun: true }),
      });
      const payload = (await response.json()) as {
        wouldRemove?: number;
        bytes?: number;
        error?: string;
      };
      if (!response.ok) throw new Error(payload.error ?? `清点失败（${response.status}）`);
      setWouldRemove({ count: payload.wouldRemove ?? 0, bytes: payload.bytes ?? 0 });
      setCleaning(true);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "清点失败");
    } finally {
      setBusy(false);
    }
  };

  const clean = async () => {
    setCleaning(false);
    if (scope.skipped > 0) {
      setError("有日志段回放不了，没法确认它们引用了什么；这次只列孤儿，不清理。");
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      const response = await fetch("/api/asset/store", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ keep: scope.keep }),
      });
      const payload = (await response.json()) as {
        removed?: number;
        bytes?: number;
        error?: string;
      };
      if (!response.ok) throw new Error(payload.error ?? `清理失败（${response.status}）`);
      setNotice(
        payload.removed
          ? `清掉 ${payload.removed} 个没人引用的素材（约 ${fmtBytes(payload.bytes ?? 0)}）。`
          : "没有没人引用的素材。",
      );
      await loadStore();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "清理失败");
    } finally {
      setBusy(false);
    }
  };

  /** 桶里的清理：两步确认，确认句里的数字同样由服务端 dryRun 给 */
  const askRemoteClean = async () => {
    if (busy) return;
    if (scope.skipped > 0) {
      setRemoteError("有日志段回放不了，没法确认它们引用了什么；这次只列孤儿，不清理。");
      return;
    }
    setBusy(true);
    setRemoteError(undefined);
    setRemoteNotice(undefined);
    try {
      const response = await fetch("/api/asset/remote", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ keep: scope.keep, dryRun: true }),
      });
      const payload = (await response.json()) as {
        wouldRemove?: number;
        bytes?: number;
        error?: string;
      };
      if (!response.ok) throw new Error(payload.error ?? `清点失败（${response.status}）`);
      setRemoteWouldRemove({ count: payload.wouldRemove ?? 0, bytes: payload.bytes ?? 0 });
      setRemoteCleaning(true);
    } catch (caught) {
      setRemoteError(caught instanceof Error ? caught.message : "清点失败");
    } finally {
      setBusy(false);
    }
  };

  const cleanRemote = async () => {
    setRemoteCleaning(false);
    if (scope.skipped > 0) {
      setRemoteError("有日志段回放不了，没法确认它们引用了什么；这次只列孤儿，不清理。");
      return;
    }
    setBusy(true);
    setRemoteError(undefined);
    try {
      const response = await fetch("/api/asset/remote", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ keep: scope.keep }),
      });
      const payload = (await response.json()) as {
        removed?: number;
        bytes?: number;
        failed?: number;
        error?: string;
      };
      if (!response.ok) throw new Error(payload.error ?? `清理失败（${response.status}）`);
      setRemoteNotice(
        payload.removed
          ? `从桶里清掉 ${payload.removed} 个没人引用的对象（约 ${fmtBytes(payload.bytes ?? 0)}）${
              payload.failed ? `，${payload.failed} 个没删掉` : ""
            }。`
          : "桶里没有没人引用的对象。",
      );
      await loadRemote();
    } catch (caught) {
      setRemoteError(caught instanceof Error ? caught.message : "清理失败");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="mt-9 border-t border-line pt-5">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <div className="flex items-baseline gap-2">
          <h2 className="text-[12px] tracking-[.04em]">本机资产库</h2>
          <span className="tnum text-[9px] text-muted-2">H3</span>
        </div>
        <span className="tnum text-[9.5px] text-muted-2">
          {inventory.total} 个素材 · 资产库 {storeCount ?? "—"} 个文件
        </span>
      </div>
      <p className="mt-1 max-w-[640px] text-[9.5px] leading-[1.7] text-muted-2">
        素材按内容存在这台机器的 <code className="text-muted">.loomina/assets/</code>{" "}
        里，同一段字节只存一份。日志里只剩地址，撤销、回滚、重放都会变快。
        这里不是备份：删掉 <code className="text-muted">.loomina/</code> 或清浏览器数据就没了。
      </p>

      <dl className="mt-3 grid grid-cols-2 gap-x-6 gap-y-1 text-[10px] sm:grid-cols-4">
        <div>
          <dt className="text-[9px] text-muted-2">还在日志里</dt>
          <dd className="tnum text-muted">
            {inventory.inline} 个 · {fmtBytes(inventory.inlineBytes)}
          </dd>
        </div>
        <div>
          <dt className="text-[9px] text-muted-2">已进资产库</dt>
          <dd className="tnum text-muted">
            {inventory.stored} 个
            {inventory.remote > 0 ? ` · 对象存储 ${inventory.remote} 个` : ""}
          </dd>
        </div>
        <div>
          <dt className="text-[9px] text-muted-2">当前项目没人引用</dt>
          <dd className="tnum text-muted">{inventory.unreferenced.length} 个</dd>
        </div>
        <div>
          <dt className="text-[9px] text-muted-2">没地址</dt>
          <dd className="tnum text-muted">
            {inventory.total - inventory.inline - inventory.stored} 个
          </dd>
        </div>
      </dl>

      <div className="mt-3 rounded-token border border-line px-3 py-2">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h3 className="text-[10px] text-text">跨项目孤儿检查</h3>
          <span className="tnum text-[9px] text-muted-2">
            {scope.projects} 个项目 · 白名单 {scope.keep.length} 个地址
          </span>
        </div>
        {scope.skipped > 0 ? (
          <p className="mt-1 text-[9.5px] leading-[1.7] text-pick">
            有 {scope.skipped} 段日志回放不了，不知道它们引用了什么。这次只列孤儿，
            清理停用——宁可少删，不误删别的项目。
          </p>
        ) : (
          <p className="mt-1 text-[9.5px] leading-[1.7] text-muted-2">
            白名单来自所有能回放的项目，不只当前项目。下面只列不删：
            刚生成还没挂载、刚回滚的引用都像没人用，确认清理才走两步确认。
          </p>
        )}
        {orphans ? (
          <>
            <p className="mt-1.5 text-[10px] text-text">
              本机资产库孤儿：{orphans.count} 个 · {fmtBytes(orphans.bytes)}
            </p>
            {orphans.count > 0 && (
              <ul className="mt-1 space-y-0.5">
                {orphans.orphans.slice(0, 5).map((file) => (
                  <li
                    key={file.uri}
                    className="tnum truncate text-[8.5px] leading-[1.6] text-muted-2"
                  >
                    {file.uri.replace(/^loomina:\/\//, "")} · {fmtBytes(file.bytes)}
                  </li>
                ))}
                {orphans.count > 5 && (
                  <li className="text-[8.5px] text-muted-2">还有 {orphans.count - 5} 个…</li>
                )}
              </ul>
            )}
          </>
        ) : (
          <p className="mt-1.5 text-[9px] text-muted-2">
            读不到资产库清单；确认本机资产库可用后重开这一页。
          </p>
        )}
      </div>

      {storageConfigured && (
        <div className="mt-3 rounded-token border border-line px-3 py-2">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h3 className="text-[10px] text-text">桶里的孤儿对象</h3>
            <span className="tnum text-[9px] text-muted-2">
              {remoteFiles ? `assets/ 前缀 ${remoteFiles.length} 个对象` : "读不到桶清单"}
            </span>
          </div>
          <p className="mt-1 text-[9.5px] leading-[1.7] text-muted-2">
            只列 <code className="text-muted">assets/</code> 前缀下的对象，白名单与本机库同一个
            （所有能回放项目的地址并集）。删的是桶里的对象，撤销找不回来。
          </p>
          {remoteError && (
            <p className="mt-1 text-[9.5px] leading-[1.7] text-pick">{remoteError}</p>
          )}
          {remoteOrphans ? (
            <>
              <p className="mt-1.5 text-[10px] text-text">
                桶里孤儿：{remoteOrphans.count} 个 · {fmtBytes(remoteOrphans.bytes)}
              </p>
              {remoteOrphans.count > 0 && (
                <ul className="mt-1 space-y-0.5">
                  {remoteOrphans.orphans.slice(0, 5).map((file) => (
                    <li
                      key={file.uri}
                      className="tnum truncate text-[8.5px] leading-[1.6] text-muted-2"
                    >
                      {file.uri.replace(/^s3:\/\//, "")} · {fmtBytes(file.bytes)}
                    </li>
                  ))}
                  {remoteOrphans.count > 5 && (
                    <li className="text-[8.5px] text-muted-2">还有 {remoteOrphans.count - 5} 个…</li>
                  )}
                </ul>
              )}
            </>
          ) : (
            !remoteError && (
              <p className="mt-1.5 text-[9px] text-muted-2">正在列桶…</p>
            )
          )}
          {remoteCleaning ? (
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <span className="text-[10px] leading-[1.6] text-pick">
                {remoteWouldRemove
                  ? `会从桶里删掉 ${remoteWouldRemove.count} 个对象（约 ${fmtBytes(
                      remoteWouldRemove.bytes,
                    )}），撤销找不回来。确定？`
                  : "正在清点桶…"}
              </span>
              <button
                type="button"
                onClick={() => void cleanRemote()}
                className="rounded-token border border-pick px-2.5 py-1 text-[10px] text-pick transition-colors duration-[var(--dur)] hover:bg-pick/10"
              >
                确认清理桶
              </button>
              <button
                type="button"
                onClick={() => {
                  setRemoteCleaning(false);
                  setRemoteWouldRemove(undefined);
                }}
                className="rounded-token border border-line px-2.5 py-1 text-[10px] text-muted transition-colors duration-[var(--dur)] hover:border-line-2 hover:text-text"
              >
                算了
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => void askRemoteClean()}
              disabled={readOnly || busy || !remoteFiles || remoteFiles.length === 0 || scope.skipped > 0}
              title={
                scope.skipped > 0
                  ? "有日志段回放不了：只列孤儿，不清理"
                  : "只删所有能回放的项目都没引用的对象；不自动删"
              }
              className="mt-2 rounded-token border border-line px-2.5 py-1 text-[10px] text-muted transition-colors duration-[var(--dur)] hover:border-line-2 hover:text-text disabled:opacity-40"
            >
              清理桶里没人引用的对象
            </button>
          )}
          {remoteNotice && (
            <p className="mt-2 text-[9.5px] leading-[1.7] text-muted">{remoteNotice}</p>
          )}
        </div>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => void migrate()}
          disabled={readOnly || busy || inventory.inline === 0}
          title={
            readOnly
              ? "另一个标签页在编辑：这一页只读"
              : inventory.inline === 0
                ? "素材都已在资产库里"
                : "把日志里的 data URI 搬进本机资产库"
          }
          className="rounded-token border border-line px-2.5 py-1 text-[10px] text-muted transition-colors duration-[var(--dur)] hover:border-line-2 hover:text-text disabled:opacity-40"
        >
          {busy ? "处理中…" : `把素材搬进资产库（${inventory.inline} 个）`}
        </button>

        {cleaning ? (
          <>
            <span className="text-[10px] leading-[1.6] text-pick">
              {wouldRemove
                ? `清理会删掉 ${wouldRemove.count} 个「所有能回放的项目都没引用」的文件（约 ${fmtBytes(
                    wouldRemove.bytes,
                  )}），撤销找不回来。确定？`
                : "正在清点资产库…"}
            </span>
            <button
              type="button"
              onClick={() => void clean()}
              className="rounded-token border border-pick px-2.5 py-1 text-[10px] text-pick transition-colors duration-[var(--dur)] hover:bg-pick/10"
            >
              确认清理
            </button>
            <button
              type="button"
              onClick={() => {
                setCleaning(false);
                setWouldRemove(undefined);
              }}
              className="rounded-token border border-line px-2.5 py-1 text-[10px] text-muted transition-colors duration-[var(--dur)] hover:border-line-2 hover:text-text"
            >
              算了
            </button>
          </>
        ) : (
          <button
            type="button"
            onClick={() => void askClean()}
            disabled={readOnly || busy || (storeCount ?? 0) === 0 || scope.skipped > 0}
            title={
              scope.skipped > 0
                ? "有日志段回放不了：只列孤儿，不清理"
                : "只删所有能回放的项目都没引用的文件；不自动删"
            }
            className="rounded-token border border-line px-2.5 py-1 text-[10px] text-muted transition-colors duration-[var(--dur)] hover:border-line-2 hover:text-text disabled:opacity-40"
          >
            清理没人引用的文件
          </button>
        )}
      </div>

      <div className="mt-3 rounded-token border border-line px-3 py-2">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h3 className="text-[10px] text-text">日志瘦身</h3>
          <span className="tnum text-[9px] text-muted-2">
            {inlineLog.occurrences} 处 base64 · 约 {fmtBytes(inlineLog.bytes)}
          </span>
        </div>
        <p className="mt-1 max-w-[640px] text-[9.5px] leading-[1.7] text-muted-2">
          迁移只追加新地址，旧事件里那份 base64 不动，所以日志不会自己变小。
          压缩把它换成库里<span className="text-muted">同一段字节</span>的地址——按内容指纹认，
          不按资产位认（同一个位换过图，那是两张图）；事件条数、顺序与时间都不变。
        </p>
        <button
          type="button"
          onClick={() => void compact()}
          disabled={readOnly || busy || inlineLog.occurrences === 0 || !files || files.length === 0}
          title={
            readOnly
              ? "另一个标签页在编辑：这一页只读"
              : inlineLog.occurrences === 0
                ? "日志里没有 base64 了"
                : !files || files.length === 0
                  ? "读不到资产库清单，认不出哪段字节进过库"
                  : "只换地址，不删事件；库里没有同一段字节的留着不动"
          }
          className="mt-2 rounded-token border border-line px-2.5 py-1 text-[10px] text-muted transition-colors duration-[var(--dur)] hover:border-line-2 hover:text-text disabled:opacity-40"
        >
          压缩日志
        </button>
        {compactNotice && (
          <p className="mt-2 text-[9.5px] leading-[1.7] text-muted">{compactNotice}</p>
        )}
      </div>

      <div className="mt-3 rounded-token border border-line px-3 py-2">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h3 className="text-[10px] text-text">预演代理缓存</h3>
          <span className="tnum text-[9px] text-muted-2">
            {proxyCache
              ? `${proxyCache.count} 份 · ${fmtBytes(proxyCache.bytes)} / ${fmtBytes(proxyCache.cap)}`
              : "读不到缓存统计"}
          </span>
        </div>
        <p className="mt-1 max-w-[640px] text-[9.5px] leading-[1.7] text-muted-2">
          540p 代理只给预演看着顺，原片才是唯一事实：删掉不影响导出，下次开预演按需重建。
          超过上限时自动按最久没用的先删，刚转好的那份不删。
        </p>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => void pregenProxies()}
            disabled={readOnly || pregenBusy || clearingProxies || proxyAssets.length === 0}
            title={
              readOnly
                ? "另一个标签页在编辑：这一页只读"
                : proxyAssets.length === 0
                  ? "这条片子里还没有在资产库里的视频"
                  : "把这条片子用到的视频先转一遍；一次最多 24 条"
            }
            className="rounded-token border border-line px-2.5 py-1 text-[10px] text-muted transition-colors duration-[var(--dur)] hover:border-line-2 hover:text-text disabled:opacity-40"
          >
            {pregenBusy ? "正在转…" : `预生成代理（${proxyAssets.length} 条）`}
          </button>
          <button
            type="button"
            onClick={() => void clearProxies()}
            disabled={readOnly || clearingProxies || pregenBusy || (proxyCache?.count ?? 0) === 0}
            title={
              readOnly
                ? "另一个标签页在编辑：这一页只读"
                : (proxyCache?.count ?? 0) === 0
                  ? "还没有代理缓存"
                  : "只清代理：原片与素材本体都不动"
            }
            className="rounded-token border border-line px-2.5 py-1 text-[10px] text-muted transition-colors duration-[var(--dur)] hover:border-line-2 hover:text-text disabled:opacity-40"
          >
            {clearingProxies ? "正在清…" : "清掉代理缓存"}
          </button>
        </div>
        {pregenNotice && (
          <p className="mt-2 text-[9.5px] leading-[1.7] text-muted">{pregenNotice}</p>
        )}
        {proxyNotice && (
          <p className="mt-2 text-[9.5px] leading-[1.7] text-muted">{proxyNotice}</p>
        )}
      </div>

      {notice && <p className="mt-2 text-[9.5px] leading-[1.7] text-muted">{notice}</p>}
      {error && <p className="mt-2 text-[9.5px] leading-[1.7] text-pick">{error}</p>}
    </section>
  );
}

/**
 * 对象存储（H3 / ADR-0128 §3 / ADR-0129 §3）。
 *
 * 这一块和「本机资产库」是同一件事的两种落地：配好对象存储之后，
 * 新素材进桶、地址变成 `s3://`，本机那份可以清掉。
 *
 * 密钥的规矩与供应商一样：输入框只显示「有没有」，保存后拿不回来；
 * 缺省表示沿用已保存的，空串表示清空。界面上**永远不显示 AK/SK**。
 */
function ObjectStorageSection({
  readOnly,
  storage,
  onSaved,
}: {
  readOnly: boolean;
  storage: PublicStorage | undefined;
  onSaved: (next: PublicStorage) => void;
}) {
  const [open, setOpen] = useState(false);
  const [endpoint, setEndpoint] = useState("");
  const [bucket, setBucket] = useState("");
  const [region, setRegion] = useState("us-east-1");
  const [accessKeyId, setAccessKeyId] = useState("");
  const [secretKey, setSecretKey] = useState("");
  const [pathStyle, setPathStyle] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [probe, setProbe] = useState<{
    configured: boolean;
    target?: string;
    objects?: number;
    bytes?: number;
    ms?: number;
    note?: string;
    error?: string;
  }>();

  // 打开表单时用已保存的值预填；密钥永远不回填
  useEffect(() => {
    if (!open) return;
    setEndpoint(storage?.endpoint ?? "");
    setBucket(storage?.bucket ?? "");
    setRegion(storage?.region ?? "us-east-1");
    setPathStyle(storage?.pathStyle ?? true);
    setAccessKeyId("");
    setSecretKey("");
  }, [open, storage]);

  const probeNow = async () => {
    setBusy(true);
    setError(undefined);
    try {
      const response = await fetch("/api/storage?probe=1", { cache: "no-store" });
      const payload = (await response.json()) as {
        configured?: boolean;
        target?: string;
        objects?: number;
        bytes?: number;
        ms?: number;
        note?: string;
        error?: string;
      };
      setProbe({ configured: Boolean(payload.configured), ...payload });
    } catch (caught) {
      setProbe({ configured: false, error: caught instanceof Error ? caught.message : "探测失败" });
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    if (busy) return;
    setBusy(true);
    setError(undefined);
    setNotice(undefined);
    try {
      const response = await fetch("/api/storage", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          storage: {
            kind: "s3",
            endpoint: endpoint.trim(),
            bucket: bucket.trim(),
            region: region.trim(),
            accessKeyId: accessKeyId.trim(),
            // 空串 = 沿用已保存的密钥；要清空请点「清掉对象存储」
            ...(secretKey.trim() ? { secretAccessKey: secretKey.trim() } : {}),
            pathStyle,
          },
        }),
      });
      const payload = (await response.json()) as { storage?: PublicStorage; error?: string };
      if (!response.ok || !payload.storage) {
        throw new Error(payload.error || `保存失败（${response.status}）`);
      }
      onSaved(payload.storage);
      setSecretKey("");
      setNotice("已保存。新素材会进对象存储，地址变成 s3://…；已有素材不动。");
      void probeNow();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "保存失败");
    } finally {
      setBusy(false);
    }
  };

  const clear = async () => {
    if (busy) return;
    setBusy(true);
    setError(undefined);
    setNotice(undefined);
    try {
      const response = await fetch("/api/storage", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ storage: null }),
      });
      const payload = (await response.json()) as { storage?: PublicStorage; error?: string };
      if (!response.ok || !payload.storage) {
        throw new Error(payload.error || `清空失败（${response.status}）`);
      }
      onSaved(payload.storage);
      setProbe(undefined);
      setNotice("已清掉对象存储配置：回到本机资产库。桶里的对象没有被删。");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "清空失败");
    } finally {
      setBusy(false);
    }
  };

  const active = storage?.active === "s3";

  return (
    <section className="mt-9 border-t border-line pt-5">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <div className="flex items-baseline gap-2">
          <h2 className="text-[12px] tracking-[.04em]">对象存储</h2>
          <span className="tnum text-[9px] text-muted-2">H3</span>
        </div>
        <span className="tnum text-[9.5px] text-muted-2">
          {active
            ? `${storage?.endpointHost ?? "—"} / ${storage?.bucket ?? "—"} · ${storage?.region ?? ""}`
            : storage?.configured
              ? "已配置 · 未启用"
              : "未配置 · 用本机资产库"}
        </span>
      </div>

      <p className="mt-1 max-w-[640px] text-[9.5px] leading-[1.7] text-muted-2">
        S3 兼容的对象存储（AWS S3 / 阿里云 OSS / 腾讯云 COS / MinIO）。
        配好之后新素材直接进桶，地址是 <code className="text-muted">s3://桶/路径</code>；
        签名在服务端算（SigV4 预签名），浏览器拿到的只是一条十分钟内有效的地址。
        <span className="text-muted"> 密钥只写在服务端配置文件里，回给浏览器的只有主机与桶名。</span>
      </p>

      {storage?.note && (
        <p className="mt-1.5 text-[9.5px] leading-[1.7] text-pick">{storage.note}</p>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => void probeNow()}
          disabled={busy}
          className="rounded-token border border-line px-2.5 py-1 text-[10px] text-muted transition-colors duration-[var(--dur)] hover:border-line-2 hover:text-text disabled:opacity-40"
        >
          {busy ? "探测中…" : "探测连通"}
        </button>
        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          disabled={readOnly}
          className="rounded-token border border-line px-2.5 py-1 text-[10px] text-muted transition-colors duration-[var(--dur)] hover:border-line-2 hover:text-text disabled:opacity-40"
        >
          {open ? "收起" : storage?.configured ? "改配置" : "配置对象存储"}
        </button>
        {storage?.configured && (
          <button
            type="button"
            onClick={() => void clear()}
            disabled={readOnly || busy}
            title="只清掉配置；桶里的对象不会被删"
            className="rounded-token border border-line px-2.5 py-1 text-[10px] text-muted transition-colors duration-[var(--dur)] hover:border-pick hover:text-pick disabled:opacity-40"
          >
            清掉对象存储
          </button>
        )}
      </div>

      {probe && (
        <p className="mt-2 text-[9.5px] leading-[1.7] text-muted">
          {probe.error
            ? `连不上：${probe.error}`
            : !probe.configured
              ? probe.note ?? "还没配置对象存储"
              : `连通 · ${probe.target ?? ""} · ${probe.objects ?? 0} 个对象 · ${fmtBytes(
                  probe.bytes ?? 0,
                )}${probe.ms !== undefined ? ` · ${probe.ms} ms` : ""}`}
        </p>
      )}

      {open && (
        <div className="mt-3 grid max-w-[640px] gap-3 border-t border-line pt-3 sm:grid-cols-2">
          <Field label="Endpoint" hint="http(s)，不带结尾斜杠。MinIO 例：http://127.0.0.1:9000">
            <input
              id="storage-endpoint"
              value={endpoint}
              onChange={(event) => setEndpoint(event.target.value)}
              placeholder="https://s3.us-east-1.amazonaws.com"
              className={inputClass}
            />
          </Field>
          <Field label="桶" hint="3–63 个小写字母、数字、点、连字符">
            <input
              id="storage-bucket"
              value={bucket}
              onChange={(event) => setBucket(event.target.value)}
              placeholder="loomina-assets"
              className={inputClass}
            />
          </Field>
          <Field label="区域" hint="例如 us-east-1、ap-east-1">
            <input
              id="storage-region"
              value={region}
              onChange={(event) => setRegion(event.target.value)}
              placeholder="us-east-1"
              className={inputClass}
            />
          </Field>
          <Field label="Access Key ID">
            <input
              id="storage-ak"
              value={accessKeyId}
              onChange={(event) => setAccessKeyId(event.target.value)}
              placeholder={storage?.configured ? "改填就换掉；留空不动" : "AKIA…"}
              autoComplete="off"
              className={inputClass}
            />
          </Field>
          <Field
            label="Secret Access Key"
            hint={storage?.configured ? "留空 = 沿用已保存的密钥；界面上永远不回显" : "只写进服务端配置文件（0600）"}
          >
            <input
              id="storage-sk"
              type="password"
              value={secretKey}
              onChange={(event) => setSecretKey(event.target.value)}
              placeholder={storage?.configured ? "••••••（已保存）" : ""}
              autoComplete="new-password"
              className={inputClass}
            />
          </Field>
          <Field label="寻址方式" hint="MinIO / 自建网关只认 path-style">
            <select
              id="storage-path-style"
              value={pathStyle ? "path" : "virtual"}
              onChange={(event) => setPathStyle(event.target.value === "path")}
              className={selectClass}
            >
              <option value="path">path-style（host/bucket/key）</option>
              <option value="virtual">virtual-hosted（bucket.host/key）</option>
            </select>
          </Field>
          <div className="flex items-center gap-2 sm:col-span-2">
            <button
              type="button"
              onClick={() => void save()}
              disabled={readOnly || busy}
              className="rounded-token border border-line px-2.5 py-1 text-[10px] text-text transition-colors duration-[var(--dur)] hover:border-line-2 disabled:opacity-40"
            >
              {busy ? "保存中…" : "保存对象存储"}
            </button>
            <span className="text-[9px] leading-4 text-muted-2">
              Endpoint 与桶名会在保存后校验；密钥不通过浏览器回传。
            </span>
          </div>
        </div>
      )}

      {notice && <p className="mt-2 text-[9.5px] leading-[1.7] text-muted">{notice}</p>}
      {error && <p className="mt-2 text-[9.5px] leading-[1.7] text-pick">{error}</p>}
    </section>
  );
}
