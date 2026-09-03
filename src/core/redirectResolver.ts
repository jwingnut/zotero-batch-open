// Resolves a known-redirector URL (doi.org, linkinghub.elsevier.com, ...) to
// its final destination *from Zotero's own process*, at enqueue time, so the
// browser tab a job opens lands directly on the article page instead of
// having to chase the chain itself. See queueServer.ts's enqueueSelectedItems
// for how this is used, and REMOTE_TRIGGER.md for why the browser-side
// readiness wait (batchOpenQueue.js) still exists on top of this: resolution
// can itself land on a page that redirects again client-side (e.g. a
// Cloudflare interstitial), and a stored URL may already be final and never
// touch this module at all.
//
// Deliberately conservative: bounded hops, a short per-attempt timeout, never
// throws (any failure returns the original URL unresolved), never leaves
// http(s), and never sends credentials.

const DEFAULT_MAX_HOPS = 5;
const DEFAULT_TIMEOUT_MS = 10000;

/**
 * Hosts worth spending a network round-trip on at enqueue time: known
 * redirectors whose target is public (no session/cookie needed to resolve)
 * and where the interim page is otherwise useless to translator detection.
 */
const KNOWN_REDIRECTOR_HOSTS = new Set([
  "doi.org",
  "dx.doi.org",
  "linkinghub.elsevier.com",
]);

/** True if `url`'s host is one this module knows is worth resolving. */
export function isKnownRedirectorUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return KNOWN_REDIRECTOR_HOSTS.has(host);
  } catch {
    return false;
  }
}

// A plain HTTP 3xx chain is already collapsed by fetch()'s own
// `redirect: "follow"` in a single call. What that does NOT follow is a
// client-side redirect layered on top of the page it lands on -- e.g.
// linkinghub.elsevier.com's landing page, which redirects to ScienceDirect
// via a meta-refresh/JS redirect rather than a plain Location header. These
// two patterns cover a <meta http-equiv="refresh"> tag and a bare
// `location.href = "..."` / `location.replace("...")` assignment.
const META_REFRESH_RE =
  /<meta[^>]+http-equiv=["']?refresh["']?[^>]+content=["'][^"']*url=([^"'>]+)["']?/i;
const JS_LOCATION_RE =
  /location(?:\.href)?\s*(?:=|\.replace\()\s*["']([^"']+)["']/i;

function extractClientRedirectTarget(
  html: string,
  baseUrl: string,
): string | null {
  const match = META_REFRESH_RE.exec(html) ?? JS_LOCATION_RE.exec(html);
  if (!match) return null;
  try {
    return new URL(match[1].trim(), baseUrl).toString();
  } catch {
    return null;
  }
}

export interface RedirectResolverOptions {
  maxHops?: number;
  timeoutMs?: number;
  /** Injectable for tests; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
}

export interface RedirectResolution {
  finalUrl: string;
  hops: number;
  /** True only if finalUrl actually differs from the input url. */
  resolved: boolean;
}

/**
 * Follows a redirector's chain -- real HTTP redirects (collapsed per hop by
 * fetch()'s own `redirect: "follow"`) plus a client-side meta-refresh/JS
 * redirect on top of any hop -- up to maxHops, each bounded by timeoutMs.
 * Never throws: any failure (network error, timeout, no client-side target
 * found) returns the original `url` with `resolved: false` so the caller can
 * fall back to enqueueing it unresolved rather than dropping the job.
 */
export async function resolveRedirectorUrl(
  url: string,
  opts: RedirectResolverOptions = {},
): Promise<RedirectResolution> {
  const maxHops = opts.maxHops ?? DEFAULT_MAX_HOPS;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const doFetch =
    opts.fetchImpl ?? (typeof fetch !== "undefined" ? fetch : undefined);
  if (!doFetch) {
    return { finalUrl: url, hops: 0, resolved: false };
  }

  let current = url;
  let hops = 0;

  try {
    while (hops < maxHops) {
      if (!/^https?:\/\//i.test(current)) {
        // Never follow off http(s) (e.g. a client-side redirect target that
        // turned out to be a mailto: or javascript: link).
        break;
      }

      const controller =
        typeof AbortController !== "undefined" ? new AbortController() : undefined;
      const timer = controller
        ? setTimeout(() => controller.abort(), timeoutMs)
        : undefined;
      let response: Response;
      try {
        response = await doFetch(current, {
          method: "GET",
          redirect: "follow",
          credentials: "omit",
          signal: controller?.signal,
        });
      } finally {
        if (timer) clearTimeout(timer);
      }

      const landedUrl =
        response.url && /^https?:\/\//i.test(response.url)
          ? response.url
          : current;
      hops += 1;

      let html = "";
      try {
        html = await response.text();
      } catch {
        html = "";
      }

      const clientTarget = extractClientRedirectTarget(html, landedUrl);
      if (
        clientTarget &&
        clientTarget !== landedUrl &&
        /^https?:\/\//i.test(clientTarget)
      ) {
        current = clientTarget;
        continue;
      }

      return { finalUrl: landedUrl, hops, resolved: landedUrl !== url };
    }
    return { finalUrl: current, hops, resolved: current !== url };
  } catch {
    return { finalUrl: url, hops, resolved: false };
  }
}
