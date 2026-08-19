import type { VolumeChapterPlan, VolumePlan } from "@ai-novel/shared/types/novel";

export interface CanonicalChapterRow {
  id: string;
  order: number;
  title: string;
  expectation?: string | null;
  targetWordCount?: number | null;
  conflictLevel?: number | null;
  revealLevel?: number | null;
  mustAvoid?: string | null;
  taskSheet?: string | null;
  sceneCards?: string | null;
}

export interface MirroredChapterInput {
  id?: string | null;
  order: number;
  title: string;
  expectation?: string | null;
  targetWordCount?: number | null;
  conflictLevel?: number | null;
  revealLevel?: number | null;
  mustAvoid?: string | null;
  taskSheet?: string | null;
  sceneCards?: string | null;
}

export interface WorkspaceChapterMirrorResult {
  volumes: VolumePlan[];
  changed: boolean;
  /**
   * True when the canonical chapter orders could not be adopted because doing so would
   * put two workspace chapters on the same `chapterOrder`. The workspace orders are kept
   * as they are in that case; only the content fields are mirrored.
   */
  orderConflict: boolean;
}

function listWorkspaceChapters(volumes: VolumePlan[]): VolumeChapterPlan[] {
  return volumes.flatMap((volume) => volume.chapters);
}

function resolveConflictLevelSource(chapter: VolumeChapterPlan): VolumeChapterPlan["conflictLevelSource"] {
  return chapter.conflictLevelSource === "user" ? "user" : "ai";
}

/**
 * Pair every workspace chapter with at most one canonical `Chapter` row.
 *
 * An explicit `chapterId` binding always wins, and a row can only be claimed once, so two
 * workspace chapters can never resolve to the same row. Without that guarantee a workspace
 * whose plan drifted ahead of the chapter list (for example when the plan inserted chapters
 * before already written ones) resolves the same row twice and produces duplicate
 * `chapterOrder` values, which the `(volumeId, chapterOrder)` unique index rejects.
 */
export function resolveCanonicalChapterRows(
  volumes: VolumePlan[],
  rows: CanonicalChapterRow[],
): Map<string, CanonicalChapterRow> {
  const rowById = new Map(rows.map((row) => [row.id, row] as const));
  const rowByOrder = new Map(rows.map((row) => [row.order, row] as const));
  const claimedRowIds = new Set<string>();
  const resolved = new Map<string, CanonicalChapterRow>();
  const chapters = listWorkspaceChapters(volumes);

  for (const chapter of chapters) {
    if (!chapter.chapterId) {
      continue;
    }
    const row = rowById.get(chapter.chapterId);
    if (!row || claimedRowIds.has(row.id)) {
      continue;
    }
    claimedRowIds.add(row.id);
    resolved.set(chapter.id, row);
  }

  for (const chapter of chapters) {
    if (resolved.has(chapter.id)) {
      continue;
    }
    const row = rowByOrder.get(chapter.chapterOrder);
    if (!row || claimedRowIds.has(row.id)) {
      continue;
    }
    claimedRowIds.add(row.id);
    resolved.set(chapter.id, row);
  }

  return resolved;
}

/**
 * Mirror the canonical `Chapter` rows back into the volume workspace.
 *
 * Content fields are always adopted; `chapterOrder` is only adopted when the resulting
 * assignment stays collision free, because the workspace plan — not the chapter list — owns
 * the planned ordering and duplicate orders cannot be persisted.
 */
export function hydrateVolumesFromCanonicalChapters(
  volumes: VolumePlan[],
  rows: CanonicalChapterRow[],
): WorkspaceChapterMirrorResult {
  if (rows.length === 0) {
    return { volumes, changed: false, orderConflict: false };
  }

  const resolved = resolveCanonicalChapterRows(volumes, rows);
  if (resolved.size === 0) {
    return { volumes, changed: false, orderConflict: false };
  }

  const desiredOrders = listWorkspaceChapters(volumes)
    .map((chapter) => resolved.get(chapter.id)?.order ?? chapter.chapterOrder);
  const canAdoptOrders = new Set(desiredOrders).size === desiredOrders.length;

  let changed = false;
  const nextVolumes = volumes.map((volume) => {
    let volumeChanged = false;
    const chapters = volume.chapters.map((chapter) => {
      const row = resolved.get(chapter.id);
      if (!row) {
        return chapter;
      }
      const nextChapter: VolumeChapterPlan = {
        ...chapter,
        chapterId: row.id,
        chapterOrder: canAdoptOrders ? row.order : chapter.chapterOrder,
        title: row.title,
        summary: row.expectation?.trim() || chapter.summary,
        targetWordCount: row.targetWordCount ?? null,
        conflictLevel: chapter.conflictLevelSource === "user"
          ? chapter.conflictLevel ?? null
          : row.conflictLevel ?? null,
        conflictLevelSource: resolveConflictLevelSource(chapter),
        revealLevel: row.revealLevel ?? null,
        mustAvoid: row.mustAvoid ?? null,
        taskSheet: row.taskSheet ?? null,
        sceneCards: row.sceneCards ?? null,
      };
      if (JSON.stringify(nextChapter) === JSON.stringify(chapter)) {
        return chapter;
      }
      volumeChanged = true;
      changed = true;
      return nextChapter;
    });
    return volumeChanged ? { ...volume, chapters } : volume;
  });

  return {
    volumes: changed ? nextVolumes : volumes,
    changed,
    orderConflict: !canAdoptOrders,
  };
}

/**
 * Write a single created or updated chapter back into the volume workspace.
 *
 * Exactly one workspace chapter is targeted: the one already bound to this chapter id, or
 * else a free slot sitting at the same order. Matching on "same id OR same order" would hit
 * two different workspace chapters whenever a chapter moved, and give both of them the same
 * `chapterOrder`.
 */
export function applyMirroredChapterToVolumes(
  volumes: VolumePlan[],
  chapter: MirroredChapterInput,
): WorkspaceChapterMirrorResult {
  const chapters = listWorkspaceChapters(volumes);
  const boundTarget = chapter.id
    ? chapters.find((item) => item.chapterId === chapter.id) ?? null
    : null;
  const target = boundTarget
    ?? chapters.find((item) => item.chapterOrder === chapter.order && !item.chapterId)
    ?? null;
  if (!target) {
    return { volumes, changed: false, orderConflict: false };
  }

  const orderTaken = chapters.some((item) => item.id !== target.id && item.chapterOrder === chapter.order);
  let changed = false;
  const nextVolumes = volumes.map((volume) => {
    if (!volume.chapters.some((item) => item.id === target.id)) {
      return volume;
    }
    let volumeChanged = false;
    const nextChapters = volume.chapters.map((item) => {
      if (item.id !== target.id) {
        return item;
      }
      const nextChapter: VolumeChapterPlan = {
        ...item,
        chapterId: chapter.id ?? item.chapterId ?? null,
        chapterOrder: orderTaken ? item.chapterOrder : chapter.order,
        title: chapter.title,
        summary: chapter.expectation?.trim() || item.summary,
        targetWordCount: chapter.targetWordCount ?? null,
        conflictLevel: item.conflictLevelSource === "user"
          ? item.conflictLevel ?? null
          : chapter.conflictLevel ?? null,
        conflictLevelSource: resolveConflictLevelSource(item),
        revealLevel: chapter.revealLevel ?? null,
        mustAvoid: chapter.mustAvoid ?? null,
        taskSheet: chapter.taskSheet ?? null,
        sceneCards: chapter.sceneCards ?? null,
      };
      if (JSON.stringify(nextChapter) === JSON.stringify(item)) {
        return item;
      }
      volumeChanged = true;
      changed = true;
      return nextChapter;
    });
    return volumeChanged ? { ...volume, chapters: nextChapters } : volume;
  });

  return {
    volumes: changed ? nextVolumes : volumes,
    changed,
    orderConflict: orderTaken,
  };
}
