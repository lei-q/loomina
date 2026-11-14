/**
 * 授权留档（H7 / ADR-0167）。
 *
 * 短剧里最常见的两类麻烦是「这张脸是谁的」与「这段声音是谁的」。
 * 这里不校验合同真伪——合同在作者手里；工具只做三件事：
 *
 * 1. 把肖像 / 声音 / 素材 / 音乐四类授权按对象记下来；
 * 2. 指出**还缺哪一条**（角色没肖像授权、上传素材没授权、配音没声音授权）；
 * 3. 指出**哪一条过期了**（到期日早于今天）。
 *
 * 全部派生，不写 IR；缺与过期只在合规预检里提示，不拦生成。
 */

import type { Project, RightsRecord } from "@loomina/ir";

export const RIGHTS_KIND_LABEL: Record<RightsRecord["kind"], string> = {
  portrait: "肖像",
  voice: "声音",
  asset: "素材",
  music: "音乐",
  other: "其他",
};

/** 一条授权是不是已经过期（到期日为空表示不限期） */
export function isExpired(record: RightsRecord, today: string): boolean {
  const expiry = record.expiresAt.trim();
  if (!expiry) return false;
  // 只比日期部分：`2026-11-13` 与 `2026-11-13T00:00:00Z` 视为同一天到期
  return expiry.slice(0, 10) < today.slice(0, 10);
}

export type RightsGap = {
  kind: RightsRecord["kind"];
  /** 缺谁：角色名 / 素材名 */
  subject: string;
  /** 关联的对象 id */
  targetId?: string;
  /** 为什么判它缺 */
  reason: string;
};

export type RightsReport = {
  /** 缺的授权 */
  gaps: RightsGap[];
  /** 过期的授权 */
  expired: RightsRecord[];
  /** 有效的授权条数 */
  valid: number;
  /** 全部记录 */
  total: number;
  /** 一句话结论 */
  verdict: string;
};

/**
 * 授权体检。
 *
 * 判定口径（宁可少报，也不把「作者没打算用真脸」当成缺授权）：
 * - 角色有定妆三视图且**有真人素材**（上传 / 导入的参考图）时，才要求肖像授权；
 * - 上传 / 导入的素材要求一条素材授权；
 * - 声音不自动判缺：`voiceProfileId` 只写了个音色名，分不出是平台自带还是克隆音色。
 *   克隆音色要自己记一条声音授权，界面里说清楚；
 * - 音乐 cue 的授权走 `licenseRef`，不在这里重复要求。
 */
export function rightsReport(project: Project, today: string): RightsReport {
  const records = project.authorizations;
  const active = records.filter((record) => !isExpired(record, today));
  const expired = records.filter((record) => isExpired(record, today));

  const has = (kind: RightsRecord["kind"], targetId: string | undefined) =>
    active.some((record) => record.kind === kind && (!targetId || record.targetId === targetId));

  const uploadIds = new Set(
    project.assets
      .filter((asset) => asset.source === "upload" || asset.source === "imported")
      .map((asset) => asset.id),
  );

  const gaps: RightsGap[] = [];
  for (const character of project.characters) {
    // 参考图里只要有一张是上传的，就说明这张脸有真实来源
    const hasUploadedReference = character.referenceImages.some((id) => uploadIds.has(id));
    const sheetAssets = Object.values(character.sheet).filter(
      (id): id is string => typeof id === "string",
    );
    const hasUploadedSheet = sheetAssets.some((id) => uploadIds.has(id));
    if ((hasUploadedReference || hasUploadedSheet) && !has("portrait", character.id)) {
      gaps.push({
        kind: "portrait",
        subject: character.name,
        targetId: character.id,
        reason: "用了上传的真人参考图，但没有肖像授权记录",
      });
    }
  }

  const uploaded = project.assets.filter(
    (asset) => asset.source === "upload" || asset.source === "imported",
  );
  if (uploaded.length > 0 && !has("asset", undefined)) {
    gaps.push({
      kind: "asset",
      subject: "上传素材",
      reason: `共 ${uploaded.length} 个，没有授权记录`,
    });
  }

  const verdict =
    gaps.length === 0 && expired.length === 0
      ? records.length > 0
        ? `${records.length} 条授权记录，都还在有效期。`
        : "没有需要授权的真人素材。"
      : [
          gaps.length > 0 ? `缺 ${gaps.length} 条授权` : "",
          expired.length > 0 ? `${expired.length} 条已过期` : "",
        ]
          .filter(Boolean)
          .join("，") + "。";

  return {
    gaps,
    expired,
    valid: active.length,
    total: records.length,
    verdict,
  };
}

/** 从项目里挑出可以挂授权的对象：角色 / 道具 / 地点 */
export function rightsTargets(project: Project): { id: string; label: string; kind: RightsRecord["kind"] }[] {
  const targets: { id: string; label: string; kind: RightsRecord["kind"] }[] = [];
  for (const character of project.characters) {
    targets.push({ id: character.id, label: `角色 · ${character.name}`, kind: "portrait" });
  }
  for (const prop of project.props) {
    targets.push({ id: prop.id, label: `道具 · ${prop.name}`, kind: "asset" });
  }
  for (const location of project.locations) {
    targets.push({ id: location.id, label: `地点 · ${location.name}`, kind: "asset" });
  }
  return targets;
}
