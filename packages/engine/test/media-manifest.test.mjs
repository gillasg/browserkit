import assert from "node:assert/strict";
import test from "node:test";
import { parseDash, parseHls, parseManifest } from "../dist/media-manifest.js";

const MASTER = `#EXTM3U
#EXT-X-VERSION:6
#EXT-X-STREAM-INF:BANDWIDTH=5200000,RESOLUTION=1920x1080,CODECS="avc1.640028,mp4a.40.2"
1080/index.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=1700000,RESOLUTION=1280x720,CODECS="avc1.4d401f,mp4a.40.2"
720/index.m3u8
`;

const MEDIA = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:4
#EXT-X-MEDIA-SEQUENCE:0
#EXTINF:4.0,
seg0.ts
#EXTINF:4.0,
seg1.ts
#EXTINF:2.0,
seg2.ts
#EXT-X-ENDLIST
`;

test("an HLS master lists every variant with height, width, bandwidth and codecs", () => {
  const parsed = parseHls(MASTER, "https://cdn.example/master.m3u8");
  assert.equal(parsed.masters.length, 1);
  const variants = parsed.masters[0].variants;
  assert.equal(variants.length, 2);
  assert.deepEqual(variants[0], {
    url: "https://cdn.example/1080/index.m3u8",
    width: 1920,
    height: 1080,
    bandwidth: 5200000,
    codecs: "avc1.640028,mp4a.40.2",
  });
  assert.equal(variants[1].height, 720);
  assert.equal(parsed.playlists.length, 0);
});

test("an HLS media playlist gives duration, segments and live flag", () => {
  const parsed = parseHls(MEDIA, "https://cdn.example/720/index.m3u8");
  assert.equal(parsed.masters.length, 0);
  assert.equal(parsed.playlists.length, 1);
  assert.equal(parsed.playlists[0].segments, 3);
  assert.equal(parsed.playlists[0].duration, 10);
  assert.equal(parsed.playlists[0].live, false);
  const live = parseHls(MEDIA.replace("#EXT-X-ENDLIST", ""), "https://cdn.example/live.m3u8");
  assert.equal(live.playlists[0].live, true);
});

const MPD = `<?xml version="1.0"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" mediaPresentationDuration="PT1H2M3.5S" type="static">
  <Period>
    <AdaptationSet mimeType="video/mp4">
      <Representation id="v1" bandwidth="4500000" width="1920" height="1080" codecs="avc1.640028">
        <BaseURL>video/1080.mp4</BaseURL>
      </Representation>
      <Representation id="v2" bandwidth="1200000" width="1280" height="720" codecs="avc1.4d401f">
        <BaseURL>video/720.mp4</BaseURL>
      </Representation>
    </AdaptationSet>
  </Period>
</MPD>`;

test("a DASH MPD lists representations and the presentation duration", () => {
  const parsed = parseDash(MPD, "https://cdn.example/manifest.mpd");
  assert.equal(parsed.masters.length, 1);
  assert.deepEqual(parsed.masters[0].variants[0], {
    url: "https://cdn.example/video/1080.mp4",
    width: 1920,
    height: 1080,
    bandwidth: 4500000,
    codecs: "avc1.640028",
    name: "v1",
  });
  assert.equal(parsed.masters[0].variants[1].height, 720);
});

test("the parser is chosen by extension or content, and unknown text is not parsed", () => {
  assert.equal(parseManifest("https://x/y.m3u8", MASTER).masters.length, 1);
  assert.equal(parseManifest("https://x/y.mpd", MPD).masters.length, 1);
  assert.equal(parseManifest("https://x/y.txt", MASTER).masters.length, 1);
  assert.deepEqual(parseManifest("https://x/y.json", '{"a":1}'), { masters: [], playlists: [] });
});
