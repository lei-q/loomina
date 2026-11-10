import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  ConfigError,
  TreecloudClient,
  TreecloudError,
  TreecloudImageAdapter,
  TreecloudVideoAdapter,
  describeEnv,
  imageCostCny,
  loadEnvFile,
  treecloudEnvFrom,
  videoCostCny,
} from "@loomina/gateway";
import { ProjectSchema, type Project, type Shot } from "@loomina/ir";
import { runShot } from "../index";

/**
 * S1 能力测绘（docs/COST.md 的“三件事”）。
 *
 *   1. 真实单价——按实际时长与分辨率结算
 *   2. 首次通过率——失败就是失败，不重试，重试的是另一回事
 *   3. 失败维度——把错误码归类，才知道该改提示词还是改镜头设计
 *
 * 用法：
 *   pnpm probe:s1 -- --dry-run
 *   pnpm probe:s1 -- --shots 8 --resolution 768p --budget 30
 */

interface Args {
  envPath: string;
  shots: number;
  budgetCny: number;
  resolution?: string;
  imageSize: string;
  outDir: string;
  dryRun: boolean;
  textOnly: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    envPath: "secrity.env",
    shots: 8,
    budgetCny: 30,
    imageSize: "1024x1536",
    outDir: "artifacts/s1",
    dryRun: false,
    textOnly: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    const value = argv[i + 1];
    if (key === "--") continue;
    switch (key) {
      case "--env":
        args.envPath = required(key, value);
        i += 1;
        break;
      case "--shots":
        args.shots = Number(required(key, value));
        i += 1;
        break;
      case "--budget":
        args.budgetCny = Number(required(key, value));
        i += 1;
        break;
      case "--resolution":
        args.resolution = required(key, value);
        i += 1;
        break;
      case "--image-size":
        args.imageSize = required(key, value);
        i += 1;
        break;
      case "--out":
        args.outDir = required(key, value);
        i += 1;
        break;
      case "--dry-run":
        args.dryRun = true;
        break;
      case "--text-only":
        args.textOnly = true;
        break;
      default:
        if (key?.startsWith("--")) throw new Error(`未知参数 ${key}`);
    }
  }

  return args;
}

function required(flag: string, value: string | undefined): string {
  if (!value || value.startsWith("--")) throw new Error(`${flag} 需要一个值`);
  return value;
}

/**
 * 首批镜头银行：覆盖“特写 / 中景 / 全景”和“固定 / 推 / 手持”，
 * 都是竖屏短剧里最常出现的调度，不是随机审美。
 */
const SHOT_BANK: Array<Omit<Shot, "id" | "sceneId" | "index" | "takeIds">> = [
  {
    durationMs: 4000,
    description: "电梯门关闭前，短发女人抬头看向镜头外，眼神从疲惫转为警觉，米色风衣领口微湿",
    shotSize: "close",
    camera: { angle: "eye", movement: "static", focalMm: 85 },
    characterIds: ["c-lin"],
    dialogueIds: [],
    locked: false,
  },
  {
    durationMs: 4000,
    description: "男人从画面右侧伸手挡住正在关闭的电梯门，深色大衣下摆被风吹起，逆光",
    shotSize: "medium",
    camera: { angle: "low", movement: "push", focalMm: 50 },
    characterIds: ["c-zhou"],
    dialogueIds: [],
    locked: false,
  },
  {
    durationMs: 5000,
    description: "雨夜霓虹街口全景，积水倒映招牌，行人撑伞匆匆穿过画面，湿冷",
    shotSize: "wide",
    camera: { angle: "high", movement: "static", focalMm: 24 },
    characterIds: [],
    dialogueIds: [],
    locked: false,
  },
  {
    durationMs: 4000,
    description: "大特写：女人的手指慢慢松开一枚素圈戒指，戒指落在桌面上轻轻一转",
    shotSize: "extreme-close",
    camera: { angle: "eye", movement: "static", focalMm: 100 },
    characterIds: ["c-lin"],
    dialogueIds: [],
    locked: false,
  },
  {
    durationMs: 5000,
    description: "两人隔着餐桌对视，谁也不说话，窗外车灯扫过墙面",
    shotSize: "medium",
    camera: { angle: "eye", movement: "handheld", focalMm: 35 },
    characterIds: ["c-lin", "c-zhou"],
    dialogueIds: [],
    locked: false,
  },
  {
    durationMs: 4000,
    description: "男人把一份合同推到桌面中央，手指在纸边停住，抬头看向对面",
    shotSize: "close",
    camera: { angle: "low", movement: "push", focalMm: 85 },
    characterIds: ["c-zhou"],
    dialogueIds: [],
    locked: false,
  },
  {
    durationMs: 5000,
    description: "办公室玻璃墙后，人群低声交谈，镜头缓慢横移，把角落里的女人留在画面边缘",
    shotSize: "wide",
    camera: { angle: "eye", movement: "pan", focalMm: 35 },
    characterIds: ["c-lin"],
    dialogueIds: [],
    locked: false,
  },
  {
    durationMs: 5000,
    description: "空会议室俯拍，女人独自坐在长桌一端，桌上只有一杯凉掉的咖啡",
    shotSize: "medium",
    camera: { angle: "high", movement: "static", focalMm: 50 },
    characterIds: ["c-lin"],
    dialogueIds: [],
    locked: false,
  },
];

function buildProject(count: number): Project {
  const shots = Array.from({ length: count }, (_, index) => {
    const template = SHOT_BANK[index % SHOT_BANK.length]!;
    return { ...template, id: `probe-sh-${index + 1}`, sceneId: "probe-sc-1", index };
  });

  // 测绘也要走锚点：探针人物配一套占位三视图，免得链路因为"缺锚点"拒绝。
  const asset = (id: string) => ({
    id,
    kind: "image" as const,
    source: "generated" as const,
    createdAt: "2026-11-09T10:00:00Z",
  });
  const sheets = (prefix: string) => ({
    front: `probe-a-${prefix}-front`,
    threeQuarter: `probe-a-${prefix}-34`,
    side: `probe-a-${prefix}-side`,
    back: `probe-a-${prefix}-back`,
  });

  return ProjectSchema.parse({
    id: "proj-s1-probe",
    title: "S1 能力测绘",
    version: 1,
    locations: [{ id: "probe-loc-1", name: "都市内景", masterShotId: "probe-a-loc-master" }],
    characters: [
      {
        id: "c-lin",
        name: "林晚",
        appearance: "三十岁，短发，米色风衣",
        sheet: sheets("lin"),
      },
      {
        id: "c-zhou",
        name: "周野",
        appearance: "三十五岁，深色大衣",
        sheet: sheets("zhou"),
      },
    ],
    assets: [
      ...Object.values(sheets("lin")).map(asset),
      ...Object.values(sheets("zhou")).map(asset),
      asset("probe-a-loc-master"),
    ],
    scenes: [{ id: "probe-sc-1", index: 0, locationId: "probe-loc-1", shotIds: shots.map((s) => s.id) }],
    shots,
    dialogue: [],
    takes: [],
    timeline: { items: [] },
    publishPackages: [],
  });
}

interface ShotError {
  code: string;
  status?: number;
  message: string;
}

interface ShotReport {
  shotId: string;
  ok: boolean;
  ms: number;
  costCny?: number;
  imageUri?: string;
  videoUri?: string;
  error?: ShotError;
}

function classify(error: unknown): ShotError {
  if (error instanceof TreecloudError) {
    return { code: error.code, status: error.status, message: error.message.slice(0, 300) };
  }
  if (error instanceof Error) {
    return { code: "client_error", message: error.message.slice(0, 300) };
  }
  return { code: "unknown", message: String(error).slice(0, 300) };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const envPath = resolve(process.cwd(), args.envPath);
  if (!existsSync(envPath)) {
    throw new ConfigError(`找不到 env 文件：${args.envPath}`);
  }

  const env = treecloudEnvFrom(loadEnvFile(envPath));
  const resolution = args.resolution ?? env.videoResolution ?? "768p";

  console.log(`env: ${describeEnv(env)}`);
  console.log(
    `plan: ${args.shots} 个镜头, resolution=${resolution}, imageSize=${args.imageSize}, budget=¥${args.budgetCny}`,
  );

  const project = buildProject(args.shots);
  const planned = project.shots.reduce((sum, shot) => {
    const image = args.textOnly ? 0 : (imageCostCny(env.imageModel) ?? 0);
    const video = videoCostCny(env.videoModel, resolution, shot.durationMs);
    return sum + image + (video ?? 0);
  }, 0);

  if (videoCostCny(env.videoModel, resolution, 1000) === undefined) {
    console.log(
      `注意：${env.videoModel} @ ${resolution} 不在价目表里，无法预估；按“未知成本”处理。`,
    );
  } else {
    console.log(`预估成本：¥${planned.toFixed(2)}`);
    if (planned > args.budgetCny) {
      throw new Error(
        `预估 ¥${planned.toFixed(2)} 超过预算 ¥${args.budgetCny}，已中止。调小 --shots 或提高 --budget。`,
      );
    }
  }

  if (args.dryRun) {
    for (const shot of project.shots) {
      console.log(`  ${shot.id}  ${shot.shotSize.padEnd(13)} ${shot.durationMs}ms  ${shot.description}`);
    }
    console.log("dry-run：未调用任何模型。");
    return;
  }

  const client = new TreecloudClient({
    ...env,
    timeoutMs: 150_000,
    onAttempt: (info) => console.log(`  · ${info}`),
  });
  const image = new TreecloudImageAdapter(client, { size: args.imageSize });
  const video = new TreecloudVideoAdapter(client, { resolution });
  const uploadedVideoPerSecond = videoCostCny(env.videoModel, resolution, 1000) ?? 0;

  const reports: ShotReport[] = [];
  let spent = 0;

  for (const shot of project.shots) {
    if (spent > args.budgetCny) {
      console.log(`已花 ¥${spent.toFixed(2)}，超过预算，停止。`);
      break;
    }

    const started = Date.now();
    try {
      const result = await runShot(project, shot, {
        image,
        video,
        textOnly: args.textOnly,
        imageSize: args.imageSize,
        videoResolution: resolution,
        prices: {
          imageCny: imageCostCny(env.imageModel) ?? 0,
          videoPerSecondCny: uploadedVideoPerSecond,
        },
      });
      const ms = Date.now() - started;
      spent += result.costCny;
      reports.push({
        shotId: shot.id,
        ok: true,
        ms,
        costCny: result.costCny,
        imageUri: result.imageUri,
        videoUri: result.videoUri,
      });
      console.log(`✓ ${shot.id}  ${(ms / 1000).toFixed(1)}s  ¥${result.costCny.toFixed(2)}`);
    } catch (error) {
      const ms = Date.now() - started;
      const info = classify(error);
      reports.push({ shotId: shot.id, ok: false, ms, error: info });
      console.log(`✗ ${shot.id}  ${(ms / 1000).toFixed(1)}s  [${info.code}] ${info.message}`);
    }
  }

  const passed = reports.filter((r) => r.ok).length;
  const summary = {
    attempts: reports.length,
    passed,
    passRate: reports.length ? Math.round((passed / reports.length) * 1000) / 1000 : 0,
    totalCny: Math.round(spent * 100) / 100,
    avgCnyPerShot: passed ? Math.round((spent / passed) * 100) / 100 : undefined,
    failureCodes: countBy(reports.filter((r) => !r.ok).map((r) => r.error?.code ?? "unknown")),
  };

  const report = {
    startedAt: new Date().toISOString(),
    config: {
      baseUrl: env.baseUrl,
      videoModel: env.videoModel,
      imageModel: env.imageModel,
      videoApi: video.activeApi,
      resolution,
      imageSize: args.imageSize,
    },
    summary,
    shots: reports,
  };

  const outPath = resolve(
    process.cwd(),
    args.outDir,
    `probe-${new Date().toISOString().replace(/[:.]/g, "-")}.json`,
  );
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(report, null, 2), "utf8");

  console.log("--- 汇总 ---");
  console.log(
    `通过 ${summary.passed}/${summary.attempts}（${(summary.passRate * 100).toFixed(1)}%），花费 ¥${summary.totalCny}`,
  );
  if (Object.keys(summary.failureCodes).length) {
    console.log(`失败分布：${JSON.stringify(summary.failureCodes)}`);
  }
  console.log(`报告：${outPath}`);
}

function countBy(values: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const value of values) out[value] = (out[value] ?? 0) + 1;
  return out;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
