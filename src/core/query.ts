// Search-query construction for the two "Search all in …" commands.

export interface QueryableCreator {
  lastName?: string;
  name?: string;
  creatorType?: string;
  creatorTypeID?: number;
}

export interface QueryableItem {
  getField(field: string): string;
  getCreators(): QueryableCreator[];
}

function firstCreatorFamilyName(creators: QueryableCreator[]): string | null {
  if (!Array.isArray(creators) || creators.length === 0) {
    return null;
  }
  const first = creators[0];
  const name = (first.lastName ?? first.name ?? "").trim();
  return name.length > 0 ? name : null;
}

function extractYear(dateField: string): string | null {
  const match = /\d{4}/.exec(dateField ?? "");
  return match ? match[0] : null;
}

/**
 * Build an unquoted search query from an item's title, first creator's
 * family name, and year (when present). Callers are responsible for
 * URL-encoding the result (see scholarSearchUrl / webSearchUrl).
 */
export function buildSearchQuery(item: QueryableItem): string {
  const parts: string[] = [];

  const title = (item.getField("title") ?? "").trim();
  if (title) {
    parts.push(title);
  }

  const creatorName = firstCreatorFamilyName(item.getCreators());
  if (creatorName) {
    parts.push(creatorName);
  }

  const year = extractYear(item.getField("date") ?? "");
  if (year) {
    parts.push(year);
  }

  return parts.join(" ").trim();
}
