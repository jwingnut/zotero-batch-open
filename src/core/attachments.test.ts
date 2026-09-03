import { describe, it, expect } from "vitest";
import {
  hasStoredPdf,
  isFileAttachment,
  splitByMissingPdf,
} from "./attachments";

const LINKED_URL = 3;
const IMPORTED_FILE = 0;

describe("isFileAttachment", () => {
  it("treats a stored/imported file as a file attachment", () => {
    expect(
      isFileAttachment({ attachmentLinkMode: IMPORTED_FILE }, LINKED_URL),
    ).toBe(true);
  });

  it("does not treat a linked-URL attachment as a file attachment", () => {
    expect(
      isFileAttachment({ attachmentLinkMode: LINKED_URL }, LINKED_URL),
    ).toBe(false);
  });

  it("treats an attachment with no link mode as not a file", () => {
    expect(isFileAttachment({}, LINKED_URL)).toBe(false);
  });
});

describe("hasStoredPdf", () => {
  it("is true when a stored/imported PDF is present", () => {
    expect(
      hasStoredPdf(
        [
          {
            attachmentContentType: "application/pdf",
            attachmentLinkMode: IMPORTED_FILE,
          },
        ],
        LINKED_URL,
      ),
    ).toBe(true);
  });

  it("is false for a linked-URL PDF (not actually stored)", () => {
    expect(
      hasStoredPdf(
        [
          {
            attachmentContentType: "application/pdf",
            attachmentLinkMode: LINKED_URL,
          },
        ],
        LINKED_URL,
      ),
    ).toBe(false);
  });

  it("is false when the stored attachment is not a PDF", () => {
    expect(
      hasStoredPdf(
        [
          {
            attachmentContentType: "text/html",
            attachmentLinkMode: IMPORTED_FILE,
          },
        ],
        LINKED_URL,
      ),
    ).toBe(false);
  });

  it("is false with no attachments", () => {
    expect(hasStoredPdf([], LINKED_URL)).toBe(false);
  });
});

describe("splitByMissingPdf", () => {
  it("keeps items without a stored PDF and counts those that have one", () => {
    const items = ["a", "b", "c"];
    const attachmentsByItem: Record<string, ReturnType<typeof Array>> = {
      a: [
        {
          attachmentContentType: "application/pdf",
          attachmentLinkMode: IMPORTED_FILE,
        },
      ],
      b: [
        {
          attachmentContentType: "application/pdf",
          attachmentLinkMode: LINKED_URL,
        },
      ],
      c: [],
    };

    const result = splitByMissingPdf(
      items,
      (item) => attachmentsByItem[item],
      LINKED_URL,
    );

    expect(result.needsPdf).toEqual(["b", "c"]);
    expect(result.alreadyHasPdf).toBe(1);
  });
});
