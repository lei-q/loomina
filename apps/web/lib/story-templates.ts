/**
 * 模板剧本（A7 / ADR-0159）。
 *
 * 冷启动最贵的一步是「从空白开始想」。这里给六个能直接套的短剧开头：
 * 一句梗概、几个人物、六拍任务、两个钩子。选中模板只填「一句话 / 大纲」、
 * 题材与节拍表，不建项目、不调模型；作者仍然可以改，再点生成。
 *
 * 模板来自首发聚焦的室内、少人、对话驱动题材；古装、萌宝、动作不放进默认六条，
 * 因为群演、特效与一致性风险会放大。
 */

import { BEAT_SHEETS, genreById } from "@loomina/pipeline";

export type StoryTemplateBeat = {
  label: string;
  task: string;
};

export type StoryTemplate = {
  id: string;
  name: string;
  /** 对应 `GENRE_MATRIX` 的 id；用 name 走 `setGenre` */
  genreId: string;
  genre: string;
  /** 一句话梗概：生成输入的第一行 */
  logline: string;
  /** 两三句人物与冲突；仍然只是想法，不是分镜 */
  synopsis: string;
  /** 建议的 2–3 个角色，只写关系与欲望，不写外观 */
  cast: string[];
  beats: StoryTemplateBeat[];
  openingHook: string;
  endingHook: string;
  /** 为什么这条适合 AI 短剧：室内 / 少人 / 对话驱动 */
  note: string;
};

export const TEMPLATE_BEAT_SHEET = "60s";

export const STORY_TEMPLATES: StoryTemplate[] = [
  {
    id: "comeback-heir",
    name: "逆袭：外卖员少主",
    genreId: "comeback",
    genre: "逆袭打脸",
    logline: "外卖员每天给顶层公寓送餐，直到董事长当众喊他「少主」。",
    synopsis:
      "他白天送餐、晚上查父亲坠楼的真相，顶层住着的正是当年接手公司的人。一次送餐撞见董事会，身份被叫破；他不要认亲，只要一份当年的监控。",
    cast: ["外卖员：不肯认亲的继承人", "董事长：喊破身份的老臣", "顶层住户：握着监控的人"],
    beats: [
      { label: "hook", task: "电梯门开，董事长当众喊「少主」" },
      { label: "setup", task: "他否认，继续送餐；观众看见他藏着的旧工牌" },
      { label: "escalation", task: "监控被删，唯一证人改口" },
      { label: "turn", task: "他发现改口的人正是自己每天送餐的住户" },
      { label: "climax", task: "当众放出另一份备份，身份与真相一起落地" },
      { label: "endHook", task: "父亲坠楼那晚，电梯里还有第三个人" },
    ],
    openingHook: "被叫破身份的下一秒，他先把外卖递了过去。",
    endingHook: "监控最后一帧，出现了一只他认得的手。",
    note: "室内、三人、对话驱动；冲突靠身份反差，不靠打斗。",
  },
  {
    id: "sweet-contract",
    name: "甜宠：契约婚姻",
    genreId: "sweet-ceo",
    genre: "甜宠霸总",
    logline: "为了保住外婆的房子，她签下三个月的契约婚姻，新郎是昨天刚拒掉的相亲对象。",
    synopsis:
      "两人约法三章：不同房、不公开、到期离婚。她不知道他早就认识她——十年前那场雨里，是她把伞留给了还是穷小子的他。",
    cast: ["她：要保住外婆房子的普通职员", "他：装冷淡的年轻老板", "外婆：什么都看明白的老人"],
    beats: [
      { label: "hook", task: "民政局门口，她发现新郎是昨天拒掉的人" },
      { label: "setup", task: "三条约定签下，两人互相提防" },
      { label: "escalation", task: "外婆突然住院，他不动声色把费用交了" },
      { label: "turn", task: "她翻到十年前的旧伞，认出他" },
      { label: "climax", task: "他在家人面前承认这段婚姻不是假的" },
      { label: "endHook", task: "契约到期那天，他把离婚协议换成了另一份文件" },
    ],
    openingHook: "她拒掉的相亲对象，正坐在民政局的新郎席上。",
    endingHook: "他递过来的不是离婚协议，是一份房产证。",
    note: "两三个人、室内为主；甜靠细节与台词，不靠大场面。",
  },
  {
    id: "urban-ex",
    name: "都市：前任重逢",
    genreId: "urban-romance",
    genre: "都市情感",
    logline: "离婚三年后，她在新公司的电梯里遇见前夫，他胸牌上的职位是她这次要面试的岗位。",
    synopsis:
      "她装作不认识，他也配合。直到项目出事，两人被迫一起加班，才发现当年分开的原因是一场双方家长合谋的隐瞒。",
    cast: ["她：刚回职场的前妻", "他：装作不熟的前夫", "闺蜜：知道内情却一直没说"],
    beats: [
      { label: "hook", task: "电梯里，两人的胸牌与工位正对" },
      { label: "setup", task: "面试通过，她成了他的下属" },
      { label: "escalation", task: "项目背锅，两人被迫共同取证" },
      { label: "turn", task: "证据指向当年拆散他们的那通电话" },
      { label: "climax", task: "她在会上把隐瞒摊开，他第一次低头道歉" },
      { label: "endHook", task: "散会后，他问：这次能不能不隔三年" },
    ],
    openingHook: "电梯门合上前，她看见前夫的工位就在自己正对面。",
    endingHook: "他问出口的那一刻，电梯又停在了同一层。",
    note: "办公室与家里两三个场景；情绪靠对话推进。",
  },
  {
    id: "mystery-roommate",
    name: "悬疑：室友的秘密",
    genreId: "revenge-mystery",
    genre: "悬疑复仇",
    logline: "合租第三个月，她发现室友每晚都会在同一时间擦同一块地板。",
    synopsis:
      "她撬开地板，里面是前租客留下的日记。日记最后一页写着：如果我不见了，去找那个每天擦地的人。",
    cast: ["她：刚搬进来的租客", "室友：过分爱干净的夜班人", "前租客：只存在于日记里的女孩"],
    beats: [
      { label: "hook", task: "凌晨三点，室友又跪着擦同一块地板" },
      { label: "setup", task: "她开始留意时间、声响与室友的作息" },
      { label: "escalation", task: "地板下摸到一本被水泡过的日记" },
      { label: "turn", task: "日记最后一行写的是她的名字" },
      { label: "climax", task: "室友承认前租客失踪，却说自己是在替人守着" },
      { label: "endHook", task: "日记最后一页的日期，是明天" },
    ],
    openingHook: "凌晨三点，拖把声准时响起，像在擦掉什么。",
    endingHook: "日记最后一页的日期，是明天。",
    note: "两室一厅、两个人；悬念靠声音与物件，不靠血腥。",
  },
  {
    id: "family-ledger",
    name: "家庭：母亲的账本",
    genreId: "family",
    genre: "家庭伦理",
    logline: "母亲去世后，三兄妹在账本里发现每个月都有一笔转给陌生人的钱。",
    synopsis:
      "账本记了二十年，最后一行停在母亲住院那天。三人顺着地址找过去，开门的是一个叫母亲「妈」的年轻人。",
    cast: ["大姐：管钱也管人的长女", "小弟：被偏爱却最心虚", "陌生人：每月收钱的人"],
    beats: [
      { label: "hook", task: "账本最后一页，收款人一栏写着「儿子」" },
      { label: "setup", task: "三兄妹为遗产争吵，账本被摔开" },
      { label: "escalation", task: "他们找到地址，门里人叫母亲「妈」" },
      { label: "turn", task: "年轻人拿出母亲写给他的信：别争，她欠我的" },
      { label: "climax", task: "大姐承认当年是她把弟弟送走的" },
      { label: "endHook", task: "信的最后一行：账本还有第二本" },
    ],
    openingHook: "账本最后一页，收款人一栏写着「儿子」。",
    endingHook: "母亲的字迹：账本还有第二本。",
    note: "室内、四人以内；冲突靠旧事与钱，不靠外景。",
  },
  {
    id: "workplace-intern",
    name: "职场：实习生掀桌",
    genreId: "workplace",
    genre: "职场",
    logline: "实习生转正答辩当天，把总监让她背锅的聊天记录投上了大屏。",
    synopsis:
      "她不是冲动：三个月里，她把自己经手的每一份文件都留了版本。总监以为她好拿捏，直到大屏上出现第一条撤回的消息。",
    cast: ["她：准备转正的实习生", "总监：习惯甩锅的中层", "组长：知道真相却不敢说话的人"],
    beats: [
      { label: "hook", task: "答辩开始，她把手机投上了大屏" },
      { label: "setup", task: "三个月前，她第一次被要求改署名" },
      { label: "escalation", task: "项目出事，所有记录都指向她" },
      { label: "turn", task: "组长私下劝她认了，她反手录了音" },
      { label: "climax", task: "聊天记录逐条播放，总监当场失语" },
      { label: "endHook", task: "HR 递来新合同，岗位是总监的位置" },
    ],
    openingHook: "答辩第一页不是 PPT，是三个月的聊天记录。",
    endingHook: "新合同上的岗位，正好空出来一个。",
    note: "办公室、三四个人；爽点靠证据与反转，不靠动作。",
  },
];

export function templateById(id: string | undefined): StoryTemplate | undefined {
  if (!id) return undefined;
  return STORY_TEMPLATES.find((template) => template.id === id);
}

/**
 * 把模板翻成故事页的输入。
 *
 * 钩子直接写进想法里：生成时模型能看见；不单独写 IR，因为这一刻还没有项目。
 */
export function templateStoryInput(template: StoryTemplate): {
  idea: string;
  genre: string;
  beatSheetId: string;
  openingHook: string;
  endingHook: string;
} {
  return {
    idea: [
      template.logline,
      template.synopsis,
      `开场钩子：${template.openingHook}`,
      `结尾钩子：${template.endingHook}`,
    ].join("\n\n"),
    genre: template.genre,
    beatSheetId: TEMPLATE_BEAT_SHEET,
    openingHook: template.openingHook,
    endingHook: template.endingHook,
  };
}

/** 模板引用的题材 / 节拍表必须真的存在：数据写错时在测试里当场露出来 */
export function templateIssues(templates: StoryTemplate[] = STORY_TEMPLATES): string[] {
  const issues: string[] = [];
  const ids = new Set<string>();
  for (const template of templates) {
    if (ids.has(template.id)) issues.push(`重复模板 id：${template.id}`);
    ids.add(template.id);
    const genre = genreById(template.genreId);
    if (!genre) issues.push(`${template.id} 的题材不存在：${template.genreId}`);
    else if (genre.name !== template.genre) {
      issues.push(`${template.id} 的题材名对不上：${template.genre} ≠ ${genre.name}`);
    }
    if (!BEAT_SHEETS.some((sheet) => sheet.id === TEMPLATE_BEAT_SHEET)) {
      issues.push(`${template.id} 的节拍表不存在：${TEMPLATE_BEAT_SHEET}`);
    }
    if (template.beats.length === 0) issues.push(`${template.id} 没有节拍`);
  }
  return issues;
}
