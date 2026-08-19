#!/usr/bin/env node
/**
 * Realign Chapter.order with the volume plan slots each chapter is bound to.
 *
 * Background: when the director rewrites a beat it can insert chapters ahead of already
 * written ones. The volume workspace renumbers its own slots, but the Chapter rows keep the
 * old numbering, so `Chapter.order` and `VolumeChapterPlan.chapterOrder` drift apart.
 *
 * The mapping is derived, never hardcoded: a chapter bound to a plan slot takes that slot's
 * chapterOrder; a chapter bound to no slot is superseded content. Superseded chapters are
 * exported to markdown and then removed together with the artifacts that were derived from
 * them and keyed by chapter order (character timeline entries, extracted facts, open
 * conflicts) — those would otherwise be silently re-attributed to whichever new chapter
 * reuses the number.
 *
 * Usage:
 *   node scripts/realign-chapter-orders.cjs <novelId>            # dry run
 *   node scripts/realign-chapter-orders.cjs <novelId> --apply    # execute
 */

const fs = require("node:fs");
const path = require("node:path");

const novelId = process.argv[2];
const apply = process.argv.includes("--apply");

if (!novelId) {
  console.error("Usage: node scripts/realign-chapter-orders.cjs <novelId> [--apply]");
  process.exit(1);
}

const serverRoot = path.resolve(__dirname, "..");
if (!process.env.DATABASE_URL) {
  process.env.DATABASE_URL = `file:${path.join(serverRoot, "dev.db")}`;
}

const { prisma } = require(path.join(serverRoot, "dist/db/prisma.js"));

function formatChapter(chapter) {
  return `#${String(chapter.order).padStart(2, " ")} ${chapter.title}`;
}

async function loadState() {
  const [chapters, planRows] = await Promise.all([
    prisma.chapter.findMany({
      where: { novelId },
      orderBy: { order: "asc" },
      select: {
        id: true,
        order: true,
        title: true,
        content: true,
        chapterStatus: true,
        generationState: true,
        expectation: true,
        createdAt: true,
      },
    }),
    prisma.volumeChapterPlan.findMany({
      where: { volume: { novelId } },
      select: { id: true, chapterId: true, chapterOrder: true, title: true },
      orderBy: { chapterOrder: "asc" },
    }),
  ]);

  const planByChapterId = new Map();
  for (const row of planRows) {
    if (row.chapterId) {
      planByChapterId.set(row.chapterId, row);
    }
  }

  const bound = [];
  const superseded = [];
  for (const chapter of chapters) {
    const planRow = planByChapterId.get(chapter.id);
    if (planRow) {
      bound.push({ chapter, targetOrder: planRow.chapterOrder, planTitle: planRow.title });
    } else {
      superseded.push(chapter);
    }
  }
  return { chapters, planRows, bound, superseded };
}

function assertSafeMapping(bound) {
  const targets = bound.map((item) => item.targetOrder);
  if (new Set(targets).size !== targets.length) {
    throw new Error("Plan slots are not unique; refusing to migrate. Fix the workspace first.");
  }
  const reordered = [...bound].sort((left, right) => left.chapter.order - right.chapter.order);
  for (let index = 1; index < reordered.length; index += 1) {
    if (reordered[index].targetOrder <= reordered[index - 1].targetOrder) {
      throw new Error(
        "Plan slots do not preserve the existing reading order; refusing to migrate."
        + ` ${formatChapter(reordered[index - 1].chapter)} -> ${reordered[index - 1].targetOrder},`
        + ` ${formatChapter(reordered[index].chapter)} -> ${reordered[index].targetOrder}`,
      );
    }
  }
}

function writeSupersededExport(superseded) {
  const stamp = new Date().toISOString().slice(0, 10);
  const exportDir = path.join(serverRoot, "backups");
  fs.mkdirSync(exportDir, { recursive: true });
  const exportPath = path.join(exportDir, `superseded-chapters-${novelId}-${stamp}.md`);
  const body = [
    `# 被计划替换的章节正文备份`,
    ``,
    `- novelId: ${novelId}`,
    `- 导出时间: ${new Date().toISOString()}`,
    `- 章节数: ${superseded.length}`,
    `- 说明: 这些章节没有绑定任何卷计划槽位，是被导演重写节奏段后取代的旧正文。`,
    ``,
    ...superseded.flatMap((chapter) => [
      `---`,
      ``,
      `## 原第 ${chapter.order} 章 ${chapter.title}`,
      ``,
      `- chapterId: ${chapter.id}`,
      `- 状态: ${chapter.chapterStatus} / ${chapter.generationState}`,
      `- 字数: ${(chapter.content ?? "").length}`,
      `- 创建时间: ${new Date(chapter.createdAt).toISOString()}`,
      ...(chapter.expectation ? [``, `### 章节预期`, ``, chapter.expectation] : []),
      ``,
      `### 正文`,
      ``,
      chapter.content ?? "",
      ``,
    ]),
  ].join("\n");
  fs.writeFileSync(exportPath, body, "utf8");
  return { exportPath, chars: body.length };
}

async function countDerived(supersededIds, supersededOrders) {
  const [timeline, facts, conflicts, checkpoints, summaries, auditReports, qualityReports, storyPlans] = await Promise.all([
    prisma.characterTimeline.count({ where: { chapterId: { in: supersededIds } } }),
    prisma.novelFactEntry.count({ where: { novelId, chapterOrder: { in: supersededOrders } } }),
    prisma.openConflict.count({ where: { chapterId: { in: supersededIds } } }),
    prisma.chapterArtifactSyncCheckpoint.count({ where: { chapterId: { in: supersededIds } } }),
    prisma.chapterSummary.count({ where: { chapterId: { in: supersededIds } } }),
    prisma.auditReport.count({ where: { chapterId: { in: supersededIds } } }),
    prisma.qualityReport.count({ where: { chapterId: { in: supersededIds } } }),
    prisma.storyPlan.count({ where: { chapterId: { in: supersededIds } } }),
  ]);
  return { timeline, facts, conflicts, checkpoints, summaries, auditReports, qualityReports, storyPlans };
}

async function main() {
  const state = await loadState();
  const { bound, superseded } = state;

  console.log(`novelId=${novelId}`);
  console.log(`chapters=${state.chapters.length} planSlots=${state.planRows.length} bound=${bound.length} superseded=${superseded.length}`);
  console.log("");

  if (bound.length === 0) {
    console.log("No chapter is bound to a plan slot; nothing to realign.");
    return;
  }

  assertSafeMapping(bound);

  const moves = bound
    .filter((item) => item.chapter.order !== item.targetOrder)
    .sort((left, right) => right.targetOrder - left.targetOrder);

  console.log("== chapters to renumber ==");
  if (moves.length === 0) {
    console.log("(none — Chapter.order already matches the plan)");
  }
  for (const move of moves) {
    console.log(`  ${formatChapter(move.chapter)}  ->  #${move.targetOrder}`);
  }
  console.log("");

  const supersededIds = superseded.map((chapter) => chapter.id);
  const supersededOrders = superseded.map((chapter) => chapter.order);
  console.log("== superseded chapters (no plan slot) ==");
  for (const chapter of superseded) {
    console.log(`  ${formatChapter(chapter)}  ${(chapter.content ?? "").length} chars  ${chapter.chapterStatus}/${chapter.generationState}`);
  }
  console.log("");

  const derived = supersededIds.length > 0
    ? await countDerived(supersededIds, supersededOrders)
    : null;
  if (derived) {
    console.log("== rows removed with them ==");
    console.log(`  CharacterTimeline           ${derived.timeline}  (explicit: keeps stale chapterOrder otherwise)`);
    console.log(`  NovelFactEntry              ${derived.facts}  (explicit: order-keyed, no FK)`);
    console.log(`  OpenConflict                ${derived.conflicts}  (explicit: order-keyed)`);
    console.log(`  ChapterArtifactSyncCheckpoint ${derived.checkpoints}  (FK cascade)`);
    console.log(`  ChapterSummary              ${derived.summaries}  (FK cascade)`);
    console.log(`  AuditReport                 ${derived.auditReports}  (FK cascade)`);
    console.log("== rows kept, chapterId set to NULL by the schema ==");
    console.log(`  QualityReport               ${derived.qualityReports}`);
    console.log(`  StoryPlan                   ${derived.storyPlans}`);
    console.log("");
  }

  if (!apply) {
    console.log("DRY RUN — re-run with --apply to execute.");
    return;
  }

  if (superseded.length > 0) {
    const exported = writeSupersededExport(superseded);
    console.log(`exported superseded prose -> ${exported.exportPath} (${exported.chars} chars)`);
    const written = fs.statSync(exported.exportPath).size;
    if (written === 0) {
      throw new Error("Export file is empty; aborting before any delete.");
    }
  }

  await prisma.$transaction(async (tx) => {
    if (supersededIds.length > 0) {
      await tx.characterTimeline.deleteMany({ where: { chapterId: { in: supersededIds } } });
      await tx.novelFactEntry.deleteMany({ where: { novelId, chapterOrder: { in: supersededOrders } } });
      await tx.openConflict.deleteMany({ where: { chapterId: { in: supersededIds } } });
      await tx.chapter.deleteMany({ where: { id: { in: supersededIds }, novelId } });
    }

    // Descending so the numbers never pile up on a slot that is still occupied.
    for (const move of moves) {
      await tx.chapter.update({
        where: { id: move.chapter.id },
        data: { order: move.targetOrder },
      });
      await tx.characterTimeline.updateMany({
        where: { chapterId: move.chapter.id },
        data: { chapterOrder: move.targetOrder },
      });
      await tx.openConflict.updateMany({
        where: { chapterId: move.chapter.id },
        data: { lastSeenChapterOrder: move.targetOrder },
      });
      await tx.novelFactEntry.updateMany({
        where: { novelId, chapterOrder: move.chapter.order },
        data: { chapterOrder: move.targetOrder },
      });
    }
  }, { timeout: 60_000 });

  console.log("applied.");

  const after = await loadState();
  const stillDrifting = after.bound.filter((item) => item.chapter.order !== item.targetOrder);
  console.log("");
  console.log("== verification ==");
  console.log(`  chapters=${after.chapters.length} orders=${after.chapters.map((chapter) => chapter.order).join(",")}`);
  console.log(`  unbound chapters: ${after.superseded.length}`);
  console.log(`  chapters still out of sync with their plan slot: ${stillDrifting.length}`);
  if (stillDrifting.length > 0) {
    throw new Error("Realignment did not converge.");
  }
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
