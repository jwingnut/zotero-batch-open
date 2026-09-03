import { describe, expect, it } from "vitest";
import {
  isKnownRedirectorUrl,
  resolveRedirectorUrl,
} from "./redirectResolver";

function fakeResponse(url: string, html: string): Response {
  return {
    url,
    text: async () => html,
  } as unknown as Response;
}

describe("isKnownRedirectorUrl", () => {
  it("recognizes doi.org, dx.doi.org, and linkinghub.elsevier.com", () => {
    expect(isKnownRedirectorUrl("https://doi.org/10.1000/xyz")).toBe(true);
    expect(isKnownRedirectorUrl("https://dx.doi.org/10.1000/xyz")).toBe(true);
    expect(
      isKnownRedirectorUrl(
        "https://linkinghub.elsevier.com/retrieve/pii/S0924271618302867",
      ),
    ).toBe(true);
  });

  it("does not flag an already-final publisher URL", () => {
    expect(
      isKnownRedirectorUrl(
        "https://www.sciencedirect.com/science/article/pii/S0924271618302867",
      ),
    ).toBe(false);
  });

  it("returns false for an unparseable URL rather than throwing", () => {
    expect(isKnownRedirectorUrl("not a url")).toBe(false);
  });
});

describe("resolveRedirectorUrl", () => {
  it("uses fetch()'s own followed-redirect response.url when there is no client-side redirect on top", async () => {
    const fetchImpl = async () =>
      fakeResponse("https://doi.org/final-landing", "<html>no redirect here</html>");
    const result = await resolveRedirectorUrl("https://doi.org/10.1000/xyz", {
      fetchImpl,
    });
    expect(result.finalUrl).toBe("https://doi.org/final-landing");
    expect(result.resolved).toBe(true);
    expect(result.hops).toBe(1);
  });

  it("follows a client-side meta-refresh layered on top of the landed page (the linkinghub case)", async () => {
    const calls: string[] = [];
    const fetchImpl = async (input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url);
      if (url.includes("linkinghub")) {
        return fakeResponse(
          url,
          '<html><head><meta http-equiv="refresh" content="0;url=https://www.sciencedirect.com/science/article/pii/S0924271618302867?via%3Dihub"></head></html>',
        );
      }
      return fakeResponse(url, "<html>final</html>");
    };
    const result = await resolveRedirectorUrl(
      "https://linkinghub.elsevier.com/retrieve/pii/S0924271618302867",
      { fetchImpl },
    );
    expect(result.resolved).toBe(true);
    expect(result.finalUrl).toBe(
      "https://www.sciencedirect.com/science/article/pii/S0924271618302867?via%3Dihub",
    );
    expect(calls).toHaveLength(2);
  });

  it("follows a client-side JS location redirect", async () => {
    const fetchImpl = async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("doi.org")) {
        return fakeResponse(
          url,
          '<script>location.href = "https://publisher.example.com/article/1";</script>',
        );
      }
      return fakeResponse(url, "<html>final</html>");
    };
    const result = await resolveRedirectorUrl("https://doi.org/10.1/x", {
      fetchImpl,
    });
    expect(result.finalUrl).toBe("https://publisher.example.com/article/1");
    expect(result.resolved).toBe(true);
  });

  it("falls back to the original URL, unresolved, when fetch throws", async () => {
    const fetchImpl = async () => {
      throw new Error("network error");
    };
    const result = await resolveRedirectorUrl("https://doi.org/10.1/x", {
      fetchImpl,
    });
    expect(result.finalUrl).toBe("https://doi.org/10.1/x");
    expect(result.resolved).toBe(false);
  });

  it("stops at maxHops rather than looping forever on a redirect cycle", async () => {
    let calls = 0;
    const fetchImpl = async (input: RequestInfo | URL) => {
      calls += 1;
      const url = String(input);
      const n = Number(url.split("/").pop());
      return fakeResponse(
        url,
        `<script>location.href = "https://x.example.com/${n + 1}";</script>`,
      );
    };
    const result = await resolveRedirectorUrl("https://x.example.com/0", {
      fetchImpl,
      maxHops: 3,
    });
    expect(calls).toBe(3);
    expect(result.hops).toBe(3);
  });

  it("never follows a client-side target that leaves http(s)", async () => {
    const fetchImpl = async () =>
      fakeResponse(
        "https://doi.org/x",
        '<script>location.href = "javascript:alert(1)";</script>',
      );
    const result = await resolveRedirectorUrl("https://doi.org/x", {
      fetchImpl,
    });
    expect(result.finalUrl).toBe("https://doi.org/x");
  });
});
