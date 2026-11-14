import { rebuild, type Asset, type Project } from "@loomina/ir";
import { assetUsageLabels } from "@/lib/asset-inventory";
import { hasWorkspaces, indexedDbLogFor, listWorkspaces, migrateLog } from "@/lib/event-log";

/**
 * 跨工作空间取素材（C4 / ADR-0189）。
 *
 * 素材文件本来就全机共用（内容寻址，一份字节只存一次），缺的是「别的空间里
 * 用过什么、拿得过来吗」。这里把各空间的日志读出来、按地址去重，给挑图界面
 * 一份清单；选中之后只把**资产记录**复制进当前项目，地址不变、不重新生成、不花钱。
 *
 * 读日志是显式动作（打开挑图面板才跑），不在正常编辑路径上。
 */

export type WorkspaceProject = {
  id: string;
  name: string;
  project: Project;
};

export type SharedAsset = {
  /** 文件地址：loomina:// / s3:// / data: / http(s) */
  uri: string;
  kind: Asset["kind"];
  /** 原件怎么来的：生成过的取过来记 `library`，上传的仍记上传（C1 / ADR-0190） */
  source: Asset["source"];
  /** 第一次见到它的工作空间（同一份字节可能被多个空间用过） */
  workspaceId: string;
  workspaceName: string;
  /** 在那个空间里用在哪：定妆 / 参考图 / 首帧…… */
  usedBy: string[];
  createdAt: string;
};

/**
 * 跨空间资产清单（纯函数）。
 *
 * 按地址去重：同一个文件在五个空间里被引用，只出现一次，使用处合并。
 * 默认只列图片——挑图面板目前只服务参考图。
 */
export function sharedAssetsOf(
  spaces: WorkspaceProject[],
  kinds: Asset["kind"][] = ["image"],
): SharedAsset[] {
  const seen = new Map<string, SharedAsset>();
  for (const space of spaces) {
    const labels = assetUsageLabels(space.project);
    for (const asset of space.project.assets) {
      if (!asset.uri || !kinds.includes(asset.kind)) continue;
      const existing = seen.get(asset.uri);
      const usage = labels.get(asset.id) ?? [];
      if (existing) {
        for (const label of usage) {
          if (!existing.usedBy.includes(label)) existing.usedBy.push(label);
        }
        continue;
      }
      seen.set(asset.uri, {
        uri: asset.uri,
        kind: asset.kind,
        source: asset.source,
        workspaceId: space.id,
        workspaceName: space.name,
        usedBy: [...usage],
        createdAt: asset.createdAt,
      });
    }
  }
  return [...seen.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** 读出本机所有能回放的工作空间；某一份日志坏了只跳过它 */
export async function loadWorkspaceProjects(): Promise<WorkspaceProject[]> {
  if (!hasWorkspaces()) return [];
  // 归档的空间不进复用清单（C15 / ADR-0210）：收起来就是不想它再出现在「从别的空间取」
  const metas = (await listWorkspaces()).filter((meta) => !meta.archivedAt);
  const spaces: WorkspaceProject[] = [];
  for (const meta of metas) {
    try {
      const stored = migrateLog(await indexedDbLogFor(meta.id).load());
      if (!stored) continue;
      spaces.push({ id: meta.id, name: meta.name, project: rebuild(stored) });
    } catch {
      // 一份日志读不出来，不该让别的空间也挑不了图
    }
  }
  return spaces;
}
