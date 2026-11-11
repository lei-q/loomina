"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { HealthPanel } from "@/components/health-panel";
import { Logomark } from "@/components/icons";
import {
  MODALITIES,
  MODALITY_HINT,
  MODALITY_LABEL,
  type Modality,
  type PublicConfig,
  type VideoApiName,
} from "@/lib/config-types";
import { fetchModelConfig, invalidateModelConfig } from "@/lib/model-choice";
import { useWorkbench } from "@/lib/workbench-store";
import type { CapabilityResponse, ModelCapabilityView } from "@/lib/capabilities";
import type { ProbeReportView } from "@/lib/probes";
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
  /** 商用条款 / 能力备注（B12）；空表示未确认 */
  terms: string;
};

type Probe = { ok: boolean; message: string };

const EMPTY_VIDEO_API: "" | VideoApiName = "";

const PRICE_UNIT: Record<"per_second" | "per_image", string> = {
  per_second: "秒",
  per_image: "张",
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

  const applyConfig = useCallback((config: PublicConfig) => {
    const next = draftsFrom(config);
    setProviders(next.providers);
    setModels(next.models);
    setDefaults(next.defaults);
    setPath(config.path);
    setSaved(config.saved);
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

              <ProbeReports probes={capability.probes} />
            </>
          )}
        </section>

        <LocalProjectSection
          eventCount={eventCount}
          readOnly={Boolean(readOnly)}
          onReset={reset}
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

function ProbeReports({ probes }: { probes: ProbeReportView[] }) {
  return (
    <div className="mt-6">
      <div className="flex items-baseline justify-between gap-2 border-b border-line pb-1">
        <h3 className="text-[10.5px] text-text">S1 测绘报告</h3>
        <span className="tnum text-[9px] text-muted-2">最近 {probes.length} 次</span>
      </div>
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
        失败码是供应商返回的分类，不是质量评分。
      </p>
    </div>
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

function modelIdValid(model: ModelDraft): boolean {
  return Boolean(model.providerId && model.model.trim());
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
        云端对象存储还没接（F4 / H3），所以这里没有「同步」。
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
