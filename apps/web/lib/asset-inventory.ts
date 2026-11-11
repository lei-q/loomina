import type { Project } from "@loomina/ir";
import { isStoredAssetUri } from "@/lib/asset-uri";

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
  /** 地址在日志里（data:）还是资产库里（loomina://） */
  placement: "inline" | "store" | "none";
  /** 日志里那一份的字节数；资产库里的记 0（字节在盘上） */
  inlineBytes: number;
};

export type AssetInventory = {
  total: number;
  /** 还在事件日志里的资产数 */
  inline: number;
  /** 已进本机资产库的资产数 */
  stored: number;
  /** 日志里 base64 的总字节数（迁移之后这个数不会掉，因为旧事件不动） */
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
    .filter((asset) => referenced.has(asset.id) && asset.uri && isStoredAssetUri(asset.uri))
    .map((asset) => asset.uri!);
}
