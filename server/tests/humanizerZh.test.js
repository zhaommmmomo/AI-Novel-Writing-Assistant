const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  humanizerZhPrompt,
  validateHumanizerZhOutput,
} = require("../dist/prompting/prompts/novel/humanizer/humanizerZh.prompts.js");
const {
  HumanizerZhRequiredError,
  HumanizerZhService,
} = require("../dist/services/novel/runtime/humanizer/HumanizerZhService.js");
const { listRegisteredPromptAssets } = require("../dist/prompting/registry.js");

const SERVER_ROOT = path.join(__dirname, "..");
const REPO_ROOT = path.join(SERVER_ROOT, "..");

test("humanizer-zh is a registered read-only product prompt with fiction safeguards", () => {
  const asset = listRegisteredPromptAssets().find((item) => item.id === "novel.prose.humanizer_zh");
  assert.ok(asset);
  assert.equal(asset.version, "v1");
  assert.equal(asset.mode, "text");
  assert.deepEqual(asset.management?.editModes, ["readonly"]);

  const messages = humanizerZhPrompt.render({
    scope: "long_chapter",
    content: "正文".repeat(200),
  }, { blocks: [], selectedBlockIds: [], droppedBlockIds: [], summarizedBlockIds: [], estimatedInputTokens: 0 });
  const rendered = messages.map((item) => String(item.content)).join("\n");
  assert.match(rendered, /必须逐项扫描的 24 类模式/u);
  assert.match(rendered, /不得改变事件事实、事件顺序、因果关系/u);
  assert.match(rendered, /不得新增角色、设定、线索、能力、反转/u);
  assert.match(rendered, /45\/50/u);
});

test("humanizer output validation strips wrappers and rejects destructive length drift", () => {
  const source = "他推开门，屋里没有开灯。".repeat(40);
  const normalized = validateHumanizerZhOutput(
    `重写后的文本：\n${source}`,
    { scope: "long_chapter", content: source },
  );
  assert.equal(normalized, source);

  assert.throws(() => validateHumanizerZhOutput(
    "只剩一句。",
    { scope: "long_chapter", content: source },
  ), /长度偏离过大/u);
});

test("humanizer service retries once and never falls back to untreated prose", async () => {
  const source = "雨落在窗沿上，他把那封信折回原样。".repeat(30);
  const calls = [];
  const service = new HumanizerZhService({
    styleRuntimeResolver: {
      resolve: async () => ({ context: { compiledBlocks: null } }),
    },
    runPrompt: async (input) => {
      calls.push(input.promptInput);
      if (calls.length === 1) {
        throw new Error("temporary validation failure");
      }
      return { output: source };
    },
  });

  const result = await service.humanize({
    content: source,
    scope: "long_chapter",
    novelId: "novel-1",
  });
  assert.equal(result.content, source);
  assert.equal(result.changed, false);
  assert.equal(calls.length, 2);
  assert.match(calls[1].retryInstruction, /上一次结果未通过/u);

  const failing = new HumanizerZhService({
    styleRuntimeResolver: {
      resolve: async () => ({ context: { compiledBlocks: null } }),
    },
    runPrompt: async () => {
      throw new Error("provider unavailable");
    },
  });
  await assert.rejects(
    () => failing.humanize({ content: source, scope: "long_chapter" }),
    (error) => error instanceof HumanizerZhRequiredError && /未进入成稿状态/u.test(error.message),
  );
});

test("all persisted generated prose paths invoke the mandatory humanizer", () => {
  const files = [
    ["src/services/novel/runtime/ChapterContentFinalizationService.ts", /scope: "long_chapter"/u],
    ["src/services/novel/runtime/repair/ChapterRepairStreamRuntime.ts", /scope: "long_chapter_repair"/u],
    ["src/services/novel/chapterEditor/NovelChapterEditorService.ts", /scope: "long_chapter_repair"/u],
    ["src/modules/novel/short-story/application/ShortStoryProductionService.ts", /scope: "short_story_segment"/u],
    ["src/modules/novel/short-story/application/ShortStoryProductionService.ts", /scope: "short_story_repair"/u],
    ["src/modules/novel/short-story/application/ShortStoryStudioService.ts", /scope: "short_story_segment"/u],
    ["src/modules/novel/short-story/application/ShortStoryStudioService.ts", /scope: "short_story_repair"/u],
  ];
  for (const [relativePath, pattern] of files) {
    const source = fs.readFileSync(path.join(SERVER_ROOT, relativePath), "utf8");
    assert.match(source, pattern, `${relativePath} must invoke Humanizer-zh`);
  }
  assert.ok(fs.existsSync(path.join(REPO_ROOT, "third_party", "humanizer-zh", "LICENSE")));
  assert.ok(fs.existsSync(path.join(REPO_ROOT, "third_party", "humanizer-zh", "SOURCE.md")));
});
