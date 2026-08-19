const test = require("node:test");
const assert = require("node:assert/strict");

const {
  applyMirroredChapterToVolumes,
  hydrateVolumesFromCanonicalChapters,
  resolveCanonicalChapterRows,
} = require("../dist/services/novel/volume/volumeChapterMirror.js");
const {
  findDuplicateChapterOrders,
} = require("../dist/services/novel/volume/volumeWorkspaceDocument.js");

function createWorkspaceChapter(overrides) {
  return {
    id: overrides.id,
    volumeId: overrides.volumeId ?? "volume-1",
    chapterId: overrides.chapterId ?? null,
    chapterOrder: overrides.chapterOrder,
    beatKey: null,
    title: overrides.title ?? `计划第${overrides.chapterOrder}章`,
    summary: overrides.summary ?? `计划第${overrides.chapterOrder}章摘要`,
    purpose: null,
    exclusiveEvent: null,
    endingState: null,
    nextChapterEntryState: null,
    conflictLevel: null,
    conflictLevelSource: overrides.conflictLevelSource ?? "ai",
    revealLevel: null,
    targetWordCount: null,
    mustAvoid: null,
    taskSheet: null,
    sceneCards: null,
    styleContract: null,
    payoffRefs: [],
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
  };
}

function createVolume(chapters, volumeId = "volume-1") {
  return {
    id: volumeId,
    novelId: "novel-1",
    sortOrder: 1,
    title: "第一卷",
    summary: null,
    openingHook: null,
    mainPromise: null,
    primaryPressureSource: null,
    coreSellingPoint: null,
    escalationMode: null,
    protagonistChange: null,
    midVolumeRisk: null,
    climax: null,
    payoffType: null,
    nextVolumeHook: null,
    resetPoint: null,
    openPayoffs: [],
    status: "active",
    sourceVersionId: null,
    chapters,
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
  };
}

function createChapterRow(id, order, title) {
  return {
    id,
    order,
    title: title ?? `正文第${order}章`,
    expectation: `正文第${order}章预期`,
    targetWordCount: 2500,
    conflictLevel: 3,
    revealLevel: 2,
    mustAvoid: null,
    taskSheet: null,
    sceneCards: null,
  };
}

/**
 * The plan inserted two new opening chapters, so the already written chapters keep their old
 * `Chapter.order`. Adopting those orders would put two workspace chapters on the same slot.
 */
function createDriftedWorkspace() {
  return [createVolume([
    createWorkspaceChapter({ id: "ws-1", chapterOrder: 1 }),
    createWorkspaceChapter({ id: "ws-2", chapterOrder: 2 }),
    createWorkspaceChapter({ id: "ws-3", chapterOrder: 3, chapterId: "chapter-1" }),
    createWorkspaceChapter({ id: "ws-4", chapterOrder: 4, chapterId: "chapter-2" }),
  ])];
}

test("resolveCanonicalChapterRows never hands the same chapter row to two workspace chapters", () => {
  const volumes = createDriftedWorkspace();
  const rows = [createChapterRow("chapter-1", 1), createChapterRow("chapter-2", 2)];

  const resolved = resolveCanonicalChapterRows(volumes, rows);

  assert.equal(resolved.get("ws-3").id, "chapter-1");
  assert.equal(resolved.get("ws-4").id, "chapter-2");
  assert.equal(resolved.has("ws-1"), false);
  assert.equal(resolved.has("ws-2"), false);
  const claimed = [...resolved.values()].map((row) => row.id);
  assert.equal(new Set(claimed).size, claimed.length);
});

test("hydrateVolumesFromCanonicalChapters keeps plan orders when canonical orders would collide", () => {
  const volumes = createDriftedWorkspace();
  const rows = [createChapterRow("chapter-1", 1), createChapterRow("chapter-2", 2)];

  const result = hydrateVolumesFromCanonicalChapters(volumes, rows);

  assert.equal(result.orderConflict, true);
  assert.equal(result.changed, true);
  assert.deepEqual(findDuplicateChapterOrders(result.volumes), []);
  assert.deepEqual(result.volumes[0].chapters.map((chapter) => chapter.chapterOrder), [1, 2, 3, 4]);
  // Content still mirrors the canonical rows even though the orders were left alone.
  assert.equal(result.volumes[0].chapters[2].title, "正文第1章");
  assert.equal(result.volumes[0].chapters[2].summary, "正文第1章预期");
  assert.equal(result.volumes[0].chapters[0].title, "计划第1章");
});

test("hydrateVolumesFromCanonicalChapters adopts canonical orders when they stay unique", () => {
  const volumes = [createVolume([
    createWorkspaceChapter({ id: "ws-1", chapterOrder: 1, chapterId: "chapter-1" }),
    createWorkspaceChapter({ id: "ws-2", chapterOrder: 2, chapterId: "chapter-2" }),
  ])];
  const rows = [createChapterRow("chapter-1", 2), createChapterRow("chapter-2", 1)];

  const result = hydrateVolumesFromCanonicalChapters(volumes, rows);

  assert.equal(result.orderConflict, false);
  assert.equal(result.changed, true);
  assert.deepEqual(result.volumes[0].chapters.map((chapter) => chapter.chapterOrder), [2, 1]);
  assert.deepEqual(findDuplicateChapterOrders(result.volumes), []);
});

test("hydrateVolumesFromCanonicalChapters keeps a user conflict level", () => {
  const volumes = [createVolume([
    {
      ...createWorkspaceChapter({ id: "ws-1", chapterOrder: 1, chapterId: "chapter-1" }),
      conflictLevel: 9,
      conflictLevelSource: "user",
    },
  ])];

  const result = hydrateVolumesFromCanonicalChapters(volumes, [createChapterRow("chapter-1", 1)]);

  assert.equal(result.volumes[0].chapters[0].conflictLevel, 9);
  assert.equal(result.volumes[0].chapters[0].conflictLevelSource, "user");
});

test("hydrateVolumesFromCanonicalChapters is a no-op without chapter rows", () => {
  const volumes = createDriftedWorkspace();

  const result = hydrateVolumesFromCanonicalChapters(volumes, []);

  assert.equal(result.changed, false);
  assert.equal(result.volumes, volumes);
});

test("applyMirroredChapterToVolumes updates the bound slot without stealing another order", () => {
  const volumes = [createVolume([
    createWorkspaceChapter({ id: "ws-1", chapterOrder: 1, chapterId: "chapter-1" }),
    createWorkspaceChapter({ id: "ws-2", chapterOrder: 2, chapterId: "chapter-2" }),
  ])];

  const result = applyMirroredChapterToVolumes(volumes, {
    id: "chapter-1",
    order: 2,
    title: "改名后的第一章",
  });

  assert.equal(result.changed, true);
  assert.equal(result.orderConflict, true);
  assert.equal(result.volumes[0].chapters[0].title, "改名后的第一章");
  assert.equal(result.volumes[0].chapters[0].chapterOrder, 1);
  assert.deepEqual(findDuplicateChapterOrders(result.volumes), []);
});

test("applyMirroredChapterToVolumes binds a free slot at the same order", () => {
  const volumes = [createVolume([
    createWorkspaceChapter({ id: "ws-1", chapterOrder: 1 }),
    createWorkspaceChapter({ id: "ws-2", chapterOrder: 2 }),
  ])];

  const result = applyMirroredChapterToVolumes(volumes, {
    id: "chapter-new",
    order: 2,
    title: "新写的第二章",
    expectation: "第二章预期",
  });

  assert.equal(result.changed, true);
  assert.equal(result.orderConflict, false);
  assert.equal(result.volumes[0].chapters[1].chapterId, "chapter-new");
  assert.equal(result.volumes[0].chapters[1].title, "新写的第二章");
  assert.equal(result.volumes[0].chapters[1].summary, "第二章预期");
  assert.equal(result.volumes[0].chapters[0].chapterId, null);
});

test("applyMirroredChapterToVolumes leaves a slot bound to a different chapter alone", () => {
  const volumes = [createVolume([
    createWorkspaceChapter({ id: "ws-1", chapterOrder: 1, chapterId: "chapter-1" }),
  ])];

  const result = applyMirroredChapterToVolumes(volumes, {
    id: "chapter-other",
    order: 1,
    title: "另一章",
  });

  assert.equal(result.changed, false);
  assert.equal(result.volumes[0].chapters[0].chapterId, "chapter-1");
});

test("findDuplicateChapterOrders reports collisions per volume", () => {
  const volumes = [
    createVolume([
      createWorkspaceChapter({ id: "ws-1", chapterOrder: 1 }),
      createWorkspaceChapter({ id: "ws-2", chapterOrder: 1 }),
    ], "volume-1"),
    createVolume([
      createWorkspaceChapter({ id: "ws-3", volumeId: "volume-2", chapterOrder: 1 }),
    ], "volume-2"),
  ];

  assert.deepEqual(findDuplicateChapterOrders(volumes), [
    { volumeId: "volume-1", chapterOrder: 1, chapterIds: ["ws-1", "ws-2"] },
  ]);
});
