/**
 * 逐句表演参数（C2 / C9 / ADR-0124）。
 *
 * 参数只描述「下一次出声怎么念」，不参与任何时长计算——时长以真实音轨为准（P5）。
 * 供应商是否支持其中几项没有验证过，所以这里的文案一律用「请…」而不是「已设成…」。
 */

import type { DialogueLine, VoicePerformance, VoiceTake } from "@loomina/ir";

export const DEFAULT_PERFORMANCE: VoicePerformance = {
  rate: 1,
  pitch: 0,
  volume: 1,
  breathiness: 0,
  emphasis: [],
  pauses: [],
  emotion: "",
  ending: "flat",
};

export const ENDING_LABEL: Record<VoicePerformance["ending"], string> = {
  rise: "上扬",
  flat: "平",
  fall: "下沉",
};

/** 参数与默认值不同才算「改过」：界面据此决定要不要显示摘要 */
export function isDefaultPerformance(performance: VoicePerformance): boolean {
  return (
    performance.rate === 1 &&
    performance.pitch === 0 &&
    performance.volume === 1 &&
    performance.breathiness === 0 &&
    performance.emphasis.length === 0 &&
    performance.pauses.length === 0 &&
    performance.emotion.trim() === "" &&
    performance.ending === "flat"
  );
}

/** 一行摘要：`1.2× · −2 半音 · 气声 30% · 重读 2 处 · 停 1 处 · 下沉` */
export function summarizePerformance(performance: VoicePerformance): string {
  const parts: string[] = [];
  if (performance.rate !== 1) parts.push(`${performance.rate.toFixed(2).replace(/0$/, "")}×`);
  if (performance.pitch !== 0) {
    parts.push(`${performance.pitch > 0 ? "+" : ""}${performance.pitch} 半音`);
  }
  if (performance.volume !== 1) parts.push(`音量 ${Math.round(performance.volume * 100)}%`);
  if (performance.breathiness > 0) {
    parts.push(`气声 ${Math.round(performance.breathiness * 100)}%`);
  }
  if (performance.emphasis.length > 0) parts.push(`重读 ${performance.emphasis.length} 处`);
  if (performance.pauses.length > 0) parts.push(`停 ${performance.pauses.length} 处`);
  if (performance.emotion.trim()) parts.push(performance.emotion.trim());
  if (performance.ending !== "flat") parts.push(ENDING_LABEL[performance.ending]);
  return parts.length > 0 ? parts.join(" · ") : "默认";
}

/**
 * 拼成请求体的 `instructions`（ADR-0124 §4）。
 *
 * 只写「怎么念」，不改字：停顿走标点（见 `inputOf`），重音只说「有 N 处要重读」。
 * 这一版不假设供应商支持 SSML，所以这些是提示而不是指令。
 */
export function instructionsOf(performance: VoicePerformance): string | undefined {
  const parts: string[] = [];
  const emotion = performance.emotion.trim();
  if (emotion) parts.push(`情绪：${emotion}`);
  if (performance.breathiness > 0) {
    parts.push(`气声比例约 ${Math.round(performance.breathiness * 100)}%`);
  }
  if (performance.ending !== "flat") {
    parts.push(`句尾${ENDING_LABEL[performance.ending]}`);
  }
  if (performance.emphasis.length > 0) {
    parts.push(`有 ${performance.emphasis.length} 处需要重读`);
  }
  if (parts.length === 0) return undefined;
  return `按以下方式念这一句：${parts.join("；")}。不要改动文字。`;
}

/** 句读已经在那里时不再重复插标点 */
const PUNCTUATION = /[，。、；：！？…,.;:!?—]/;

/**
 * 真正发给供应商的 `input`（ADR-0124 §4）。
 *
 * 停顿是唯一能靠标点表达的一项：短停（< 600ms）插逗号，长停插省略号。
 * 插入的是标点，不是字——念出来的字一个都没变。从后往前插，下标才不会错位。
 */
export function inputOf(text: string, performance: VoicePerformance): string {
  if (performance.pauses.length === 0) return text;
  const chars = [...text];
  const pauses = [...performance.pauses].sort((a, b) => b.afterChar - a.afterChar);
  for (const pause of pauses) {
    const at = Math.min(chars.length, Math.max(0, pause.afterChar));
    // 句首、句尾、以及后面已经有标点时都不插
    if (at === 0 || at >= chars.length) continue;
    if (PUNCTUATION.test(chars[at - 1] ?? "") || PUNCTUATION.test(chars[at] ?? "")) continue;
    chars.splice(at, 0, pause.ms < 600 ? "，" : "……");
  }
  return chars.join("");
}

/** 这一句的表演参数；没写过就按默认值（不写回 IR） */
export function performanceOf(line: DialogueLine): VoicePerformance {
  return line.performance ?? DEFAULT_PERFORMANCE;
}

/** 这一句在试听台里有几版 */
export function voiceTakesOf(takes: VoiceTake[], lineId: string): VoiceTake[] {
  return takes.filter((take) => take.lineId === lineId);
}

/**
 * 某个区间覆盖了哪些字：重音用字符区间定位，界面要把那一段标出来。
 * 越界（文本改短）时返回空——回放时这些区间已经被丢弃。
 */
export function emphasisText(text: string, start: number, end: number): string {
  return [...text].slice(start, end).join("");
}
