import { NextResponse } from "next/server";
import { loadConfig } from "@/lib/app-config";
import { buildCapabilityResponse } from "@/lib/capabilities";
import { readProbeReports } from "@/lib/probes";

/**
 * 模型能力矩阵 + S1 测绘报告（B12 / H16）。
 *
 * 只读：从已保存的配置生成矩阵，再附上最近的 `artifacts/s1/probe-*.json`。
 * 不返回供应商密钥、Base URL 或逐镜原始报错；这份数据只用于诊断，
 * 不参与网关路由或降级。
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const loaded = await loadConfig();
    const probes = await readProbeReports();
    return NextResponse.json(
      buildCapabilityResponse(
        {
          providers: loaded.config.providers.map((provider) => ({
            id: provider.id,
            name: provider.name,
          })),
          models: loaded.config.models,
          defaults: loaded.config.defaults,
          saved: loaded.saved,
          path: loaded.path,
        },
        probes,
      ),
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "读不到能力矩阵";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
