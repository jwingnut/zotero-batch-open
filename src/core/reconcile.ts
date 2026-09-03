// Pure candidate-selection, matching, and confirmation-copy logic for the
// "Attach newly saved files to the selected items" (reconcile) command.
// Kept free of Zotero globals so it is easy to unit test; plugin.ts supplies
// the real Items/attachment lookups and does the actual file moves + trash.

import {
  matchDuplicate,
  type MatchRule,
  type MatchResult,
} from "./duplicateMatch";

export type { MatchRule, MatchResult };

export interface ReconcileItem {
  id: number;
  libraryID: number;
  getField(field: string): string;
}

export interface CandidateFilterOptions<T> {
  /** Items to exclude outright (the original selection itself). */
  excludeIds: Set<number>;
  /** Only items in one of these libraries are eligible candidates. */
  libraryIDs: Set<number>;
  isTopLevelRegular: (item: T) => boolean;
  /** Milliseconds-since-epoch the item was added, or null if unknown/unparseable. */
  dateAddedMs: (item: T) => number | null;
  /** Only items added at or after this time are eligible. */
  windowStartMs: number;
}

/**
 * Filter the full item pool down to plausible connector-created duplicates:
 * top-level regular items, in one of the originals' libraries, added within
 * the reconcile window, excluding the selection itself.
 */
export function selectCandidates<T extends { id: number; libraryID: number }>(
  allItems: T[],
  opts: CandidateFilterOptions<T>,
): T[] {
  return allItems.filter((item) => {
    if (opts.excludeIds.has(item.id)) return false;
    if (!opts.libraryIDs.has(item.libraryID)) return false;
    if (!opts.isTopLevelRegular(item)) return false;
    const addedMs = opts.dateAddedMs(item);
    if (addedMs === null) return false;
    return addedMs >= opts.windowStartMs;
  });
}

export interface PlanEntry<T> {
  original: T;
  duplicate: T;
  match: MatchResult;
}

const RULE_PRIORITY: Record<MatchRule, number> = {
  doi: 0,
  identifier: 1,
  "title-year": 2,
};

/**
 * Match each original to at most one candidate duplicate (best rule first;
 * within "title-year", highest similarity wins), and each candidate to at
 * most one original — a duplicate already claimed by an earlier original is
 * not reconsidered.
 */
export function planReconciliation<T extends ReconcileItem>(
  originals: T[],
  candidates: T[],
): PlanEntry<T>[] {
  const consumed = new Set<number>();
  const plan: PlanEntry<T>[] = [];

  for (const original of originals) {
    let best: { candidate: T; match: MatchResult } | null = null;

    for (const candidate of candidates) {
      if (consumed.has(candidate.id) || candidate.id === original.id) {
        continue;
      }
      const match = matchDuplicate(original, candidate);
      if (!match) continue;

      const isBetter =
        !best ||
        RULE_PRIORITY[match.rule] < RULE_PRIORITY[best.match.rule] ||
        (match.rule === best.match.rule &&
          match.rule === "title-year" &&
          (match.similarity ?? 0) > (best.match.similarity ?? 0));

      if (isBetter) {
        best = { candidate, match };
      }
    }

    if (best) {
      consumed.add(best.candidate.id);
      plan.push({ original, duplicate: best.candidate, match: best.match });
    }
  }

  return plan;
}

/**
 * Parse a Zotero `dateAdded` field value ("YYYY-MM-DD HH:MM:SS", stored in
 * UTC) into milliseconds since epoch. Returns null for anything unparseable.
 */
export function parseZoteroDateAddedMs(
  value: string | null | undefined,
): number | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const iso = trimmed.includes("T") ? trimmed : trimmed.replace(" ", "T");
  const withZone = /Z$|[+-]\d{2}:?\d{2}$/.test(iso) ? iso : `${iso}Z`;
  const ms = Date.parse(withZone);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * The exact confirmation message for the reconcile command — names what
 * will happen (never a bare "Are you sure?").
 */
export function reconcileConfirmMessage(
  filesMoved: number,
  itemsReceiving: number,
  duplicatesToTrash: number,
): string {
  const file = filesMoved === 1 ? "file" : "files";
  const item = itemsReceiving === 1 ? "item" : "items";
  const duplicate =
    duplicatesToTrash === 1 ? "duplicate item" : "duplicate items";
  return `Attach ${filesMoved} ${file} to ${itemsReceiving} ${item} and move ${duplicatesToTrash} ${duplicate} to the trash?`;
}
