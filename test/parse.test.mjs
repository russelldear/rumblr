import { test } from "node:test";
import assert from "node:assert/strict";
import { parseContent } from "../scripts/lib/parse.mjs";

const spotify = {
  type: "audio", provider: "spotify",
  url: "https://open.spotify.com/track/5lQKRR3MdJLtAwNBiT8Cq0",
  title: "Lyin' Eyes - 2013 Remaster", artist: "Eagles",
  album: "One of These Nights (2013 Remaster)",
  poster: [{ type: "image/jpeg", width: 640, height: 640, url: "https://64.media.tumblr.com/a5a/668a.jpg" }],
  attribution: { type: "app", app_name: "Spotify", url: "https://open.spotify.com/track/5lQKRR3MdJLtAwNBiT8Cq0", display_text: "Listen on Spotify" },
};

test("third-party audio keeps its album art, track details and link", () => {
  const r = parseContent([spotify]);
  assert.equal(r.images.length, 1, "album art is mirrored");
  assert.equal(r.images[0].sourceUrl, "https://64.media.tumblr.com/a5a/668a.jpg");
  assert.deepEqual(r.captionBlocks, ["Eagles — Lyin' Eyes - 2013 Remaster"]);
  assert.deepEqual(r.links, [{ url: spotify.url, label: "Listen on Spotify" }]);
  assert.deepEqual(r.videos, [], "Spotify serves no downloadable audio");
});

test("the bare URL no longer becomes the caption", () => {
  // It previously did, and through deriveTitle became the post's title too,
  // so the feed item was headlined with a Spotify URL.
  const r = parseContent([spotify]);
  assert.ok(!r.captionBlocks.some((c) => c.startsWith("http")));
});

test("audio with no poster and no attribution still yields a usable link", () => {
  const r = parseContent([{ type: "audio", provider: "bandcamp", url: "https://x/track", title: "T", artist: "A" }]);
  assert.deepEqual(r.images, []);
  assert.deepEqual(r.links, [{ url: "https://x/track", label: "A — T" }]);
});

test("audio with neither url nor attribution keeps what it can", () => {
  const r = parseContent([{ type: "audio", provider: "spotify", title: "T", artist: "A" }]);
  assert.deepEqual(r.links, []);
  assert.deepEqual(r.captionBlocks, ["A — T"]);
});

test("a link block keeps its URL instead of discarding it", () => {
  const r = parseContent([{ type: "link", url: "https://nyt.com/a", title: "Headline", description: "Blurb" }]);
  assert.deepEqual(r.links, [{ url: "https://nyt.com/a", label: "Headline: Blurb" }]);
  assert.deepEqual(r.captionBlocks, []);
});

test("native Tumblr audio is still mirrored", () => {
  const r = parseContent([{
    type: "audio", provider: "tumblr", title: "T", artist: "A",
    media: { type: "audio/mp3", url: "https://64.media.tumblr.com/x.mp3" },
    poster: [{ type: "image/jpeg", width: 500, height: 400, url: "https://64.media.tumblr.com/p.jpg" }],
  }]);
  assert.equal(r.videos.length, 1);
  assert.equal(r.videos[0].sourceUrl, "https://64.media.tumblr.com/x.mp3");
  assert.equal(r.images.length, 1, "album art mirrored alongside");
});
