import { NextResponse } from "next/server";
import { activeStore, activeStorage } from "@/lib/storage-runtime";

/**
 * 资产库清单（F4）。
 *
 * 回「库里有哪些文件、各多大」，页面据此算出文件缺失与体积。
 * 只列本机库或对象存储里**当前生效**的那一处——配了对象存储就以它为准，
 * 本机库里剩下的旧文件不混进来，免得同一个地址算两次。
 */
export const runtime = "nodejs";
export const maxDuration = 60;

export async function GET() {
  try {
    const [store, storage] = await Promise.all([activeStore(), activeStorage()]);
    const files = await store.list();
    return NextResponse.json(
      {
        placement: storage.config ? "remote" : "store",
        files: files.map((file) => ({ uri: file.uri, bytes: file.bytes })),
        bytes: files.reduce((sum, file) => sum + file.bytes, 0),
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "读不到资产库清单",
        files: [],
        bytes: 0,
      },
      { status: 500 },
    );
  }
}
