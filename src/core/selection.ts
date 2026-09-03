// Selection filtering: operate on regular items only, count everything else.

export interface SelectableItem {
  isRegularItem(): boolean;
}

export interface SelectionSplit<T extends SelectableItem> {
  regularItems: T[];
  /** Notes, attachments, and annotations present in the selection. */
  skippedCount: number;
}

/**
 * Split a raw Zotero selection into regular items (the only ones these
 * commands operate on) and a count of everything skipped (notes,
 * attachments, annotations).
 */
export function splitSelection<T extends SelectableItem>(
  items: T[],
): SelectionSplit<T> {
  const regularItems: T[] = [];
  let skippedCount = 0;

  for (const item of items) {
    if (item.isRegularItem()) {
      regularItems.push(item);
    } else {
      skippedCount += 1;
    }
  }

  return { regularItems, skippedCount };
}
