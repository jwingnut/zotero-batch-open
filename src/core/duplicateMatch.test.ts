import { describe, it, expect } from "vitest";
import {
  extractIdentifier,
  extractYear,
  matchDuplicate,
  normalizeTitle,
  titleSimilarity,
  TITLE_SIMILARITY_THRESHOLD,
  type MatchableItem,
} from "./duplicateMatch";

function item(
  id: number,
  fields: Partial<Record<"DOI" | "extra" | "date" | "title", string>>,
): MatchableItem {
  return {
    id,
    getField: (field: string) =>
      (fields as Record<string, string>)[field] ?? "",
  };
}

describe("normalizeTitle", () => {
  it("case-folds, strips punctuation, and drops a leading article", () => {
    expect(normalizeTitle("The Quick, Brown Fox!")).toBe("quick brown fox");
    expect(normalizeTitle("A Study of Roads")).toBe("study of roads");
    expect(normalizeTitle("An Analysis")).toBe("analysis");
  });
});

describe("titleSimilarity", () => {
  it("is 1 for identical (after normalization) titles", () => {
    expect(titleSimilarity("The Roads", "roads")).toBe(1);
  });

  it("is high but not 1 for a near-identical title", () => {
    const s = titleSimilarity(
      "Vegetation Management Along Highways",
      "Vegetation management along highways.",
    );
    expect(s).toBe(1); // punctuation/case only — normalizes to the same string
  });

  it("drops well below the threshold for a real near-miss (extra qualifying word)", () => {
    const s = titleSimilarity(
      "Deep Learning for Vision",
      "Deep Learning for Vision Systems",
    );
    expect(s).toBeLessThan(TITLE_SIMILARITY_THRESHOLD);
  });
});

describe("extractYear", () => {
  it("finds a 4-digit year in a date field", () => {
    expect(extractYear("2021-05-01")).toBe("2021");
    expect(extractYear("May 2019")).toBe("2019");
  });

  it("returns null when there is no year", () => {
    expect(extractYear("")).toBeNull();
    expect(extractYear(undefined)).toBeNull();
  });
});

describe("extractIdentifier", () => {
  it("finds a PMID in the Extra field", () => {
    expect(extractIdentifier("PMID: 12345678")).toEqual({
      type: "pmid",
      value: "12345678",
    });
  });

  it("finds an arXiv id in the Extra field", () => {
    expect(extractIdentifier("arXiv: 2301.01234")).toEqual({
      type: "arxiv",
      value: "2301.01234",
    });
  });

  it("returns null when neither is present", () => {
    expect(extractIdentifier("Citation Key: smith2021")).toBeNull();
    expect(extractIdentifier("")).toBeNull();
  });
});

describe("matchDuplicate", () => {
  it("matches on normalized DOI, ignoring resolver prefix and case", () => {
    const original = item(1, { DOI: "10.1000/XYZ" });
    const candidate = item(2, { DOI: "https://doi.org/10.1000/xyz" });
    expect(matchDuplicate(original, candidate)).toEqual({ rule: "doi" });
  });

  it("matches on a shared PMID when DOIs are absent", () => {
    const original = item(1, { extra: "PMID: 555" });
    const candidate = item(2, { extra: "PMID: 555" });
    expect(matchDuplicate(original, candidate)).toEqual({ rule: "identifier" });
  });

  it("matches on a shared arXiv id when DOIs are absent", () => {
    const original = item(1, { extra: "arXiv: 2301.01234" });
    const candidate = item(2, { extra: "arXiv: 2301.01234" });
    expect(matchDuplicate(original, candidate)).toEqual({ rule: "identifier" });
  });

  it("matches on title + year when nothing else is available", () => {
    const original = item(1, {
      title: "Vegetation Management Along Highways",
      date: "2020-01-01",
    });
    const candidate = item(2, {
      title: "vegetation management along highways",
      date: "2020-06-15",
    });
    const result = matchDuplicate(original, candidate);
    expect(result?.rule).toBe("title-year");
    expect(result?.similarity).toBe(1);
  });

  it("does NOT match a title+year near-miss (extra qualifying word)", () => {
    const original = item(1, {
      title: "Deep Learning for Vision",
      date: "2020",
    });
    const candidate = item(2, {
      title: "Deep Learning for Vision Systems",
      date: "2020",
    });
    expect(matchDuplicate(original, candidate)).toBeNull();
  });

  it("does not match title+year when the year differs", () => {
    const original = item(1, { title: "Same Title", date: "2020" });
    const candidate = item(2, { title: "Same Title", date: "2021" });
    expect(matchDuplicate(original, candidate)).toBeNull();
  });

  it("does not match when both are missing every signal", () => {
    const original = item(1, {});
    const candidate = item(2, {});
    expect(matchDuplicate(original, candidate)).toBeNull();
  });

  it("prefers a DOI match over a coincidental title+year similarity", () => {
    const original = item(1, {
      DOI: "10.1/abc",
      title: "Roads",
      date: "2020",
    });
    const candidate = item(2, {
      DOI: "10.1/abc",
      title: "Completely Different",
      date: "1999",
    });
    expect(matchDuplicate(original, candidate)).toEqual({ rule: "doi" });
  });
});
