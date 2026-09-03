// Pure URL-resolution logic for the "Open all in browser" command.
// Kept free of Zotero globals where possible so it is easy to unit test.

export type FallbackSetting = "scholar" | "web" | "none";

export type UrlSource =
  | "stored"
  | "doi"
  | "attachment"
  | "fallback-scholar"
  | "fallback-web"
  | "skipped";

export interface ResolvedUrl {
  url: string | null;
  source: UrlSource;
}

/**
 * Normalize a stored DOI value that may already include a resolver prefix
 * (https://doi.org/…, https://dx.doi.org/…) or a bare "doi:" scheme.
 */
export function normalizeDoi(raw: string): string {
  return raw
    .trim()
    .replace(/^doi:\s*/i, "")
    .replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, "")
    .trim();
}

/** Build the canonical https://doi.org/<doi> URL for a (possibly prefixed) DOI. */
export function doiToUrl(raw: string): string | null {
  const doi = normalizeDoi(raw);
  if (!doi) {
    return null;
  }
  return `https://doi.org/${doi}`;
}

function trimmedOrNull(value: string | null | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** Minimal shape of a Zotero item needed for URL resolution (for testability). */
export interface ResolvableItem {
  getField(field: string): string;
  getAttachments(): number[];
}

export interface ItemLookup {
  get(id: number): ResolvableItem | null;
}

export function getStoredUrl(item: ResolvableItem): string | null {
  return trimmedOrNull(item.getField("url"));
}

export function getStoredDoiUrl(item: ResolvableItem): string | null {
  const doi = trimmedOrNull(item.getField("DOI"));
  if (!doi) {
    return null;
  }
  return doiToUrl(doi);
}

/** The URL of the first child attachment (in attachment order) that has one set. */
export function getFirstAttachmentUrl(
  item: ResolvableItem,
  items: ItemLookup,
): string | null {
  const ids = item.getAttachments();
  for (const id of ids) {
    const attachment = items.get(id);
    if (!attachment) {
      continue;
    }
    const url = trimmedOrNull(attachment.getField("url"));
    if (url) {
      return url;
    }
  }
  return null;
}

export interface ResolveOpenUrlOptions {
  fallback: FallbackSetting;
  /** Search query to use when falling back to a search (already built). */
  searchQuery: string;
  /** Validated web-search template, e.g. "https://www.google.com/search?q={query}". */
  webTemplate: string;
}

/**
 * Resolution order for "Open all in browser": stored url -> DOI -> first
 * attachment url -> configured fallback (scholar search / web search / skip).
 */
export function resolveOpenUrl(
  item: ResolvableItem,
  items: ItemLookup,
  opts: ResolveOpenUrlOptions,
): ResolvedUrl {
  const stored = getStoredUrl(item);
  if (stored) {
    return { url: stored, source: "stored" };
  }

  const doiUrl = getStoredDoiUrl(item);
  if (doiUrl) {
    return { url: doiUrl, source: "doi" };
  }

  const attachmentUrl = getFirstAttachmentUrl(item, items);
  if (attachmentUrl) {
    return { url: attachmentUrl, source: "attachment" };
  }

  switch (opts.fallback) {
    case "scholar":
      return {
        url: scholarSearchUrl(opts.searchQuery),
        source: "fallback-scholar",
      };
    case "web":
      return {
        url: webSearchUrl(opts.webTemplate, opts.searchQuery),
        source: "fallback-web",
      };
    case "none":
    default:
      return { url: null, source: "skipped" };
  }
}

/** Google Scholar search URL for a (plain, unencoded) query string. */
export function scholarSearchUrl(query: string): string {
  const params = new URLSearchParams({ q: query });
  return `https://scholar.google.com/scholar?${params.toString()}`;
}

const DEFAULT_SEARCH_TEMPLATE = "https://www.google.com/search?q={query}";

export interface TemplateValidationResult {
  template: string;
  valid: boolean;
  warning?: string;
}

/**
 * Validate a configurable web-search template: must be http(s) and contain
 * the literal placeholder "{query}". Falls back to the default with a
 * warning when invalid.
 */
export function validateSearchTemplate(
  template: string | null | undefined,
): TemplateValidationResult {
  const value = trimmedOrNull(template);
  if (!value) {
    return {
      template: DEFAULT_SEARCH_TEMPLATE,
      valid: false,
      warning: "Web search template is empty; using the default.",
    };
  }

  if (!/^https?:\/\//i.test(value)) {
    return {
      template: DEFAULT_SEARCH_TEMPLATE,
      valid: false,
      warning: `Web search template "${value}" is not an http(s) URL; using the default.`,
    };
  }

  if (!value.includes("{query}")) {
    return {
      template: DEFAULT_SEARCH_TEMPLATE,
      valid: false,
      warning: `Web search template "${value}" does not contain {query}; using the default.`,
    };
  }

  return { template: value, valid: true };
}

/** Substitute {query} into a (validated) web-search template. */
export function webSearchUrl(template: string, query: string): string {
  const { template: validated } = validateSearchTemplate(template);
  return validated.replace("{query}", encodeURIComponent(query));
}

export { DEFAULT_SEARCH_TEMPLATE };
