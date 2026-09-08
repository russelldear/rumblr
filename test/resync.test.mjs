import { test, afterEach } from "node:test";
import assert from "node:assert/strict";

import { describeChanges } from "../scripts/resync-post.mjs";
import { fetchPost } from "../scripts/lib/tumblr.mjs";

const base = {
  title: "A", caption: "A", permalink: "https://x/1", publishedAt: "2026-09-05T12:00:00.000Z",
  tags: ["t"], images: [{ src: "/media/1/a.jpg" }], videos: [],
};
const copy = (over) => ({ ...base, ...over });

test("an unchanged post reports no changes", () => {
  assert.deepEqual(describeChanges(base, copy({})), []);
});

test("an edited caption is reported", () => {
  assert.deepEqual(describeChanges(base, copy({ caption: "B" })), ["caption"]);
});

test("a swapped image is reported, by path", () => {
  assert.deepEqual(describeChanges(base, copy({ images: [{ src: "/media/1/b.jpg" }] })), ["images"]);
});

test("an image whose bytes are identical is not a change", () => {
  // Filenames are content hashes, so re-downloading the same picture lands on
  // the same path and must not register as an edit.
  assert.deepEqual(describeChanges(base, copy({ images: [{ src: "/media/1/a.jpg" }] })), []);
});

test("tags and permalink changes are reported", () => {
  assert.deepEqual(describeChanges(base, copy({ tags: ["t", "u"] })), ["tags"]);
  assert.deepEqual(describeChanges(base, copy({ permalink: "https://x/2" })), ["permalink"]);
});

test("a post with no prior record reads as created", () => {
  assert.deepEqual(describeChanges(null, base), ["created"]);
});

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});
const get = (responder) => {
  globalThis.fetch = responder;
  return fetchPost({ blog: "b", apiKey: "K", id: "1", retries: 0, timeoutMs: 200 });
};

test("fetchPost returns null for a post that is gone", async () => {
  assert.equal(await get(async () => new Response("nope", { status: 404 })), null);
  assert.equal(
    await get(async () => Response.json({ meta: { status: 404 }, response: {} })),
    null,
  );
});

test("fetchPost returns the post when it exists", async () => {
  const post = await get(async () =>
    Response.json({ meta: { status: 200 }, response: { posts: [{ id_string: "1" }] } }),
  );
  assert.equal(post.id_string, "1");
});

test("fetchPost throws rather than guessing when it cannot tell", async () => {
  // A resync is watched by a person, so an unclear answer should be loud
  // rather than quietly leaving the record as it was.
  await assert.rejects(() => get(async () => new Response("boom", { status: 500 })));
  await assert.rejects(() =>
    get(async () => Response.json({ meta: { status: 200 }, response: { posts: [] } })),
  );
  await assert.rejects(() =>
    get(async () => {
      throw new TypeError("fetch failed");
    }),
  );
});
