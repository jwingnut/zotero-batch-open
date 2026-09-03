import { describe, it, expect } from "vitest";
import {
  parseZoteroDateAddedMs,
  planReconciliation,
  reconcileConfirmMessage,
  resolveAllItems,
  selectCandidates,
  type ReconcileItem,
} from "./reconcile";

function item(
  id: number,
  libraryID: number,
  fields: Partial<Record<"DOI" | "extra" | "date" | "title", string>>,
): ReconcileItem {
  return {
    id,
    libraryID,
    getField: (field: string) =>
      (fields as Record<string, string>)[field] ?? "",
  };
}

describe("parseZoteroDateAddedMs", () => {
  it("parses a Zotero dateAdded string as UTC", () => {
    const ms = parseZoteroDateAddedMs("2024-01-01 12:00:00");
    expect(ms).toBe(Date.parse("2024-01-01T12:00:00Z"));
  });

  it("returns null for empty or missing input", () => {
    expect(parseZoteroDateAddedMs("")).toBeNull();
    expect(parseZoteroDateAddedMs(undefined)).toBeNull();
    expect(parseZoteroDateAddedMs(null)).toBeNull();
  });

  it("returns null for unparseable input", () => {
    expect(parseZoteroDateAddedMs("not a date")).toBeNull();
  });
});

describe("resolveAllItems", () => {
  it("awaits a promise-returning fetch and returns the resolved array", async () => {
    const items = [item(1, 1, {})];
    const result = await resolveAllItems(() => Promise.resolve(items));
    expect(result).toBe(items);
  });

  it("returns a synchronously-returned array as-is", async () => {
    const items = [item(1, 1, {})];
    const result = await resolveAllItems(() => items);
    expect(result).toBe(items);
  });

  it("throws a descriptive Error (not a bare TypeError) for a non-array result", async () => {
    // e.g. what Zotero.Items.getAll() returns when called with no
    // libraryID -- a Promise that resolves to something unexpected, or
    // (mocked here) a plain object instead of an array.
    await expect(
      resolveAllItems(
        () => ({ not: "an array" }) as unknown as ReconcileItem[],
      ),
    ).rejects.toThrow(/did not return an array \(got object\)/);
  });

  it("throws a descriptive Error for a null result", async () => {
    await expect(
      resolveAllItems(() => null as unknown as ReconcileItem[]),
    ).rejects.toThrow(/did not return an array \(got null\)/);
  });

  it("throws a descriptive Error when the resolved promise is not an array", async () => {
    await expect(
      resolveAllItems(() =>
        Promise.resolve(undefined as unknown as ReconcileItem[]),
      ),
    ).rejects.toThrow(/did not return an array \(got undefined\)/);
  });

  it("never throws a bare TypeError like 'x.filter is not a function'", async () => {
    let caught: unknown;
    try {
      await resolveAllItems(() => 42 as unknown as ReconcileItem[]);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(caught).not.toBeInstanceOf(TypeError);
  });
});

describe("selectCandidates", () => {
  const now = Date.parse("2024-01-01T12:00:00Z");

  function candidate(id: number, libraryID: number, addedMinutesAgo: number) {
    return {
      id,
      libraryID,
      addedMs: now - addedMinutesAgo * 60 * 1000,
    };
  }

  it("excludes the selection itself, other libraries, and items outside the window", () => {
    const items = [
      candidate(1, 1, 5), // selected item itself
      candidate(2, 1, 10), // in window, same library — eligible
      candidate(3, 2, 5), // different library — excluded
      candidate(4, 1, 300), // too old — excluded
    ];

    const result = selectCandidates(items, {
      excludeIds: new Set([1]),
      libraryIDs: new Set([1]),
      isTopLevelRegular: () => true,
      dateAddedMs: (i) => i.addedMs,
      windowStartMs: now - 120 * 60 * 1000,
    });

    expect(result.map((i) => i.id)).toEqual([2]);
  });

  it("excludes items that are not top-level regular items", () => {
    const items = [candidate(1, 1, 5)];
    const result = selectCandidates(items, {
      excludeIds: new Set(),
      libraryIDs: new Set([1]),
      isTopLevelRegular: () => false,
      dateAddedMs: (i) => i.addedMs,
      windowStartMs: now - 120 * 60 * 1000,
    });
    expect(result).toEqual([]);
  });

  it("excludes items whose dateAdded can't be determined", () => {
    const items = [candidate(1, 1, 5)];
    const result = selectCandidates(items, {
      excludeIds: new Set(),
      libraryIDs: new Set([1]),
      isTopLevelRegular: () => true,
      dateAddedMs: () => null,
      windowStartMs: now - 120 * 60 * 1000,
    });
    expect(result).toEqual([]);
  });
});

describe("planReconciliation", () => {
  it("matches each original to its best candidate and consumes that candidate", () => {
    const original1 = item(1, 1, { DOI: "10.1/a", title: "A" });
    const original2 = item(2, 1, { extra: "PMID: 999", title: "B" });
    const dup1 = item(10, 1, { DOI: "10.1/a", title: "A copy" });
    const dup2 = item(11, 1, { extra: "PMID: 999", title: "B copy" });

    const plan = planReconciliation([original1, original2], [dup1, dup2]);

    expect(plan).toHaveLength(2);
    expect(plan[0]).toMatchObject({ original: original1, duplicate: dup1 });
    expect(plan[0].match.rule).toBe("doi");
    expect(plan[1]).toMatchObject({ original: original2, duplicate: dup2 });
    expect(plan[1].match.rule).toBe("identifier");
  });

  it("does not match the same candidate to two originals", () => {
    const original1 = item(1, 1, { DOI: "10.1/shared" });
    const original2 = item(2, 1, { DOI: "10.1/shared" });
    const dup = item(10, 1, { DOI: "10.1/shared" });

    const plan = planReconciliation([original1, original2], [dup]);

    expect(plan).toHaveLength(1);
    expect(plan[0].original).toBe(original1);
  });

  it("produces no entry for an original with no matching candidate", () => {
    const original = item(1, 1, { title: "Unique Thing", date: "2020" });
    const dup = item(10, 1, { title: "Something Else Entirely", date: "1999" });

    expect(planReconciliation([original], [dup])).toEqual([]);
  });
});

describe("reconcileConfirmMessage", () => {
  it("names the exact counts of files, items, and duplicates trashed", () => {
    expect(reconcileConfirmMessage(12, 12, 12)).toBe(
      "Attach 12 files to 12 items and move 12 duplicate items to the trash?",
    );
  });

  it("pluralizes correctly for singular counts", () => {
    expect(reconcileConfirmMessage(1, 1, 1)).toBe(
      "Attach 1 file to 1 item and move 1 duplicate item to the trash?",
    );
  });

  it("handles files moved differing from items receiving them", () => {
    expect(reconcileConfirmMessage(3, 2, 2)).toBe(
      "Attach 3 files to 2 items and move 2 duplicate items to the trash?",
    );
  });
});
