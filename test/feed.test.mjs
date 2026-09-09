import { test } from "node:test";
import assert from "node:assert/strict";

import {
  normalisePostId,
  previewImage,
  selectFeedPosts,
  feedDescription,
  feedMedia,
  mimeFor,
  cdata,
  DEFAULT_SINCE_POST_ID,
} from "../scripts/lib/feed.mjs";

const post = (id, iso) => ({ id, publishedAt: iso, images: [], videos: [], caption: "" });

const BEFORE = post("826570522756349952", "2026-09-01T16:11:18Z");
const CUTOFF = post("826639118293516288", "2026-09-02T10:21:36Z");
const AFTER = post("826644056326176768", "2026-09-02T11:40:05Z");
const ALL = [BEFORE, CUTOFF, AFTER];

test("post ids are read from either Tumblr URL shape", () => {
  assert.equal(
    normalisePostId(
      "https://www.tumblr.com/salaamji/826639118293516288/stunning-jellyfish-at-the-aquarium",
    ),
    "826639118293516288",
  );
  assert.equal(
    normalisePostId("https://salaamji.tumblr.com/post/826639118293516288"),
    "826639118293516288",
  );
  assert.equal(normalisePostId("826639118293516288"), "826639118293516288");
  assert.equal(normalisePostId(""), null);
  assert.equal(normalisePostId(null), null);
});

test("the cutoff post is included; everything older is not", () => {
  assert.deepEqual(
    selectFeedPosts(ALL, { sincePostId: CUTOFF.id }).map((p) => p.id),
    [AFTER.id, CUTOFF.id],
  );
});

test("the post Tumblr already delivered is excluded by default", () => {
  const ids = selectFeedPosts(ALL).map((p) => p.id);
  assert.deepEqual(ids, [AFTER.id]);
  assert.ok(!ids.includes(CUTOFF.id));
});

test("the cutoff can be given as a URL", () => {
  assert.deepEqual(
    selectFeedPosts(ALL, {
      sincePostId: "https://www.tumblr.com/salaamji/826644056326176768/x",
    }).map((p) => p.id),
    [AFTER.id],
  );
});

test("items are newest first and capped", () => {
  assert.deepEqual(selectFeedPosts(ALL, { maxItems: 1 }).map((p) => p.id), [AFTER.id]);
});

test("adjacent ids stay distinct, which Numbers cannot manage", () => {
  const a = "826639118293516288";
  const b = "826639118293516289";
  // Precondition: 18-digit ids exceed Number.MAX_SAFE_INTEGER, so a Number
  // comparison would treat these two different posts as the same one.
  assert.equal(Number(a), Number(b));
  assert.equal(selectFeedPosts([post(b, "2026-09-02T10:21:37Z")], { sincePostId: b }).length, 1);
  assert.equal(selectFeedPosts([post(a, "2026-09-02T10:21:36Z")], { sincePostId: b }).length, 0);
});

test("descriptions use absolute media URLs and escape text", () => {
  const html = feedDescription(
    {
      images: [{ src: "/media/1/a.webp", alt: 'A "quoted" & <tagged> alt' }],
      caption: "one\n\ntwo & three",
    },
    "https://guid.nz/rumblr",
  );
  assert.ok(html.includes("https://guid.nz/rumblr/media/1/a.webp"));
  assert.ok(html.includes("&quot;quoted&quot; &amp; &lt;tagged&gt;"));
  assert.ok(html.includes("<p>two &amp; three</p>"));
});

test("a CDATA terminator in content is split rather than dropped", () => {
  assert.equal(cdata("safe"), "<![CDATA[safe]]>");
  assert.ok(cdata("a]]>b").includes("]]]]><![CDATA[>"));
});

test("the default cutoff is the first post Tumblr's own feed never delivered", () => {
  // One past "Stunning jellyfish at the aquarium" (826639118293516288), which
  // Tumblr's feed did deliver. Starting on that post would re-send it.
  assert.equal(DEFAULT_SINCE_POST_ID, "826644056326176768");
  assert.deepEqual(selectFeedPosts(ALL).map((p) => p.id), [AFTER.id]);
});

test("media types are derived from the file extension", () => {
  assert.equal(mimeFor("/media/1/a.webp"), "image/webp");
  assert.equal(mimeFor("/media/1/a.gif"), "image/gif");
  assert.equal(mimeFor("/media/1/a.mp4"), "video/mp4");
  assert.equal(mimeFor("/media/1/a.weird"), "application/octet-stream");
});

test("video containers Tumblr actually serves are typed as video", () => {
  // The first real video arrived as .mov, which was missing from the map and
  // so went out as an octet-stream, and therefore as medium="image".
  for (const ext of ["mp4", "m4v", "mov", "webm", "mkv", "avi", "ogv"]) {
    const type = mimeFor(`/media/1/clip.${ext}`);
    assert.ok(type.startsWith("video/"), `${ext} typed as ${type}`);
    const [m] = feedMedia({ videos: [{ src: `/media/1/clip.${ext}` }] }, "https://g/r", null, null);
    assert.equal(m.medium, "video", `${ext} announced as ${m.medium}`);
  }
});

test("audio is typed as audio", () => {
  for (const ext of ["mp3", "m4a", "aac", "wav", "flac", "oga"]) {
    const [m] = feedMedia({ videos: [{ src: `/media/1/a.${ext}` }] }, "https://g/r", null, null);
    assert.equal(m.medium, "audio", `${ext} announced as ${m.medium}`);
  }
});

test("structured media is absolute, typed and sized", () => {
  const media = feedMedia(
    {
      images: [{ src: "/media/1/a.webp", width: 1000, height: 750 }],
      videos: [{ src: "/media/1/b.mp4" }],
    },
    "https://guid.nz/rumblr",
    "/repo/media",
    (p) => (p === "/repo/media/1/a.webp" ? 47922 : null),
  );

  assert.deepEqual(media, [
    {
      url: "https://guid.nz/rumblr/media/1/a.webp",
      type: "image/webp",
      medium: "image",
      width: 1000,
      height: 750,
      length: 47922,
    },
    {
      url: "https://guid.nz/rumblr/media/1/b.mp4",
      type: "video/mp4",
      // A video declared as an image is what readers were previously told.
      medium: "video",
      width: null,
      height: null,
      length: null,
    },
  ]);
});

test("an unmeasurable file is still listed, just without a length", () => {
  const [m] = feedMedia(
    { images: [{ src: "/media/1/gone.webp" }] },
    "https://guid.nz/rumblr",
    "/repo/media",
    () => null,
  );
  assert.equal(m.url, "https://guid.nz/rumblr/media/1/gone.webp");
  assert.equal(m.length, null);
});

test("a post with no media yields none, so no empty enclosure is emitted", () => {
  assert.deepEqual(feedMedia({ caption: "text only" }, "https://x", "/m", () => 1), []);
});

test("a post's preview image is its first picture", () => {
  const p = previewImage({ images: [{ src: "/media/1/a.jpg", width: 800, height: 600 }] });
  assert.deepEqual(p, { src: "/media/1/a.jpg", width: 800, height: 600 });
});

test("a video-only post falls back to the video's poster", () => {
  // Without this the page advertises some other post's photograph as its
  // own, which is worse than advertising none.
  const p = previewImage({
    images: [],
    videos: [{ src: "/media/1/clip.mp4", poster: "/media/1/poster.jpg" }],
  });
  assert.deepEqual(p, { src: "/media/1/poster.jpg", width: null, height: null });
});

test("a post with nothing to show has no preview image", () => {
  assert.equal(previewImage({ images: [], videos: [] }), null);
  assert.equal(previewImage({ images: [], videos: [{ src: "/media/1/clip.mp4" }] }), null);
  assert.equal(previewImage(null), null);
});

test("an image is preferred over a video poster", () => {
  const p = previewImage({
    images: [{ src: "/media/1/a.jpg" }],
    videos: [{ src: "/media/1/c.mp4", poster: "/media/1/poster.jpg" }],
  });
  assert.equal(p.src, "/media/1/a.jpg");
});
