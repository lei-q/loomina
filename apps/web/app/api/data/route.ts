import { NextResponse } from "next/server";
import { assetStore, assetStoreDir } from "@/lib/asset-store";
import { activeStorage } from "@/lib/storage-runtime";

/**
 * 删除本机上的用户数据（H9）。
 *
 * 只动两样东西：`<项目>/.loomina/assets/` 里的素材文件，以及调用方随后自己清掉的
 * 浏览器项目日志。**不碰**：`.loomina/config.json`（你的密钥与供应商配置）、
 * 对象存储里的东西、你导出到别处的文件。
 *
 * 配了对象存储时直接拒绝——桶可能是多台机器、甚至别的人一起用的，
 * 这个按钮不该有「顺手把桶清空」的能力。
 */
export const runtime = "nodejs";
export const maxDuration = 60;

export async function DELETE(request: Request) {
  const body = (await request.json().catch(() => ({}))) as { confirm?: unknown };
  if (body.confirm !== "删除") {
    return NextResponse.json(
      { error: "要在确认框里输入「删除」两个字，才会真的删。" },
      { status: 400 },
    );
  }

  const storage = await activeStorage();
  if (storage.config) {
    return NextResponse.json(
      {
        error:
          "已经配了对象存储：本机删除只清 .loomina/assets/，不碰你的桶。素材请在对象存储那边删。",
        placement: "remote",
      },
      { status: 409 },
    );
  }

  const store = assetStore();
  const files = await store.list();
  let removed = 0;
  let bytes = 0;
  const failed: string[] = [];
  for (const file of files) {
    if (await store.remove(file.uri)) {
      removed += 1;
      bytes += file.bytes;
    } else {
      failed.push(file.uri);
    }
  }

  return NextResponse.json(
    {
      placement: "store",
      dir: assetStoreDir(),
      removed,
      bytes,
      failed: failed.length,
      /** 删完之后还剩下什么，界面照实说 */
      note:
        removed === 0 && files.length === 0
          ? "本机资产库里本来就没有文件。"
          : `删掉 ${removed} 个文件、${bytes} 字节。${
              failed.length > 0 ? `有 ${failed.length} 个没删掉（可能没权限）。` : ""
            }`,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
