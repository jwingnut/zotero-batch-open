// Pure helpers for classifying attachments as "a stored/imported file" vs "a
// link to a URL" — used by both the missing-PDF filter (command 1) and the
// reconcile command's file-moving logic (command 2).

/** Minimal shape of an attachment item needed for these checks. */
export interface AttachmentRef {
  attachmentContentType?: string;
  attachmentLinkMode?: number;
}

/**
 * Whether an attachment is a stored/imported file (has real content Zotero
 * holds onto) rather than a bare link to a URL. `linkedUrlLinkMode` is the
 * live value of `Zotero.Attachments.LINK_MODE_LINKED_URL` — the one link
 * mode that means "just a URL, nothing stored".
 */
export function isFileAttachment(
  attachment: AttachmentRef,
  linkedUrlLinkMode: number,
): boolean {
  return (
    attachment.attachmentLinkMode !== undefined &&
    attachment.attachmentLinkMode !== linkedUrlLinkMode
  );
}

/** Whether any attachment in the list is a stored/imported PDF. */
export function hasStoredPdf(
  attachments: AttachmentRef[],
  linkedUrlLinkMode: number,
): boolean {
  return attachments.some(
    (a) =>
      a.attachmentContentType === "application/pdf" &&
      isFileAttachment(a, linkedUrlLinkMode),
  );
}

export interface MissingPdfSplit<T> {
  /** Items that do NOT have a stored PDF and should still be opened. */
  needsPdf: T[];
  /** Count of items skipped because they already have a stored PDF. */
  alreadyHasPdf: number;
}

/**
 * Split a list of regular items into those missing a stored PDF (to open)
 * and a count of those that already have one (to skip). `getAttachments`
 * resolves an item's attachment child items (already fetched — this stays
 * free of any Zotero global so it's easy to unit test).
 */
export function splitByMissingPdf<T>(
  items: T[],
  getAttachments: (item: T) => AttachmentRef[],
  linkedUrlLinkMode: number,
): MissingPdfSplit<T> {
  const needsPdf: T[] = [];
  let alreadyHasPdf = 0;

  for (const item of items) {
    if (hasStoredPdf(getAttachments(item), linkedUrlLinkMode)) {
      alreadyHasPdf += 1;
    } else {
      needsPdf.push(item);
    }
  }

  return { needsPdf, alreadyHasPdf };
}
