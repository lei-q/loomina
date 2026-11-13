import type { Project } from "@loomina/ir";
import { isStoredAssetUri, S3_PREFIX } from "@/lib/asset-uri";

/**
 * 资产清点（H3 / ADR-0128）。
 *
 * 回答设置页要问的三件事：
 * - 一共几个资产，几个还在事件日志里（data URI）、几个已进资产库；
 * - 日志里那份 base64 还有多少字节（迁移之后不会变小，要说清）；
 * - 哪些资产没有任何引用（**只列不删**：刚生成未挂载、刚回滚的引用都像没人用）。
 *
 * 纯函数：不读盘、不发请求，测试可以直接跑示例项目。
 */

export type AssetUsage = {
  id: string;
  kind: "image" | "video" | "audio";
  /** 是否已经被引用 */
  referenced: boolean;
  /** 地址在日志里（data:）、本机资产库（loomina://）还是对象存储（s3://） */
  placement: "inline" | "store" | "remote" | "none";
  /** 日志里那一份的字节数；资产库里的记 0（字节在盘上） */
  inlineBytes: number;
};

export type AssetInventory = {
  total: number;
  /** 还在事件日志里的资产数 */
  inline: number;
  /** 已进本机资产库的资产数 */
  stored: number;
  /** 已在对象存储里的资产数（H3 / s3://） */
  remote: number;
  /** 日志里 base64 的总字节数（迁移之后这个数不会掉，因为旧事件不动；要真变小走日志压缩，ADR-0177） */
  inlineBytes: number;
  /** 没有任何引用的资产 */
  unreferenced: AssetUsage[];
  unreferencedBytes: number;
  usage: AssetUsage[];
};

/** 所有「指向资产」的引用点（新增引用方时记得补这里） */
export function referencedAssetIds(project: Project): Set<string> {
  const ids = new Set<string>();
  for (const character of project.characters) {
    for (const id of Object.values(character.sheet)) if (id) ids.add(id);
    for (const id of character.referenceImages) ids.add(id);
  }
  for (const location of project.locations) {
    if (location.masterShotId) ids.add(location.masterShotId);
    for (const id of location.referenceImages) ids.add(id);
  }
  for (const prop of project.props) for (const id of prop.referenceImages) ids.add(id);
  for (const shot of project.shots) {
    if (shot.keyframes.firstAssetId) ids.add(shot.keyframes.firstAssetId);
    if (shot.keyframes.lastAssetId) ids.add(shot.keyframes.lastAssetId);
  }
  for (const take of project.takes) ids.add(take.assetId);
  for (const line of project.dialogue) if (line.audioAssetId) ids.add(line.audioAssetId);
  for (const cue of project.timeline.music) ids.add(cue.assetId);
  for (const pack of project.publishPackages) if (pack.videoAssetId) ids.add(pack.videoAssetId);
  return ids;
}

/** data URI 里 base64 解码后的字节数；不是 data URI 返回 0 */
export function inlineBytesOf(uri: string | undefined): number {
  if (!uri) return 0;
  const match = /^data:[^;,]+;base64,([A-Za-z0-9+/=\s]+)$/i.exec(uri.trim());
  if (!match) return 0;
  const base64 = match[1]!.replace(/\s+/g, "");
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((base64.length * 3) / 4) - padding);
}

export function inventoryOf(project: Project): AssetInventory {
  const referenced = referencedAssetIds(project);
  const usage: AssetUsage[] = project.assets.map((asset) => {
    const placement = !asset.uri
      ? "none"
      : isStoredAssetUri(asset.uri)
        ? "store"
        : asset.uri.startsWith(S3_PREFIX)
          ? "remote"
          : asset.uri.startsWith("data:")
            ? "inline"
            : "none";
    return {
      id: asset.id,
      kind: asset.kind,
      referenced: referenced.has(asset.id),
      placement,
      inlineBytes: placement === "inline" ? inlineBytesOf(asset.uri) : 0,
    };
  });

  const unreferenced = usage.filter((item) => !item.referenced);
  return {
    total: usage.length,
    inline: usage.filter((item) => item.placement === "inline").length,
    stored: usage.filter((item) => item.placement === "store").length,
    remote: usage.filter((item) => item.placement === "remote").length,
    inlineBytes: usage.reduce((sum, item) => sum + item.inlineBytes, 0),
    unreferenced,
    unreferencedBytes: unreferenced.reduce((sum, item) => sum + item.inlineBytes, 0),
    usage,
  };
}

/** 当前项目里还在用的资产地址：清理资产库时当白名单送上去 */
export function referencedUris(project: Project): string[] {
  const referenced = referencedAssetIds(project);
  return project.assets
    .filter(
      (asset) =>
        referenced.has(asset.id) &&
        asset.uri &&
        (isStoredAssetUri(asset.uri) || asset.uri.startsWith(S3_PREFIX)),
    )
    .map((asset) => asset.uri!);
}

/**
 * 多个项目的地址并集（H3 安全版孤儿检查）。
 *
 * 资产库是这台机器共享的：只拿当前项目的引用当白名单，会把别的项目
 * 还在用的文件当成孤儿删掉。清理前必须把所有能回放的项目都算进来。
 */
export function referencedUrisOfProjects(projects: Project[]): string[] {
  return [...new Set(projects.flatMap((project) => referencedUris(project)))];
}

export type OrphanFile = { uri: string; bytes: number };

export type OrphanReport = {
  orphans: OrphanFile[];
  count: number;
  bytes: number;
};

/**
 * 纯函数版孤儿检查：地址不在白名单里的文件才算孤儿。
 *
 * 只用来列，不负责删；界面在没有把握（日志有段回放不了）时宁可整块禁用清理。
 */
export function orphanAssets(
  files: { uri: string; bytes: number }[],
  keep: Iterable<string>,
): OrphanReport {
  const white = new Set(keep);
  const orphans = files.filter((file) => !white.has(file.uri));
  return {
    orphans,
    count: orphans.length,
    bytes: orphans.reduce((sum, file) => sum + file.bytes, 0),
  };
}

// ── 资产库页面（F4）────────────────────────────────────────────

/** 资产库页面按什么筛 */
export type AssetFilter = "all" | "used" | "unused" | "missing";

/** 页面上一行资产 */
export type LibraryRow = {
  assetId: string;
  kind: "image" | "video" | "audio";
  /** 生成 / 上传 / 素材库 / 导入 */
  source: string;
  /** 在日志里 / 本机库 / 对象存储 / 没地址 */
  placement: AssetUsage["placement"];
  /** 被谁用：人话标签，按出现顺序 */
  usedBy: string[];
  /** 地址；没地址就是 undefined */
  uri?: string;
  /** 日志里那份 base64 的字节数 */
  inlineBytes: number;
  /** 资产库里的文件字节数；没读到就是 undefined */
  storeBytes?: number;
  /** 文件在不在：本机库 / 对象存储里的地址，但磁盘上找不到 */
  fileMissing: boolean;
  costCny?: number;
  createdAt: string;
};

export type LibraryView = {
  rows: LibraryRow[];
  total: number;
  used: number;
  unused: number;
  missing: number;
  /** 日志里 base64 的总字节 */
  inlineBytes: number;
  /** 资产库里文件的总字节（读得到的部分） */
  storeBytes: number;
  /** 按 kind 分：各几个、各多少字节 */
  byKind: { kind: LibraryRow["kind"]; count: number; bytes: number }[];
  /** 按来源分 */
  bySource: { source: string; count: number }[];
};

/**
 * 每一条资产被谁用着（F4）。
 *
 * 与 `referencedAssetIds` 同一套引用点，但这里要说出**用在哪**——
 * 「没人引用」和「被第 3 镜的首帧用着」在清理时是完全不同的两件事。
 */
export function assetUsageLabels(project: Project): Map<string, string[]> {
  const labels = new Map<string, string[]>();
  const add = (assetId: string | undefined, label: string) => {
    if (!assetId) return;
    const list = labels.get(assetId);
    if (list) {
      if (!list.includes(label)) list.push(label);
    } else {
      labels.set(assetId, [label]);
    }
  };

  const shotNo = new Map<string, number>();
  project.shots.forEach((shot, index) => shotNo.set(shot.id, index + 1));
  const takeById = new Map(project.takes.map((take) => [take.id, take]));

  for (const character of project.characters) {
    for (const [slot, id] of Object.entries(character.sheet)) {
      add(id, `定妆「${character.name}」${SHEET_SLOT_CN[slot] ?? slot}`);
    }
    for (const id of character.referenceImages) add(id, `参考图「${character.name}」`);
  }
  for (const location of project.locations) {
    if (location.masterShotId) add(location.masterShotId, `主镜「${location.name}」`);
    for (const id of location.referenceImages) add(id, `参考图「${location.name}」`);
  }
  for (const prop of project.props) {
    for (const id of prop.referenceImages) add(id, `参考图「${prop.name}」`);
  }
  for (const shot of project.shots) {
    const no = shotNo.get(shot.id) ?? 0;
    if (shot.keyframes.firstAssetId) add(shot.keyframes.firstAssetId, `第 ${no} 镜 首帧`);
    if (shot.keyframes.lastAssetId) add(shot.keyframes.lastAssetId, `第 ${no} 镜 尾帧`);
  }
  for (const take of project.takes) {
    const no = shotNo.get(take.shotId) ?? 0;
    add(take.assetId, `第 ${no} 镜 take`);
  }
  for (const line of project.dialogue) {
    add(line.audioAssetId, `配音「${line.text.slice(0, 10)}${line.text.length > 10 ? "…" : ""}」`);
  }
  for (const cue of project.timeline.music) add(cue.assetId, `配乐「${cue.title}」`);
  for (const pack of project.publishPackages) {
    if (pack.videoAssetId) add(pack.videoAssetId, `发布包「${pack.platform}」`);
  }
  // 画面轨上真正被排进成片的 take：单独标出来，比「某镜 take」更准
  for (const item of project.timeline.items) {
    const take = takeById.get(item.takeId);
    if (!take) continue;
    const list = labels.get(take.assetId);
    if (!list) continue;
    const index = list.findIndex((label) => label.includes("take"));
    if (index >= 0) list[index] = `${list[index]!}（在成片里）`;
  }
  return labels;
}

const SHEET_SLOT_CN: Record<string, string> = {
  front: "正面",
  threeQuarter: "四分之三",
  side: "侧面",
  back: "背面",
};

/**
 * 资产库视图（F4）。
 *
 * `storeFiles` 是本机资产库 / 对象存储的清单（地址 → 字节数），由页面去取：
 * 这里只做纯计算，不读盘、不发请求。给了清单就能算出「文件在不在」。
 */
export function libraryOf(
  project: Project,
  storeFiles?: Map<string, number>,
): LibraryView {
  const labels = assetUsageLabels(project);
  const rows: LibraryRow[] = project.assets.map((asset) => {
    const placement = !asset.uri
      ? "none"
      : isStoredAssetUri(asset.uri)
        ? "store"
        : asset.uri.startsWith(S3_PREFIX)
          ? "remote"
          : asset.uri.startsWith("data:")
            ? "inline"
            : "none";
    const usedBy = labels.get(asset.id) ?? [];
    const storeBytes =
      storeFiles && asset.uri ? storeFiles.get(asset.uri) : undefined;
    // 文件缺失：地址说在库里 / 对象存储里，但清单里没有它
    const fileMissing =
      Boolean(storeFiles) &&
      (placement === "store" || placement === "remote") &&
      storeBytes === undefined;
    return {
      assetId: asset.id,
      kind: asset.kind === "video" || asset.kind === "audio" ? asset.kind : "image",
      source: asset.source,
      placement,
      usedBy,
      ...(asset.uri ? { uri: asset.uri } : {}),
      inlineBytes: placement === "inline" ? inlineBytesOf(asset.uri) : 0,
      ...(storeBytes !== undefined ? { storeBytes } : {}),
      fileMissing,
      ...(asset.costCny !== undefined ? { costCny: asset.costCny } : {}),
      createdAt: asset.createdAt,
    };
  });

  const kinds: LibraryRow["kind"][] = ["image", "video", "audio"];
  return {
    rows,
    total: rows.length,
    used: rows.filter((row) => row.usedBy.length > 0).length,
    unused: rows.filter((row) => row.usedBy.length === 0).length,
    missing: rows.filter((row) => row.fileMissing).length,
    inlineBytes: rows.reduce((sum, row) => sum + row.inlineBytes, 0),
    storeBytes: rows.reduce((sum, row) => sum + (row.storeBytes ?? 0), 0),
    byKind: kinds.map((kind) => ({
      kind,
      count: rows.filter((row) => row.kind === kind).length,
      bytes: rows
        .filter((row) => row.kind === kind)
        .reduce((sum, row) => sum + row.inlineBytes + (row.storeBytes ?? 0), 0),
    })),
    bySource: [...new Set(rows.map((row) => row.source))].map((source) => ({
      source,
      count: rows.filter((row) => row.source === source).length,
    })),
  };
}

/** 按筛选条件取行（F4）：筛的是「用没用」「文件在不在」 */
export function filterLibrary(rows: LibraryRow[], filter: AssetFilter): LibraryRow[] {
  switch (filter) {
    case "used":
      return rows.filter((row) => row.usedBy.length > 0);
    case "unused":
      return rows.filter((row) => row.usedBy.length === 0);
    case "missing":
      return rows.filter((row) => row.fileMissing);
    default:
      return rows;
  }
}
