// Pure duplicate-matching logic for the "Attach newly saved files to the
// selected items" (reconcile) command. Kept free of Zotero globals so it is
// easy to unit test — see reconcile.ts for how this is used against a real
// candidate pool.

import { normalizeDoi } from "./urlResolution";

/** Minimal shape of an item needed to compare it against another for matching. */
export interface MatchableItem {
  id: number;
  getField(field: string): string;
}

export type MatchRule = "doi" | "identifier" | "title-year";

export interface MatchResult {
  rule: MatchRule;
  /** Only set for a "title-year" match. */
  similarity?: number;
}

/**
 * How close two normalized titles must be (1 = identical) to accept a
 * title+year match. Deliberately strict: a wrong merge loses data, so a
 * loose fuzzy match is not acceptable here.
 */
export const TITLE_SIMILARITY_THRESHOLD = 0.95;

const LEADING_ARTICLE = /^(a|an|the)\s+/i;

/** Case-fold, strip punctuation and a leading article, collapse whitespace. */
export function normalizeTitle(title: string | null | undefined): string {
  return (title ?? "")
    .toLowerCase()
    .replace(LEADING_ARTICLE, "")
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

function levenshteinDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;

  const row = new Array<number>(n + 1);
  for (let j = 0; j <= n; j++) row[j] = j;

  for (let i = 1; i <= m; i++) {
    let prevDiag = row[0];
    row[0] = i;
    for (let j = 1; j <= n; j++) {
      const temp = row[j];
      row[j] =
        a[i - 1] === b[j - 1]
          ? prevDiag
          : 1 + Math.min(prevDiag, row[j], row[j - 1]);
      prevDiag = temp;
    }
  }

  return row[n];
}

/** Normalized similarity of two titles in [0, 1]; 1 = identical after normalization. */
export function titleSimilarity(
  a: string | null | undefined,
  b: string | null | undefined,
): number {
  const na = normalizeTitle(a);
  const nb = normalizeTitle(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;

  const distance = levenshteinDistance(na, nb);
  const maxLen = Math.max(na.length, nb.length);
  return maxLen === 0 ? 1 : 1 - distance / maxLen;
}

/** First 4-digit year found in a Zotero "date" field value. */
export function extractYear(
  dateField: string | null | undefined,
): string | null {
  const match = /\d{4}/.exec(dateField ?? "");
  return match ? match[0] : null;
}

export interface ExternalIdentifier {
  type: "pmid" | "arxiv";
  value: string;
}

/** PMID or arXiv id, as recorded in a Zotero item's "Extra" field. */
export function extractIdentifier(
  extraField: string | null | undefined,
): ExternalIdentifier | null {
  const text = extraField ?? "";

  const pmid = /(?:^|\n)\s*PMID:\s*(\d+)/i.exec(text);
  if (pmid) {
    return { type: "pmid", value: pmid[1] };
  }

  const arxiv = /(?:^|\n)\s*arXiv:\s*([\w./-]+)/i.exec(text);
  if (arxiv) {
    return { type: "arxiv", value: arxiv[1].toLowerCase() };
  }

  return null;
}

/**
 * Compare an original item to one candidate duplicate, in priority order:
 * normalized DOI, then PMID/arXiv id, then title similarity + matching year.
 * Returns null when nothing matches confidently enough to merge.
 */
export function matchDuplicate(
  original: MatchableItem,
  candidate: MatchableItem,
): MatchResult | null {
  const doiA = normalizeDoi(original.getField("DOI") ?? "").toLowerCase();
  const doiB = normalizeDoi(candidate.getField("DOI") ?? "").toLowerCase();
  if (doiA && doiB && doiA === doiB) {
    return { rule: "doi" };
  }

  const idA = extractIdentifier(original.getField("extra"));
  const idB = extractIdentifier(candidate.getField("extra"));
  if (
    idA &&
    idB &&
    idA.type === idB.type &&
    idA.value.toLowerCase() === idB.value.toLowerCase()
  ) {
    return { rule: "identifier" };
  }

  const yearA = extractYear(original.getField("date"));
  const yearB = extractYear(candidate.getField("date"));
  if (yearA && yearB && yearA === yearB) {
    const similarity = titleSimilarity(
      original.getField("title"),
      candidate.getField("title"),
    );
    if (similarity >= TITLE_SIMILARITY_THRESHOLD) {
      return { rule: "title-year", similarity };
    }
  }

  return null;
}
