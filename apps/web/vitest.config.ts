import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    // 与 tsconfig 的 "@/*" 对齐，测试里才能按应用内的写法 import
    alias: {
      "@": fileURLToPath(new URL("./", import.meta.url)),
    },
  },
});
