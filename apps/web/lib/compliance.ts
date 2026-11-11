/**
 * 内容安全与合规预检（H6 / G8，ADR-0095）。
 *
 * 两道防线都落在同一套规则上：
 * 1. 成片页导出前跑 `preflightProject`，有阻断项就禁用所有导出；
 * 2. 渲染路由收到清单后再扫一遍标题与占位文案，不信任「客户端说检查过了」。
 *
 * 这里是规则扫描，不是审核服务：它只负责把明显不该过的文案拦住、
 * 把需要人确认的标出来。真正的模型审核、授权核验与人工复审仍在 H6/H7 里。
 */

import type { Project } from "@loomina/ir";

export type ComplianceSeverity = "block" | "review";
export type ComplianceCategory =
  | "涉政"
  | "涉黄"
  | "暴力"
  | "低俗"
  | "歧视"
  | "未成年人"
  | "拜金炫富"
  | "封建迷信"
  | "诱导消费"
  | "违法"
  | "其他";

export type ComplianceFinding = {
  severity: ComplianceSeverity;
  category: ComplianceCategory;
  /** 命中哪条规则；同一段文本同一条规则只报一次 */
  ruleId: string;
  /** 人话位置：`第 3 镜 · 描述`、`台词 · 林昭` */
  path: string;
  /** 命中的词 */
  term: string;
  /** 命中词前后各 14 字，便于在页面里认出来 */
  excerpt: string;
  message: string;
};

export type ComplianceCheck = {
  id: "ai-label" | "safety" | "rights" | "spec";
  label: string;
  status: "pass" | "review" | "block";
  detail: string;
};

export type ComplianceReport = {
  /** 没有阻断项；review 仍可能 > 0，导出需要用户确认 */
  ok: boolean;
  blocked: number;
  review: number;
  checks: ComplianceCheck[];
  findings: ComplianceFinding[];
  /** findings + 检查结果的短指纹；改了文案或确认状态就会变 */
  signature: string;
  checkedAt: string;
};

type Rule = {
  id: string;
  severity: ComplianceSeverity;
  category: ComplianceCategory;
  /** 正则源码；每次扫描重新编译，避免 g 标志带来的 lastIndex 状态 */
  source: string;
  message: string;
};

/**
 * 规则按「宁可标出来让人看一眼，也不放过」写：
 * 性暴力、危害国家安全、未成年人色情、制毒贩毒是硬阻断；
 * 剧情里的暴力、粗口、迷信、炫富与导流只标 review，由作者确认。
 */
const RULES: Rule[] = [
  {
    id: "politics-overthrow",
    severity: "block",
    category: "涉政",
    source: "(?:颠覆|推翻|瓦解).{0,8}(?:国家政权|政权|政府)",
    message: "涉及危害国家安全的表述，不能导出。",
  },
  {
    id: "politics-split",
    severity: "block",
    category: "涉政",
    source: "(?:分裂国家|煽动分裂|民族仇恨|疆独|藏独|港独|台独)",
    message: "涉及分裂国家或民族仇恨，不能导出。",
  },
  {
    id: "terror",
    severity: "block",
    category: "暴力",
    source: "(?:恐怖袭击|制造(?:炸弹|爆炸物)|爆炸袭击|自制炸药)",
    message: "涉及恐怖袭击或制作爆炸物，不能导出。",
  },
  {
    id: "minor-sex",
    severity: "block",
    category: "未成年人",
    source: "(?:未成年|儿童|幼女|幼童|萝莉|正太).{0,8}(?:色情|性行为|性侵|裸照|猥亵)",
    message: "涉及未成年人的性内容，不能导出。",
  },
  {
    id: "sexual-violence",
    severity: "block",
    category: "涉黄",
    source: "(?:强奸|轮奸|猥亵)",
    message: "含性暴力描写，不能导出；改成暗示或删掉这一句。",
  },
  {
    id: "drugs",
    severity: "block",
    category: "违法",
    source: "(?:制毒|贩毒|毒品交易|吸毒教程|制作毒品)",
    message: "涉及制毒贩毒，不能导出。",
  },
  {
    id: "self-harm",
    severity: "review",
    category: "暴力",
    source: "(?:自杀|自残|割腕|跳楼)",
    message: "含自伤情节：确认没有美化或教学细节。",
  },
  {
    id: "gore",
    severity: "review",
    category: "暴力",
    source: "(?:肢解|碎尸|虐杀|开膛|剥皮)",
    message: "含血腥细节：确认画面与台词没有过度展示。",
  },
  {
    id: "kill",
    severity: "review",
    category: "暴力",
    source: "(?:杀人|枪杀|捅死|毒死|灭口|勒死)",
    message: "含杀人情节：确认这是剧情需要，且没有可模仿的细节。",
  },
  {
    id: "sexual",
    severity: "review",
    category: "涉黄",
    source: "(?:裸体|裸照|情色|色情|床戏|脱衣)",
    message: "含性暗示或裸露：确认没有露骨描写。",
  },
  {
    id: "vulgar",
    severity: "review",
    category: "低俗",
    source: "(?:傻逼|操你|贱人|婊子|去死)",
    message: "含侮辱性粗口：平台可能限流，考虑改词。",
  },
  {
    id: "discrimination",
    severity: "review",
    category: "歧视",
    source: "(?:劣等民族|低等人种|娘炮|死胖子|残废|智障)",
    message: "含歧视性称呼：换成不指向群体的说法。",
  },
  {
    id: "minor-romance",
    severity: "review",
    category: "未成年人",
    source: "(?:未成年|萝莉|正太).{0,8}(?:恋爱|亲吻|同居|诱惑)",
    message: "涉及未成年人的亲密关系：确认没有性化处理。",
  },
  {
    id: "wealth",
    severity: "review",
    category: "拜金炫富",
    source: "(?:一夜暴富|躺赚|稳赚不赔|包赚不赔|炫富|月入百万)",
    message: "含拜金或收益承诺：确认没有不实承诺。",
  },
  {
    id: "superstition",
    severity: "review",
    category: "封建迷信",
    source: "(?:算命|改命|转运|风水大师|法事|驱邪|开光)",
    message: "含迷信情节：确认只作为剧情元素，没有宣扬。",
  },
  {
    id: "inducement",
    severity: "review",
    category: "诱导消费",
    source: "(?:加微信|私信领|扫码领|返利|投资群|内部渠道|点击链接)",
    message: "含导流或消费诱导：平台大概率限流，建议删掉。",
  },
  {
    id: "vice",
    severity: "review",
    category: "其他",
    source: "(?:抽烟|酗酒|赌博|赌场)",
    message: "含烟酒赌博画面或台词：确认没有劝诱或美化。",
  },
];

export const COMPLIANCE_RULE_COUNT = RULES.length;

/** 一段文本按所有规则扫一遍；每条规则只报第一次命中。 */
export function scanText(text: string, path: string): ComplianceFinding[] {
  const findings: ComplianceFinding[] = [];
  for (const rule of RULES) {
    const pattern = new RegExp(rule.source, "g");
    const match = pattern.exec(text);
    if (!match || match.index === undefined) continue;
    const start = Math.max(0, match.index - 14);
    const end = Math.min(text.length, match.index + match[0].length + 14);
    findings.push({
      severity: rule.severity,
      category: rule.category,
      ruleId: rule.id,
      path,
      term: match[0],
      excerpt: `${start > 0 ? "…" : ""}${text.slice(start, end).replace(/\s+/g, " ")}${end < text.length ? "…" : ""}`,
      message: rule.message,
    });
  }
  return findings;
}

type TextUnit = { path: string; text: string };

/** 剧本导入的标记写在 provenance.prompt 开头（story-screen 生成时拼的） */
export const IMPORT_PROMPT_PREFIX = "导入剧本";

export type PreflightOptions = {
  /** 成片页当前填的发布标题；缺省用项目标题 */
  title?: string;
  description?: string;
  topics?: string;
  /** 时间线全长；缺省按 timeline 求和 */
  durationMs?: number;
  at?: string;
};

/** 收集所有会出现在成片、发布文案里的用户文本。 */
export function collectTexts(
  project: Project,
  options: PreflightOptions = {},
): TextUnit[] {
  const units: TextUnit[] = [];
  const push = (path: string, text: string | undefined) => {
    if (text && text.trim()) units.push({ path, text });
  };

  push("标题", project.title);
  const story = project.story;
  push("故事 · logline", story.logline);
  push("故事 · 梗概", story.synopsis);
  push("故事 · 类型", story.genre);
  push("故事 · 受众", story.audience);
  push("故事 · 调性", story.tone);
  push("故事 · 开场钩子", story.hooks.opening);
  push("故事 · 结尾钩子", story.hooks.ending);

  const characterName = (id: string) =>
    project.characters.find((character) => character.id === id)?.name ?? id;

  for (const arc of story.arcs) {
    const name = characterName(arc.characterId);
    for (const [label, value] of [
      ["欲望", arc.want],
      ["需要", arc.need],
      ["创伤", arc.wound],
      ["缺陷", arc.flaw],
      ["秘密", arc.secret],
      ["主动性", arc.agency],
      ["弧光", arc.arc],
    ] as const) {
      push(`人物弧光 · ${name} · ${label}`, value);
    }
  }
  for (const relation of story.relationships) {
    push(
      `关系 · ${characterName(relation.fromCharacterId)} → ${characterName(relation.toCharacterId)}`,
      relation.tension,
    );
  }

  for (const character of project.characters) {
    push(`角色「${character.name}」· 外观`, character.appearance);
    for (const rule of character.mustNotChange) {
      push(`角色「${character.name}」· 监工要点`, rule);
    }
  }
  for (const location of project.locations) {
    push(`场景「${location.name}」· 描述`, location.description);
  }
  for (const prop of project.props) {
    push(`道具「${prop.name}」· 描述`, prop.description);
  }

  const sceneCode = (sceneId: string) => {
    const scene = project.scenes.find((item) => item.id === sceneId);
    if (!scene) return "";
    return scene.code || `第 ${scene.index + 1} 场`;
  };
  for (const shot of project.shots) {
    const where = `${sceneCode(shot.sceneId)} · 第 ${shot.index + 1} 镜`;
    push(`${where} · 描述`, shot.description);
    for (const [index, note] of shot.promptNotes.entries()) {
      push(`${where} · 补充 ${index + 1}`, note);
    }
  }
  for (const line of project.dialogue) {
    push(`台词 · ${characterName(line.characterId)}`, line.text);
  }

  push("发布 · 标题", options.title);
  push("发布 · 简介", options.description);
  push("发布 · 话题", options.topics);

  return units;
}

export function scanProject(
  project: Project,
  options: PreflightOptions = {},
): ComplianceFinding[] {
  const findings: ComplianceFinding[] = [];
  for (const unit of collectTexts(project, options)) {
    findings.push(...scanText(unit.text, unit.path));
  }
  return findings;
}

/** 较小的稳定指纹：UI 用它判断「确认之后内容有没有改过」 */
function fnv1a(input: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

function rightsCheck(project: Project): {
  check: ComplianceCheck;
  findings: ComplianceFinding[];
} {
  const uploads = project.assets.filter(
    (asset) => asset.source === "upload" || asset.source === "imported",
  );
  if (uploads.length > 0) {
    return {
      check: {
        id: "rights",
        label: "素材授权",
        status: "review",
        detail: `${uploads.length} 个上传 / 导入素材没有授权记录（H7 未做）：确认你有使用权再导出`,
      },
      findings: [
        {
          severity: "review",
          category: "其他",
          ruleId: "rights-upload",
          path: "素材授权",
          term: `${uploads.length} 个素材`,
          excerpt: "上传 / 导入素材",
          message: "上传或导入的素材还没有授权记录：确认你有使用权，再勾选确认导出。",
        },
      ],
    };
  }

  const imported = project.story.provenance?.prompt?.startsWith(IMPORT_PROMPT_PREFIX);
  return {
    check: {
      id: "rights",
      label: "素材授权",
      status: "pass",
      detail: imported
        ? "剧本导入时已声明原创或已获授权；原文不落服务端，只留文件名 / 字数 / 前 300 字"
        : "全部素材由模型生成或来自内置库，没有外部授权需求",
    },
    findings: [],
  };
}

/**
 * 导出前预检：AI 标识、内容安全、素材授权、平台规格。
 *
 * `ok` 只表示没有阻断项；`review > 0` 时界面仍要用户明确勾选才能导出。
 */
export function preflightProject(
  project: Project,
  options: PreflightOptions = {},
): ComplianceReport {
  const units = collectTexts(project, options);
  const findings = units.flatMap((unit) => scanText(unit.text, unit.path));
  const blockedFindings = findings.filter((finding) => finding.severity === "block");
  const reviewFindings = findings.filter((finding) => finding.severity === "review");

  const safetyStatus: ComplianceCheck["status"] =
    blockedFindings.length > 0 ? "block" : reviewFindings.length > 0 ? "review" : "pass";
  const safety: ComplianceCheck = {
    id: "safety",
    label: "内容安全",
    status: safetyStatus,
    detail:
      blockedFindings.length > 0
        ? `命中 ${blockedFindings.length} 条硬阻断规则，先从文案里删掉`
        : reviewFindings.length > 0
          ? `${COMPLIANCE_RULE_COUNT} 条规则扫过全部文本：${reviewFindings.length} 处需要人工确认`
          : `${COMPLIANCE_RULE_COUNT} 条规则扫过标题、故事、角色、场景、分镜、台词与发布文案，没有命中`,
  };

  const aiLabel: ComplianceCheck = {
    id: "ai-label",
    label: "AI 标识",
    status: "pass",
    detail: "画面右下角「AI 生成」角标 + HTML / OTIO 元数据 + 发布包 aiLabel",
  };

  const rights = rightsCheck(project);
  if (rights.findings.length > 0) findings.push(...rights.findings);

  const durationMs =
    options.durationMs ??
    project.timeline.items.reduce((sum, item) => sum + item.durationMs, 0);
  const seconds = durationMs / 1000;
  const specOk = durationMs > 0 && durationMs <= 180_000;
  const spec: ComplianceCheck = {
    id: "spec",
    label: "平台规格",
    status: specOk ? "pass" : "block",
    detail:
      durationMs <= 0
        ? "时间线还是空的：先把镜头放上时间线"
        : durationMs > 180_000
          ? `全长 ${seconds.toFixed(1)} 秒，超过 180 秒上限：回时间线删减`
          : `1080×1920 · 30fps · ${seconds.toFixed(1)} 秒（上限 180 秒）`,
  };

  const checks = [aiLabel, safety, rights.check, spec];
  const blocked = findings.filter((finding) => finding.severity === "block").length;
  const review = findings.length - blocked;
  const signature = fnv1a(
    JSON.stringify({
      // 原文也要进指纹：改一句没有命中规则的话，之前的「确认」同样要失效
      texts: units.map((unit) => `${unit.path}\u0000${unit.text}`),
      checks: checks.map((check) => `${check.id}:${check.status}:${check.detail}`),
      findings: findings.map(
        (finding) => `${finding.ruleId}|${finding.path}|${finding.term}`,
      ),
    }),
  );

  return {
    ok: checks.every((check) => check.status !== "block"),
    blocked,
    review,
    checks,
    findings,
    signature,
    checkedAt: options.at ?? new Date().toISOString(),
  };
}

/** 渲染清单里的合规证据；校验时会核对形状，防止空对象蒙混过关 */
export type RenderCompliance = {
  ok: true;
  checkedAt: string;
  signature: string;
  reviewAcknowledged: boolean;
  findings: number;
};

export function renderComplianceOf(
  report: ComplianceReport,
  reviewAcknowledged: boolean,
): RenderCompliance {
  return {
    ok: true,
    checkedAt: report.checkedAt,
    signature: report.signature,
    reviewAcknowledged,
    findings: report.findings.length,
  };
}
