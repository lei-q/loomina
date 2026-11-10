import { CameraSchema, ShotSchema } from "@loomina/ir";
import type { ShotPromptMaterial } from "@loomina/pipeline";

/**
 * 路由入参的公共形状（ADR-0032 / ADR-0083）。
 *
 * 只收业务字段，不收资产 id 与项目结构：服务端据此拼提示词，
 * 拼不出来就回一句人话，不猜。
 */

export function text(value: unknown, max: number): string {
  return typeof value === "string" ? value.slice(0, max) : "";
}

/** 只切掉两侧空白；名字全空就当作没填。 */
export function name(value: unknown): string {
  return text(value, 40).trim();
}

/**
 * 镜头提示词原料：出图与出视频共用同一份解析，
 * 免得两个接口对同一个镜头的理解慢慢分叉。
 */
export function parseShotMaterial(value: unknown): ShotPromptMaterial | string {
  if (!value || typeof value !== "object") return "缺少镜头";
  const shot = value as {
    description?: unknown;
    shotSize?: unknown;
    camera?: { angle?: unknown; movement?: unknown; focalMm?: unknown };
    characters?: unknown;
    location?: { name?: unknown };
    props?: unknown;
  };

  const size = ShotSchema.shape.shotSize.safeParse(shot.shotSize);
  if (!size.success) return "景别不认识";
  const camera = CameraSchema.safeParse(shot.camera);
  if (!camera.success) return "机位参数不认识";

  const characters = Array.isArray(shot.characters)
    ? shot.characters
        .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object")
        .slice(0, 4)
        .map((item) => ({
          name: name(item.name),
          appearance: text(item.appearance, 300),
          mustNotChange: Array.isArray(item.mustNotChange)
            ? item.mustNotChange
                .filter((keep): keep is string => typeof keep === "string")
                .slice(0, 12)
                .map((keep) => keep.slice(0, 40))
            : [],
        }))
        .filter((item) => item.name)
    : [];

  const props = Array.isArray(shot.props)
    ? shot.props
        .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object")
        .slice(0, 6)
        .map((item) => ({
          name: name(item.name),
          description: text(item.description, 300),
        }))
        .filter((item) => item.name)
    : [];

  const where = name(shot.location?.name);
  return {
    description: text(shot.description, 400),
    shotSize: size.data,
    camera: camera.data,
    characters,
    location: where ? { name: where } : undefined,
    props,
  };
}
