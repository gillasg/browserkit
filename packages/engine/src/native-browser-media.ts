// page.media(): what this tab (and its iframes/workers) requested as a manifest, parsed into
// masters, variants and playlists. The page only has to ask; the host already recorded the URLs
// and their headers, fetches the text and runs the pure parsers in media-manifest.ts.
import { parseManifest, type ParsedManifest } from "./media-manifest.js";
import { recorderOf } from "./native-browser-network.js";

const MAX_MANIFEST_BYTES = 2_000_000;
const MAX_MANIFESTS = 5;

export interface MediaRequest {
  url?: string;
  headers?: Record<string, string>;
}

export interface MediaAnswer extends ParsedManifest {
  headers: Record<string, string>;
  manifests: string[];
}

function isManifest(url: string): boolean {
  return /\.(m3u8|mpd)([?#]|$)/i.test(url) || /\/manifest[^/]*\.(m3u8|mpd)/i.test(url);
}

async function fetchText(
  url: string,
  headers: Record<string, string>,
): Promise<string | undefined> {
  try {
    const response = await fetch(url, {
      headers,
      credentials: "include",
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return undefined;
    const text = await response.text();
    return text.length > MAX_MANIFEST_BYTES ? text.slice(0, MAX_MANIFEST_BYTES) : text;
  } catch {
    return undefined;
  }
}

/**
 * Manifests the tab requested (or one named URL), parsed. A master playlist is merged with the
 * variant playlist it points at only as URLs and metadata; variants keep their own URL.
 */
export async function mediaCall(tabId: number, request: MediaRequest = {}): Promise<MediaAnswer> {
  const candidates = request.url
    ? [{ url: request.url, headers: request.headers ?? {} }]
    : [...(recorderOf(tabId)?.entries.values() ?? [])]
        .filter((entry) => isManifest(entry.url))
        .slice(-MAX_MANIFESTS)
        .map((entry) => ({ url: entry.url, headers: entry.requestHeaders ?? {} }));
  const seen = new Set<string>();
  const answer: MediaAnswer = { masters: [], playlists: [], headers: {}, manifests: [] };
  for (const candidate of candidates) {
    if (seen.has(candidate.url)) continue;
    seen.add(candidate.url);
    const text = await fetchText(candidate.url, candidate.headers);
    if (!text) continue;
    const parsed = parseManifest(candidate.url, text);
    if (!parsed.masters.length && !parsed.playlists.length) continue;
    answer.masters.push(...parsed.masters);
    answer.playlists.push(...parsed.playlists);
    answer.manifests.push(candidate.url);
    if (!Object.keys(answer.headers).length) Object.assign(answer.headers, candidate.headers);
  }
  return answer;
}
