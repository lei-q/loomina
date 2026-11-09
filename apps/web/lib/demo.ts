export type SceneKind = "door" | "two" | "table" | "corridor";

export type ShotState = "open" | "pick" | "reject";

export type Shot = {
  /** 镜号，显示为 SH-01 */
  no: number;
  scene: SceneKind;
  /** 这一格的动作，写在胶片格的悬停提示与中台标题上 */
  action: string;
  /** 时长，秒 */
  dur: number;
  state: ShotState;
};

export type Project = {
  id: string;
  title: string;
  version: number;
  /** 已花 / 预算，单位元 */
  spent: number;
  budget: number;
  current: number;
  shots: Shot[];
  /** 当前这一格的重做报价 */
  requote: number;
  /** 烧在画面里的字幕 */
  subtitle: string;
};

/**
 * 示例项目：用来把骨架撑满，不是真实数据。
 * 换成真实 IR 时，这个对象的结构就是 Project IR 的读模型。
 */
export const demo: Project = {
  id: "demo-night-shift",
  title: "夜班",
  version: 3,
  spent: 18.96,
  budget: 60,
  current: 2,
  requote: 2.12,
  subtitle: "你早就知道，对吧。",
  shots: [
    { no: 1, scene: "corridor", action: "走廊尽头，灯管闪了一下", dur: 3.1, state: "reject" },
    { no: 2, scene: "door", action: "门缝里透出一条光", dur: 2.4, state: "pick" },
    { no: 3, scene: "door", action: "她把杯子放下，没抬头", dur: 2.4, state: "open" },
    { no: 4, scene: "two", action: "两个人隔着桌子，谁也没动", dur: 3.8, state: "open" },
    { no: 5, scene: "table", action: "他伸手关掉了台灯", dur: 1.9, state: "pick" },
    { no: 6, scene: "corridor", action: "走廊空了，灯还亮着", dur: 4.2, state: "open" },
    { no: 7, scene: "door", action: "门被从外面带上", dur: 2.0, state: "open" },
    { no: 8, scene: "two", action: "她终于抬头", dur: 2.6, state: "pick" },
    { no: 9, scene: "table", action: "杯子还在原来的位置", dur: 3.0, state: "open" },
    { no: 10, scene: "corridor", action: "灯管灭了", dur: 1.6, state: "reject" },
    { no: 11, scene: "door", action: "锁扣轻轻响了一声", dur: 2.2, state: "open" },
    { no: 12, scene: "two", action: "两个人影重叠在一起", dur: 3.4, state: "open" },
  ],
};

export const stages = ["故事", "剧本", "分镜", "关键帧", "声音", "成片"] as const;

export const currentStage = "分镜";

export function shotLabel(no: number): string {
  return `SH-${String(no).padStart(2, "0")}`;
}
