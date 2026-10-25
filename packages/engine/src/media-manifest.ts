// Manifest parsing for page.media(): HLS master/media playlists and DASH MPD representations,
// reduced to what a caller asks ("which heights, which bandwidth, how many segments"). Pure and
// tested on fixture manifests; the host fetches the text, the page never has to.

export interface MediaVariant {
  url?: string;
  width?: number;
  height?: number;
  bandwidth?: number;
  codecs?: string;
  name?: string;
}

export interface MediaMaster {
  url: string;
  variants: MediaVariant[];
}

export interface MediaPlaylist {
  url: string;
  /** Seconds, for a VOD playlist (sum of EXTINF or the MPD duration). */
  duration?: number;
  segments?: number;
  live?: boolean;
}

export interface ParsedManifest {
  masters: MediaMaster[];
  playlists: MediaPlaylist[];
}

const EMPTY: ParsedManifest = { masters: [], playlists: [] };

function absolute(url: string, base: string): string {
  try {
    return new URL(url, base).href;
  } catch {
    return url;
  }
}

function attributes(line: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const match of line.matchAll(/([A-Za-z0-9-]+)=("[^"]*"|[^,\s>]*)/g))
    out[match[1] ?? ""] = (match[2] ?? "").replace(/^"|"$/g, "");
  return out;
}

function number(value: string | undefined): number | undefined {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** An HLS playlist: a master (variants) or a media playlist (duration, segments, live). */
export function parseHls(text: string, baseUrl: string): ParsedManifest {
  const lines = String(text ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (!lines.some((line) => line.startsWith("#EXTM3U"))) return { ...EMPTY };
  const variants: MediaVariant[] = [];
  let duration = 0;
  let segments = 0;
  let ended = false;
  let target: number | undefined;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index] ?? "";
    if (line.startsWith("#EXT-X-STREAM-INF:")) {
      const attrs = attributes(line);
      const resolution = (attrs.RESOLUTION ?? "").split("x");
      const next = lines.slice(index + 1).find((item) => !item.startsWith("#"));
      variants.push({
        ...(next ? { url: absolute(next, baseUrl) } : {}),
        ...(number(resolution[0]) ? { width: number(resolution[0]) } : {}),
        ...(number(resolution[1]) ? { height: number(resolution[1]) } : {}),
        ...(number(attrs.BANDWIDTH) ? { bandwidth: number(attrs.BANDWIDTH) } : {}),
        ...(attrs.CODECS ? { codecs: attrs.CODECS } : {}),
      } as MediaVariant);
      continue;
    }
    if (line.startsWith("#EXTINF:")) {
      duration += number(line.slice(8).split(",")[0]) ?? 0;
      segments += 1;
      continue;
    }
    if (line.startsWith("#EXT-X-TARGETDURATION:")) target = number(line.slice(22));
    if (line.startsWith("#EXT-X-ENDLIST")) ended = true;
  }
  if (variants.length) return { masters: [{ url: baseUrl, variants }], playlists: [] };
  return {
    masters: [],
    playlists: [
      {
        url: baseUrl,
        segments,
        ...(duration ? { duration: Math.round(duration * 100) / 100 } : {}),
        live: !ended && segments > 0,
        ...(target ? { target } : {}),
      } as MediaPlaylist,
    ],
  };
}

/** A DASH MPD: Representations grouped per AdaptationSet, with Width/Height/Bandwidth/Codecs. */
export function parseDash(text: string, baseUrl: string): ParsedManifest {
  const xml = String(text ?? "");
  if (!/<MPD[\s>]/i.test(xml)) return { ...EMPTY };
  const duration = /<MPD[^>]*\bmediaPresentationDuration="([^"]+)"/i.exec(xml)?.[1];
  const seconds = duration
    ? Number(
        duration
          .replace(/^PT/i, "")
          .replace(/H/i, "*3600+")
          .replace(/M/i, "*60+")
          .replace(/S$/i, "")
          .replace(/\+$/, ""),
      )
    : undefined;
  const variants: MediaVariant[] = [];
  for (const match of xml.matchAll(/<Representation\b([^>]*)>([\s\S]*?)<\/Representation>/gi)) {
    const attrs = attributes(match[1] ?? "");
    const base = /<BaseURL[^>]*>([^<]+)<\/BaseURL>/i.exec(match[2] ?? "")?.[1];
    variants.push({
      ...(base ? { url: absolute(base.trim(), baseUrl) } : {}),
      ...(number(attrs.width) ? { width: number(attrs.width) } : {}),
      ...(number(attrs.height) ? { height: number(attrs.height) } : {}),
      ...(number(attrs.bandwidth) ? { bandwidth: number(attrs.bandwidth) } : {}),
      ...(attrs.codecs ? { codecs: attrs.codecs } : {}),
      ...(attrs.id ? { name: attrs.id } : {}),
    } as MediaVariant);
  }
  return {
    masters: variants.length ? [{ url: baseUrl, variants }] : [],
    playlists: variants.length
      ? []
      : [
          {
            url: baseUrl,
            ...(seconds && Number.isFinite(seconds)
              ? { duration: Math.round(seconds * 100) / 100 }
              : {}),
          },
        ],
  };
}

/** A manifest URL says which parser to use; unknown manifests are not parsed. */
export function parseManifest(url: string, text: string): ParsedManifest {
  const path = url.split("?")[0]?.toLowerCase() ?? "";
  if (path.endsWith(".m3u8") || /#EXTM3U/.test(text)) return parseHls(text, url);
  if (path.endsWith(".mpd") || /<MPD[\s>]/i.test(text)) return parseDash(text, url);
  return { ...EMPTY };
}
