import { describe, it, expect, beforeEach } from "vitest";
import { BatchOpenPlugin } from "@/plugin";

interface FakeAttachment {
  id: number;
  key: string;
  libraryID: number;
  parentID: number | undefined;
  attachmentContentType: string;
  attachmentLinkMode: number;
  isRegularItem: () => boolean;
  isTopLevelItem: () => boolean;
  isAttachment: () => boolean;
  getAttachments: () => number[];
  getField: (field: string) => string;
  getCreators: () => Array<{ lastName?: string }>;
  save: () => Promise<void>;
  saveTx: () => Promise<void>;
}

interface FakeRegularItem {
  id: number;
  key: string;
  libraryID: number;
  parentID: number | undefined;
  attachmentIds: number[];
  isRegularItem: () => boolean;
  isTopLevelItem: () => boolean;
  isAttachment: () => boolean;
  getAttachments: () => number[];
  getField: (field: string) => string;
  getCreators: () => Array<{ lastName?: string }>;
  save: () => Promise<void>;
  saveTx: () => Promise<void>;
}

const LINKED_URL = 3;
const IMPORTED_FILE = 0;

let nextId = 1;
const registry = new Map<number, FakeRegularItem | FakeAttachment>();

function reset(): void {
  nextId = 1;
  registry.clear();
}

function nowAsZoteroDateAdded(): string {
  return new Date()
    .toISOString()
    .replace("T", " ")
    .replace(/\.\d+Z$/, "");
}

function makeItem(fields: {
  libraryID?: number;
  title?: string;
  DOI?: string;
  extra?: string;
  date?: string;
  dateAdded?: string;
  key?: string;
}): FakeRegularItem {
  const id = nextId++;
  const item: FakeRegularItem = {
    id,
    key: fields.key ?? `KEY${id}`,
    libraryID: fields.libraryID ?? 1,
    parentID: undefined,
    attachmentIds: [],
    isRegularItem: () => true,
    isTopLevelItem: () => true,
    isAttachment: () => false,
    getAttachments: () => item.attachmentIds,
    getField: (field: string) => {
      if (field === "title") return fields.title ?? "";
      if (field === "DOI") return fields.DOI ?? "";
      if (field === "extra") return fields.extra ?? "";
      if (field === "date") return fields.date ?? "";
      if (field === "dateAdded")
        return fields.dateAdded ?? nowAsZoteroDateAdded();
      return "";
    },
    getCreators: () => [],
    save: async () => {},
    saveTx: async () => {},
  };
  registry.set(id, item);
  return item;
}

function attachTo(
  parent: FakeRegularItem,
  opts: { contentType?: string; linkMode?: number } = {},
): FakeAttachment {
  const id = nextId++;
  const attachment: FakeAttachment = {
    id,
    key: `ATT${id}`,
    libraryID: parent.libraryID,
    parentID: parent.id,
    attachmentContentType: opts.contentType ?? "application/pdf",
    attachmentLinkMode: opts.linkMode ?? IMPORTED_FILE,
    isRegularItem: () => false,
    isTopLevelItem: () => false,
    isAttachment: () => true,
    getAttachments: () => [],
    getField: () => "",
    getCreators: () => [],
    save: async () => {},
    saveTx: async () => {
      // Mirror a real Zotero save: persist whatever parentID is currently set.
    },
  };
  registry.set(id, attachment);
  parent.attachmentIds.push(id);
  return attachment;
}

function installRegistry(): void {
  (Zotero.Items as unknown as { get: (id: number) => unknown }).get = (
    id: number,
  ) => registry.get(id) ?? null;
  (Zotero.Items as unknown as { getAll: () => unknown[] }).getAll = () =>
    Array.from(registry.values()).filter((i) => "attachmentIds" in i);
  (
    Zotero.Items as unknown as {
      trash: (ids: number | number[]) => Promise<void>;
    }
  ).trash = async (ids: number | number[]) => {
    const list = Array.isArray(ids) ? ids : [ids];
    for (const id of list) {
      const found = registry.get(id) as { __trashed?: boolean } | undefined;
      if (found) found.__trashed = true;
    }
  };
}

function setPane(items: unknown[]): void {
  (
    Zotero as unknown as { getActiveZoteroPane: () => unknown }
  ).getActiveZoteroPane = () => ({ getSelectedItems: () => items });
}

function isTrashed(id: number): boolean {
  return Boolean(
    (registry.get(id) as { __trashed?: boolean } | undefined)?.__trashed,
  );
}

beforeEach(() => {
  reset();
  installRegistry();
  Zotero.Prefs.set("extensions.zotero.batchopen.reconcileWindowMinutes", 120);
  (globalThis as unknown as { __confirmExResult: number }).__confirmExResult =
    0; // OK
});

function plugin(): {
  runCommand(kind: "reconcile" | "open-missing-pdf"): Promise<void>;
} {
  return new BatchOpenPlugin() as unknown as {
    runCommand(kind: "reconcile" | "open-missing-pdf"): Promise<void>;
  };
}

describe("reconcile — attachment reassignment", () => {
  it("moves a duplicate's stored PDF onto the original and trashes the duplicate", async () => {
    const original = makeItem({
      title: "Vegetation Along Highways",
      DOI: "10.1/x",
    });
    const duplicate = makeItem({
      title: "Vegetation Along Highways copy",
      DOI: "10.1/x",
    });
    const pdf = attachTo(duplicate);

    setPane([original]);
    await plugin().runCommand("reconcile");

    expect(pdf.parentID).toBe(original.id);
    expect(original.attachmentIds).not.toContain(pdf.id); // moved via parentID, not tracked here
    expect(isTrashed(duplicate.id)).toBe(true);
  });

  it("does not permanently delete the duplicate (moves to trash, reversible)", async () => {
    const original = makeItem({ DOI: "10.1/y" });
    const duplicate = makeItem({ DOI: "10.1/y" });
    attachTo(duplicate);

    setPane([original]);
    await plugin().runCommand("reconcile");

    // The duplicate is still present in the registry (not erased), only trashed.
    expect(registry.has(duplicate.id)).toBe(true);
    expect(isTrashed(duplicate.id)).toBe(true);
  });

  it("never touches an original's existing attachments", async () => {
    const original = makeItem({ DOI: "10.1/z" });
    const existingPdf = attachTo(original);
    const duplicate = makeItem({ DOI: "10.1/z" });
    const newPdf = attachTo(duplicate);

    setPane([original]);
    await plugin().runCommand("reconcile");

    expect(existingPdf.parentID).toBe(original.id);
    expect(original.attachmentIds).toContain(existingPdf.id);
    expect(newPdf.parentID).toBe(original.id);
  });

  it("leaves a non-file (linked-URL) attachment on the duplicate alone", async () => {
    const original = makeItem({ DOI: "10.1/w" });
    const duplicate = makeItem({ DOI: "10.1/w" });
    const pdf = attachTo(duplicate);
    const weblink = attachTo(duplicate, {
      contentType: "text/html",
      linkMode: LINKED_URL,
    });

    setPane([original]);
    await plugin().runCommand("reconcile");

    expect(pdf.parentID).toBe(original.id);
    expect(weblink.parentID).toBe(duplicate.id); // not moved
  });

  it("does nothing when no duplicate is found within the window", async () => {
    const original = makeItem({ DOI: "10.1/lonely" });
    setPane([original]);
    await expect(plugin().runCommand("reconcile")).resolves.toBeUndefined();
  });

  it("does not reconcile when the user cancels the confirmation", async () => {
    (globalThis as unknown as { __confirmExResult: number }).__confirmExResult =
      1; // Cancel
    const original = makeItem({ DOI: "10.1/cancel" });
    const duplicate = makeItem({ DOI: "10.1/cancel" });
    const pdf = attachTo(duplicate);

    setPane([original]);
    await plugin().runCommand("reconcile");

    expect(pdf.parentID).toBe(duplicate.id);
    expect(isTrashed(duplicate.id)).toBe(false);
  });
});

describe("reconcile — match rules via the full command", () => {
  it("matches on title + year when there is no DOI or identifier", async () => {
    const original = makeItem({ title: "Roads and Ecology", date: "2020" });
    const duplicate = makeItem({ title: "roads and ecology", date: "2020-03" });
    const pdf = attachTo(duplicate);

    setPane([original]);
    await plugin().runCommand("reconcile");

    expect(pdf.parentID).toBe(original.id);
    expect(isTrashed(duplicate.id)).toBe(true);
  });

  it("does NOT match a title near-miss even with a matching year", async () => {
    const original = makeItem({
      title: "Deep Learning for Vision",
      date: "2020",
    });
    const duplicate = makeItem({
      title: "Deep Learning for Vision Systems",
      date: "2020",
    });
    const pdf = attachTo(duplicate);

    setPane([original]);
    await plugin().runCommand("reconcile");

    expect(pdf.parentID).toBe(duplicate.id); // untouched — no false merge
    expect(isTrashed(duplicate.id)).toBe(false);
  });

  it("excludes candidates outside the reconcile window", async () => {
    Zotero.Prefs.set("extensions.zotero.batchopen.reconcileWindowMinutes", 5);
    const original = makeItem({ DOI: "10.1/stale" });
    const duplicate = makeItem({
      DOI: "10.1/stale",
      dateAdded: "2000-01-01 00:00:00",
    });
    const pdf = attachTo(duplicate);

    setPane([original]);
    await plugin().runCommand("reconcile");

    expect(pdf.parentID).toBe(duplicate.id);
    expect(isTrashed(duplicate.id)).toBe(false);
  });
});

describe("missing-PDF filter — full command", () => {
  it("opens only items without a stored PDF", async () => {
    const withPdf = makeItem({ title: "Has PDF" });
    attachTo(withPdf, {
      contentType: "application/pdf",
      linkMode: IMPORTED_FILE,
    });
    const withoutPdf = makeItem({ title: "No PDF" });

    setPane([withPdf, withoutPdf]);
    await plugin().runCommand("open-missing-pdf");

    expect(
      (globalThis as unknown as { __launchURLCalls: string[] })
        .__launchURLCalls,
    ).toHaveLength(1);
  });

  it("does not count a linked-URL attachment as a stored PDF", async () => {
    const linkedOnly = makeItem({ title: "Linked Only" });
    attachTo(linkedOnly, {
      contentType: "application/pdf",
      linkMode: LINKED_URL,
    });

    setPane([linkedOnly]);
    await plugin().runCommand("open-missing-pdf");

    // No stored PDF, so it should still be opened (fallback to Scholar search).
    expect(
      (globalThis as unknown as { __launchURLCalls: string[] })
        .__launchURLCalls,
    ).toHaveLength(1);
  });
});
