import { describe, it, expect } from "vitest";
import { buildSearchQuery, type QueryableItem } from "./query";

function item(
  fields: Record<string, string>,
  creators: Array<{ lastName?: string; name?: string }> = [],
): QueryableItem {
  return {
    getField: (field: string) => fields[field] ?? "",
    getCreators: () => creators,
  };
}

describe("buildSearchQuery", () => {
  it("combines title, first creator family name, and year", () => {
    const q = buildSearchQuery(
      item({ title: "A Study of Things", date: "2020-05-01" }, [
        { lastName: "Smith" },
      ]),
    );
    expect(q).toBe("A Study of Things Smith 2020");
  });

  it("omits missing parts without leaving extra whitespace", () => {
    const q = buildSearchQuery(item({ title: "Just a Title" }));
    expect(q).toBe("Just a Title");
  });

  it("falls back to a single-field creator name", () => {
    const q = buildSearchQuery(
      item({ title: "T" }, [{ name: "Some Institute" }]),
    );
    expect(q).toBe("T Some Institute");
  });

  it("uses only the first creator, even with several", () => {
    const q = buildSearchQuery(
      item({ title: "T" }, [{ lastName: "First" }, { lastName: "Second" }]),
    );
    expect(q).toBe("T First");
  });

  it("preserves punctuation and non-ASCII characters (encoding is the caller's job)", () => {
    const q = buildSearchQuery(
      item({ title: "Über café: a study & test?", date: "1999" }, [
        { lastName: "Müller" },
      ]),
    );
    expect(q).toBe("Über café: a study & test? Müller 1999");
  });

  it("extracts a 4-digit year from a fuzzy date string", () => {
    const q = buildSearchQuery(item({ title: "T", date: "circa 2003" }));
    expect(q).toBe("T 2003");
  });

  it("returns an empty string when nothing is available", () => {
    expect(buildSearchQuery(item({}))).toBe("");
  });
});
