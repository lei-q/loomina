/**
 * 场号连续性（A21 / ADR-0134）。
 *
 * 场号有两种来源（ADR-0080）：
 * - **显式场号**（`2A`）是这一场戏的**名字**，挪位时跟着场走；
 * - 没写场号的场按**位置**显示顺序号。
 *
 * 两者混在一起时，拖动之后标题会看起来「不连续」：把第 2A 场拖到最前面，
 * 页面上依次写着「第 2A 场」「第 1 场」「第 3 场」。这不是 bug——名字跟着戏走
 * 是对的——但页面上没有任何一句话解释它，作者会以为排序坏了。
 *
 * 这里只做**说明**，不改场号：按位置重新编号会把作者写的「2A」凭空改掉，
 * 那比看起来不连续更糟（ADR-0080）。
 */

export type NumberedScene = {
  id: string;
  /** 显式场号；空串表示按位置编号 */
  code: string;
  /** 界面上显示的场号 */
  label: string;
  /** 位置，从 1 开始 */
  no: number;
};

export type SceneNumbering = {
  /** 有显式场号的场数 */
  explicit: number;
  /** 场号里的数字与它现在的位置对不上的场 */
  outOfOrder: { id: string; label: string; no: number }[];
  /** 给页面用的一句话；没有对不上的场时没有 */
  hint?: string;
};

/** 场号开头的数字：`2A` → 2，`12` → 12，`A` → 没有数字 */
function leadingNumber(code: string): number | undefined {
  const match = /^\d+/.exec(code);
  if (!match) return undefined;
  const value = Number(match[0]);
  return Number.isFinite(value) ? value : undefined;
}

/**
 * 只看「有数字的显式场号」：`2A` 在第 1 位就是错位，`A` 在第 3 位不是——
 * 那是纯名字，没有位置含义，拿它比位置是无意义的。
 */
export function sceneNumberingOf(scenes: NumberedScene[]): SceneNumbering {
  const explicit = scenes.filter((scene) => scene.code !== "").length;
  const outOfOrder = scenes
    .map((scene) => {
      if (scene.code === "") return undefined;
      const number = leadingNumber(scene.code);
      if (number === undefined || number === scene.no) return undefined;
      return { id: scene.id, label: scene.label, no: scene.no };
    })
    .filter((item): item is { id: string; label: string; no: number } => Boolean(item));

  if (outOfOrder.length === 0) {
    return { explicit, outOfOrder };
  }

  const listed = outOfOrder
    .slice(0, 3)
    .map((item) => `「第 ${item.label} 场」排在第 ${item.no} 位`)
    .join("、");
  const more = outOfOrder.length > 3 ? ` 等 ${outOfOrder.length} 场` : "";
  return {
    explicit,
    outOfOrder,
    hint: `场号跟着场走：${listed}${more}。没写场号的场按位置显示顺序号，所以编号和位置可以不一致；想让它们对齐，把场号清空就回到按位置编号。`,
  };
}
