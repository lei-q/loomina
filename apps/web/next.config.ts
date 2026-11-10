import type { NextConfig } from "next";

const config: NextConfig = {
  reactStrictMode: true,
  // IR 包直接导出 TS 源码，交给 Next 编译
  transpilePackages: ["@loomina/ir", "@loomina/gateway"],
};

export default config;
