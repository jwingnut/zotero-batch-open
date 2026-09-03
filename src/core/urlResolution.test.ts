import { describe, it, expect } from "vitest";
import {
  normalizeDoi,
  doiToUrl,
  resolveOpenUrl,
  scholarSearchUrl,
  webSearchUrl,
  validateSearchTemplate,
  DEFAULT_SEARCH_TEMPLATE,
  type ResolvableItem,
  type ItemLookup,
} from "./urlResolution";

function item(
  fields: Record<string, string>,
  attachments: number[] = [],
): ResolvableItem {
  return {
    getField: (field: string) => fields[field] ?? "",
    getAttachments: () => attachments,
  };
}

function lookup(map: Record<number, ResolvableItem>): ItemLookup {
  return { get: (id: number) => map[id] ?? null };
}

describe("normalizeDoi", () => {
  it("passes through a bare DOI", () => {
    expect(normalizeDoi("10.1000/xyz123")).toBe("10.1000/xyz123");
  });

  it("strips an https://doi.org/ prefix", () => {
    expect(normalizeDoi("https://doi.org/10.1000/xyz123")).toBe(
      "10.1000/xyz123",
    );
  });

  it("strips an https://dx.doi.org/ prefix", () => {
    expect(normalizeDoi("https://dx.doi.org/10.1000/xyz123")).toBe(
      "10.1000/xyz123",
    );
  });

  it("strips a doi: scheme, case-insensitively", () => {
    expect(normalizeDoi("DOI:10.1000/xyz123")).toBe("10.1000/xyz123");
    expect(normalizeDoi("doi: 10.1000/xyz123")).toBe("10.1000/xyz123");
  });

  it("trims whitespace", () => {
    expect(normalizeDoi("  10.1000/xyz123  ")).toBe("10.1000/xyz123");
  });
});

describe("doiToUrl", () => {
  it("builds the canonical resolver URL", () => {
    expect(doiToUrl("10.1000/xyz123")).toBe("https://doi.org/10.1000/xyz123");
  });

  it("normalizes an already-prefixed DOI before building the URL", () => {
    expect(doiToUrl("https://doi.org/10.1000/xyz123")).toBe(
      "https://doi.org/10.1000/xyz123",
    );
  });

  it("returns null for an empty DOI", () => {
    expect(doiToUrl("   ")).toBeNull();
  });
});

describe("resolveOpenUrl — resolution order", () => {
  const opts = {
    fallback: "scholar" as const,
    searchQuery: "some query",
    webTemplate: DEFAULT_SEARCH_TEMPLATE,
  };

  it("prefers the item's own url field", () => {
    const it1 = item({ url: "https://example.com/paper", DOI: "10.1/x" });
    const result = resolveOpenUrl(it1, lookup({}), opts);
    expect(result).toEqual({
      url: "https://example.com/paper",
      source: "stored",
    });
  });

  it("falls back to the DOI when no url is stored", () => {
    const it1 = item({ url: "", DOI: "10.1000/abc" });
    const result = resolveOpenUrl(it1, lookup({}), opts);
    expect(result).toEqual({
      url: "https://doi.org/10.1000/abc",
      source: "doi",
    });
  });

  it("falls back to the first attachment url when there is no stored url or DOI", () => {
    const it1 = item({}, [1, 2]);
    const items = lookup({
      1: item({ url: "" }),
      2: item({ url: "https://example.com/attachment.pdf" }),
    });
    const result = resolveOpenUrl(it1, items, opts);
    expect(result).toEqual({
      url: "https://example.com/attachment.pdf",
      source: "attachment",
    });
  });

  it("skips an attachment with no url and uses a later one", () => {
    const it1 = item({}, [1, 2, 3]);
    const items = lookup({
      1: item({ url: "" }),
      2: item({ url: "   " }),
      3: item({ url: "https://example.com/found.pdf" }),
    });
    const result = resolveOpenUrl(it1, items, opts);
    expect(result.url).toBe("https://example.com/found.pdf");
    expect(result.source).toBe("attachment");
  });

  it("falls back to a Google Scholar search when configured and nothing else resolves", () => {
    const it1 = item({});
    const result = resolveOpenUrl(it1, lookup({}), {
      ...opts,
      fallback: "scholar",
      searchQuery: "title author 2020",
    });
    expect(result.source).toBe("fallback-scholar");
    expect(result.url).toBe(scholarSearchUrl("title author 2020"));
  });

  it("falls back to a web search when configured", () => {
    const it1 = item({});
    const result = resolveOpenUrl(it1, lookup({}), {
      ...opts,
      fallback: "web",
      searchQuery: "title author 2020",
    });
    expect(result.source).toBe("fallback-web");
    expect(result.url).toBe(
      webSearchUrl(DEFAULT_SEARCH_TEMPLATE, "title author 2020"),
    );
  });

  it("skips (returns no url) when fallback is none", () => {
    const it1 = item({});
    const result = resolveOpenUrl(it1, lookup({}), {
      ...opts,
      fallback: "none",
    });
    expect(result).toEqual({ url: null, source: "skipped" });
  });
});

describe("scholarSearchUrl", () => {
  it("URL-encodes punctuation and non-ASCII characters", () => {
    const url = scholarSearchUrl("Café & Kröger? 100% sûr");
    expect(url.startsWith("https://scholar.google.com/scholar?q=")).toBe(true);
    const params = new URL(url).searchParams;
    expect(params.get("q")).toBe("Café & Kröger? 100% sûr");
  });
});

describe("validateSearchTemplate", () => {
  it("accepts a valid http(s) template containing {query}", () => {
    const result = validateSearchTemplate(
      "https://example.com/search?q={query}",
    );
    expect(result.valid).toBe(true);
    expect(result.template).toBe("https://example.com/search?q={query}");
    expect(result.warning).toBeUndefined();
  });

  it("falls back to the default when {query} is missing", () => {
    const result = validateSearchTemplate("https://example.com/search?q=fixed");
    expect(result.valid).toBe(false);
    expect(result.template).toBe(DEFAULT_SEARCH_TEMPLATE);
    expect(result.warning).toMatch(/\{query\}/);
  });

  it("falls back to the default for a non-http(s) scheme", () => {
    const result = validateSearchTemplate("ftp://example.com/{query}");
    expect(result.valid).toBe(false);
    expect(result.template).toBe(DEFAULT_SEARCH_TEMPLATE);
  });

  it("falls back to the default when empty or missing", () => {
    expect(validateSearchTemplate("").template).toBe(DEFAULT_SEARCH_TEMPLATE);
    expect(validateSearchTemplate(undefined).template).toBe(
      DEFAULT_SEARCH_TEMPLATE,
    );
    expect(validateSearchTemplate("   ").valid).toBe(false);
  });
});

describe("webSearchUrl", () => {
  it("substitutes an encoded query into the template", () => {
    const url = webSearchUrl(
      "https://example.com/search?q={query}&lang=en",
      "a & b?",
    );
    expect(url).toBe(
      `https://example.com/search?q=${encodeURIComponent("a & b?")}&lang=en`,
    );
  });

  it("uses the default template when given an invalid one", () => {
    const url = webSearchUrl("not a url", "query text");
    expect(url).toBe(
      DEFAULT_SEARCH_TEMPLATE.replace(
        "{query}",
        encodeURIComponent("query text"),
      ),
    );
  });
});
