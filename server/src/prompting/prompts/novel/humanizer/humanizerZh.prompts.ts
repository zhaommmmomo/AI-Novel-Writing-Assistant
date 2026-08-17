import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import type { PromptAsset } from "../../../core/promptTypes";

export type HumanizerZhScope =
  | "long_chapter"
  | "long_chapter_repair"
  | "short_story_segment"
  | "short_story_repair";

export interface HumanizerZhPromptInput {
  scope: HumanizerZhScope;
  content: string;
  styleContractText?: string;
  styleHint?: string;
  retryInstruction?: string;
}

function countMeaningfulCharacters(value: string): number {
  return value.replace(/\s+/gu, "").length;
}

function stripOutputWrapper(value: string): string {
  let normalized = value.trim();
  const fenced = normalized.match(/^```(?:text|txt|markdown|md)?\s*\n([\s\S]*?)\n```$/iu);
  if (fenced?.[1]) {
    normalized = fenced[1].trim();
  }
  normalized = normalized.replace(/^(?:重写后的文本|人性化版本|改写后的正文|修订后的正文)\s*[:：]\s*/u, "");
  const summaryMarker = normalized.search(/\n{2,}(?:所做更改|修改说明|改写说明)\s*[:：]/u);
  return (summaryMarker >= 0 ? normalized.slice(0, summaryMarker) : normalized).trim();
}

export function validateHumanizerZhOutput(output: string, input: HumanizerZhPromptInput): string {
  const normalized = stripOutputWrapper(output);
  if (!normalized) {
    throw new Error("Humanizer 返回了空正文。");
  }
  if (/^(?:分析|说明|修改总结)\s*[:：]/u.test(normalized)) {
    throw new Error("Humanizer 返回了说明文字而不是正文。");
  }
  const sourceLength = countMeaningfulCharacters(input.content);
  const outputLength = countMeaningfulCharacters(normalized);
  if (sourceLength >= 100) {
    const ratio = outputLength / sourceLength;
    if (ratio < 0.6 || ratio > 1.35) {
      throw new Error(`Humanizer 改写长度偏离过大：原文 ${sourceLength} 字，结果 ${outputLength} 字。`);
    }
  }
  return normalized;
}

const HUMANIZER_PATTERN_CATALOG = [
  "1. 夸大普通事件的象征意义、历史意义、遗产或时代转折。",
  "2. 用媒体、名人、粉丝量等无关知名度代替具体叙事信息。",
  "3. 在句尾补充空泛分析，假装增加深度。",
  "4. 宣传、广告、导游词式的夸张语言。",
  "5. ‘有人认为、专家指出、众所周知’等模糊归因。",
  "6. ‘挑战、展望、未来可期’式提纲和通用结论。",
  "7. 此外、至关重要、深入探讨、格局、关键作用、充分展示等高频 AI 词簇。",
  "8. 为了显得正式而回避简单直接的‘是、有、说、做’。",
  "9. ‘不仅……而且……’、‘不是……而是……’等否定式排比滥用。",
  "10. 为显得完整而强行凑三项、三句或三段。",
  "11. 同一个人物或事物被机械轮换近义称呼。",
  "12. 没有真实尺度关系的‘从 X 到 Y’虚假范围。",
  "13. 破折号过多，尤其用破折号制造虚假力度或解释。",
  "14. 粗体、强调符号和格式化痕迹进入正文。",
  "15. 正文突然变成带小标题的垂直清单。",
  "16. 不符合中文小说语境的标题格式。",
  "17. 表情符号和社交媒体装饰符号。",
  "18. 与既定中文标点风格不一致的引号和标点。",
  "19. ‘当然、希望对你有帮助、如果你愿意’等聊天协作痕迹。",
  "20. 知识截止日期、训练数据、信息有限等模型免责声明。",
  "21. 讨好、谄媚、过度肯定读者或角色的口吻。",
  "22. 值得注意的是、为了实现这一目标、在这个时间点等填充短语。",
  "23. 可能、或许、似乎、某种程度上等过度限定连续堆叠。",
  "24. 光明未来、全新篇章、继续前行等通用积极结尾。",
].join("\n");

export const humanizerZhPrompt: PromptAsset<HumanizerZhPromptInput, string, string> = {
  id: "novel.prose.humanizer_zh",
  version: "v1",
  taskType: "repair",
  mode: "text",
  language: "zh",
  contextPolicy: { maxTokensBudget: 0 },
  management: {
    productPrompt: true,
    proseGeneration: false,
    editModes: ["readonly"],
  },
  render: (input) => [
    new SystemMessage([
      "你是中文小说终稿编辑，执行 Humanizer-zh 人性化处理。",
      "目标是去除 AI 生成痕迹，让正文自然、具体、有角色声音，同时严格保留故事本身。",
      "该规则集改编自 op7418/humanizer-zh（MIT），面向小说正文做了事实保护调整。",
      "",
      "输出硬规则：",
      "1. 只输出处理后的完整正文，不要输出标题、分析、评分、修改说明、Markdown 或代码块。",
      "2. 不得改变事件事实、事件顺序、因果关系、人物身份、人物关系、角色立场、道具归属、地点、数字和核心剧情结果。",
      "3. 不得新增角色、设定、线索、能力、反转、冲突、结论或世界规则。",
      "4. 保持原叙事视角、时态、题材气质、对话事实和章节功能，不得擅自加入第一人称评论、幽默或作者观点。",
      "5. 保持原文篇幅和信息密度在合理范围；不能把场景压缩成梗概，也不能为显得自然而扩写新情节。",
      "6. 人性化只处理表达层：措辞、句式、段落节奏、叙述距离、模板痕迹和无效解释。",
      "",
      "五项核心原则：",
      "1. 删除填充短语，直接进入正在发生的事。",
      "2. 打破公式结构，避免机械对比、三段式、解释式转折和整齐到失真的段落。",
      "3. 变化节奏，混合长短句和段落收束方式，但不要故意切成碎句。",
      "4. 信任读者，用动作、对白、停顿、视线、环境反应和选择呈现，不替读者总结。",
      "5. 删除像宣传语、金句或作者判词的句子，换成现场中的具体信息。",
      "",
      "必须逐项扫描的 24 类模式：",
      HUMANIZER_PATTERN_CATALOG,
      "",
      "小说适配要求：",
      "1. ‘注入灵魂’不是加入作者议论，而是恢复人物独有的语气、动作习惯、犹豫、偏见和具体感受。",
      "2. 避免无菌的均匀句式，也避免靠‘手心出汗、喉咙发紧、心头一震’等浅层身体反应伪装自然。",
      "3. 同类模板词集中出现时整体降密度，不做逐词机械替换。",
      "4. 比喻能删则删；保留真正服务人物视角和场景感受的比喻，不解释比喻含义。",
      "5. 对话要符合人物关系和现场压力，不把角色写成观点播报器。",
      "6. 段尾不要连续使用总结、升华、悬浮判断或同一种钩子。",
      "7. 在心里按直接性、节奏、信任度、真实性、精炼度五项各 10 分自检；未达到 45/50 时继续修订后再输出。",
      input.retryInstruction ? `重试要求：${input.retryInstruction}` : "",
    ].filter(Boolean).join("\n")),
    new HumanMessage([
      `处理范围：${input.scope}`,
      input.styleContractText ? `【必须保持的本书写法合同】\n${input.styleContractText}` : "",
      input.styleHint ? `【必须保持的风格提示】\n${input.styleHint}` : "",
      "【待处理正文】",
      input.content,
    ].filter(Boolean).join("\n\n")),
  ],
  postValidate: validateHumanizerZhOutput,
};
