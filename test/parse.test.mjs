import { test } from "node:test";
import assert from "node:assert/strict";
import { parseContent, apiPostToPost } from "../scripts/lib/parse.mjs";

const spotify = {
  type: "audio", provider: "spotify",
  url: "https://open.spotify.com/track/5lQKRR3MdJLtAwNBiT8Cq0",
  title: "Lyin' Eyes - 2013 Remaster", artist: "Eagles",
  album: "One of These Nights (2013 Remaster)",
  poster: [{ type: "image/jpeg", width: 640, height: 640, url: "https://64.media.tumblr.com/a5a/668a.jpg" }],
  attribution: { type: "app", app_name: "Spotify", url: "https://open.spotify.com/track/5lQKRR3MdJLtAwNBiT8Cq0", display_text: "Listen on Spotify" },
};

test("the track details are the link's text, not a separate caption line", () => {
  // Tumblr's own display_text is a generic "Listen on Spotify". Naming the
  // track in the link means the details appear once, not as a caption line
  // followed by a link repeating nothing useful.
  const r = parseContent([spotify]);
  assert.deepEqual(r.links, [
    { url: spotify.url, label: "Eagles — Lyin' Eyes - 2013 Remaster" },
  ]);
  assert.deepEqual(r.captionBlocks, [], "the same string must not be printed twice");
  assert.deepEqual(r.videos, [], "Spotify serves no downloadable audio");
});

test("a track-only post is still titled with the track", () => {
  // captionBlocks is empty for these posts, so without trackTitles the title
  // would be blank and both the feed item and the page would fall back to
  // the post's date.
  const post = apiPostToPost({
    id_string: "1", post_url: "https://salaamji.tumblr.com/post/1/x",
    timestamp: 1_700_000_000, content: [spotify],
  });
  assert.equal(post.title, "Eagles — Lyin' Eyes - 2013 Remaster");
  assert.equal(post.caption, "");
});

test("the poster's own words outrank the track as a title", () => {
  const post = apiPostToPost({
    id_string: "1", post_url: "https://salaamji.tumblr.com/post/1/x",
    timestamp: 1_700_000_000,
    content: [{ type: "text", text: "On repeat all week" }, spotify],
  });
  assert.equal(post.title, "On repeat all week");
  assert.equal(post.caption, "On repeat all week");
});

test("album art is not mirrored", () => {
  // Tumblr rehosts it and it could be fetched, but a cover thumbnail beside
  // the photograph the post is actually about is noise.
  const r = parseContent([spotify]);
  assert.deepEqual(r.images, []);
});

test("the bare URL is never the visible text", () => {
  // It was once the caption, and through deriveTitle the post's title too,
  // so the feed item was headlined with a Spotify URL.
  const r = parseContent([spotify]);
  assert.ok(!r.captionBlocks.some((c) => c.startsWith("http")));
  assert.ok(!r.links.some((l) => l.label.startsWith("http")));
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

test("native Tumblr audio is still mirrored, without its cover", () => {
  const r = parseContent([{
    type: "audio", provider: "tumblr", title: "T", artist: "A",
    media: { type: "audio/mp3", url: "https://64.media.tumblr.com/x.mp3" },
    poster: [{ type: "image/jpeg", width: 500, height: 400, url: "https://64.media.tumblr.com/p.jpg" }],
  }]);
  assert.equal(r.videos.length, 1);
  assert.equal(r.videos[0].sourceUrl, "https://64.media.tumblr.com/x.mp3");
  assert.equal(r.videos[0].poster, null);
  assert.deepEqual(r.images, []);
});

// The real block from post 828670374393856000, as the API returned it. The
// link stops one character short of the full text: the "." is not part of it.
const linkedText = {
  type: "text",
  text: "Peek-a-Boo. ",
  formatting: [
    {
      type: "link",
      start: 0,
      end: 10,
      url: "https://en.wikipedia.org/wiki/The_Best_of_Siouxsie_and_the_Banshees",
    },
  ],
};

test("a text block's inline link is rendered as a link", () => {
  const r = parseContent([linkedText]);
  assert.deepEqual(r.captionHtmlBlocks, [
    '<a href="https://en.wikipedia.org/wiki/The_Best_of_Siouxsie_and_the_Banshees">Peek-a-Boo</a>.',
  ]);
  assert.deepEqual(r.captionBlocks, ["Peek-a-Boo."], "the plain caption is unchanged");
});

test("the title and og:description stay plain text", () => {
  // Both are derived from `caption`, and both are rendered into contexts that
  // cannot take markup: a <title> element and a meta attribute.
  const post = apiPostToPost({
    id_string: "1", post_url: "https://salaamji.tumblr.com/post/1/x",
    timestamp: 1_700_000_000, content: [linkedText],
  });
  assert.equal(post.title, "Peek-a-Boo.");
  assert.equal(post.caption, "Peek-a-Boo.");
  assert.match(post.captionHtml, /^<a href=/);
});

test("captionHtml is omitted when it would only repeat the caption", () => {
  const post = apiPostToPost({
    id_string: "1", post_url: "https://salaamji.tumblr.com/post/1/x",
    timestamp: 1_700_000_000, content: [{ type: "text", text: "Just words." }],
  });
  assert.equal(post.captionHtml, undefined);
});

test("formatting offsets are code points, not UTF-16 units", () => {
  // The NPF spec counts an emoji as one character. Slicing the JS string
  // directly would put the link one position off for every astral character
  // ahead of it.
  const r = parseContent([{
    type: "text", text: "🌳 see here",
    formatting: [{ type: "link", start: 6, end: 10, url: "https://x.test/" }],
  }]);
  assert.deepEqual(r.captionHtmlBlocks, ['🌳 see <a href="https://x.test/">here</a>']);
});

test("a javascript: url is dropped but its text is kept", () => {
  const r = parseContent([{
    type: "text", text: "click me",
    formatting: [{ type: "link", start: 0, end: 5, url: "javascript:alert(1)" }],
  }]);
  assert.deepEqual(r.captionHtmlBlocks, ["click me"]);
});

test("text and urls inside a link are escaped", () => {
  const r = parseContent([{
    type: "text", text: 'a <b> & "c"',
    formatting: [{ type: "link", start: 2, end: 5, url: "https://x.test/?a=1&b=2" }],
  }]);
  assert.deepEqual(r.captionHtmlBlocks, [
    'a <a href="https://x.test/?a=1&amp;b=2">&lt;b&gt;</a> &amp; &quot;c&quot;',
  ]);
});

test("malformed ranges are skipped, not thrown", () => {
  for (const bad of [
    { type: "link", start: 5, end: 2, url: "https://x.test/" },
    { type: "link", start: 0, end: 99, url: "https://x.test/" },
    { type: "link", start: -1, end: 3, url: "https://x.test/" },
    { type: "link", start: 1.5, end: 3, url: "https://x.test/" },
    { type: "link", start: 0, end: 3 },
    { type: "bold", start: 0, end: 3 },
  ]) {
    const r = parseContent([{ type: "text", text: "abcdef", formatting: [bad] }]);
    assert.deepEqual(r.captionHtmlBlocks, ["abcdef"], JSON.stringify(bad));
  }
});

test("overlapping link ranges keep the first and drop the rest", () => {
  const r = parseContent([{
    type: "text", text: "abcdef",
    formatting: [
      { type: "link", start: 0, end: 4, url: "https://one.test/" },
      { type: "link", start: 2, end: 6, url: "https://two.test/" },
    ],
  }]);
  assert.deepEqual(r.captionHtmlBlocks, ['<a href="https://one.test/">abcd</a>ef']);
});

test("leading whitespace does not shift the link", () => {
  // The text is trimmed for the plain caption, but the offsets index the raw
  // string, so the ranges have to be applied before any trimming.
  const r = parseContent([{
    type: "text", text: "  hello world",
    formatting: [{ type: "link", start: 2, end: 7, url: "https://x.test/" }],
  }]);
  assert.deepEqual(r.captionBlocks, ["hello world"]);
  assert.deepEqual(r.captionHtmlBlocks, ['<a href="https://x.test/">hello</a> world']);
});
