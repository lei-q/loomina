/**
 * IR 是纯 JSON 数据，深拷贝用序列化即可（不依赖 DOM 的 structuredClone）。
 */
export function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
