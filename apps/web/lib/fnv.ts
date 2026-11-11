/**
 * FNV-1a 32 位指纹。
 *
 * 用途只有一个：判断「确认之后内容有没有改过」。
 * 它不是安全哈希，也不承担防篡改——只要求同一份内容总得到同一个 8 位十六进制，
 * 内容变了指纹就变。导出预检与阶段闸门共用同一个实现。
 */
export function fnv1a(input: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}
