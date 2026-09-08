import { test, afterEach } from "node:test";
import assert from "node:assert/strict";

import { postExists } from "../scripts/lib/tumblr.mjs";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const ask = (responder) => {
  globalThis.fetch = responder;
  return postExists({ blog: "b.tumblr.com", apiKey: "K", id: "1", retries: 0, timeoutMs: 200 });
};

const envelope = (status, posts) =>
  Response.json({ meta: { status, msg: "" }, response: { posts } });

test("an HTTP 404 is the only thing that confirms a deletion", async () => {
  assert.equal(await ask(async () => new Response("not found", { status: 404 })), "gone");
});

test("a not-found reported inside a 200 envelope also counts", async () => {
  assert.equal(await ask(async () => envelope(404, [])), "gone");
});

test("a post that comes back is present", async () => {
  assert.equal(await ask(async () => envelope(200, [{ id_string: "1" }])), "present");
});

// Everything below must refuse to authorise a deletion. These are the cases
// where treating "no answer" as "deleted" would destroy content.
test("a server error is unknown, not gone", async () => {
  assert.equal(await ask(async () => new Response("boom", { status: 500 })), "unknown");
});

test("rate limiting is unknown, not gone", async () => {
  assert.equal(await ask(async () => new Response("slow down", { status: 429 })), "unknown");
});

test("an auth failure is unknown, not gone", async () => {
  // 401/403 mean the question could not be asked, not that the post is gone.
  assert.equal(await ask(async () => new Response("nope", { status: 401 })), "unknown");
  assert.equal(await ask(async () => new Response("nope", { status: 403 })), "unknown");
});

test("a network failure is unknown, not gone", async () => {
  assert.equal(
    await ask(async () => {
      throw new TypeError("fetch failed");
    }),
    "unknown",
  );
});

test("a non-JSON body is unknown, not gone", async () => {
  assert.equal(await ask(async () => new Response("<html>maintenance</html>")), "unknown");
});

test("a 200 carrying no post is unknown, not gone", async () => {
  // Not the documented shape for either answer, so it must not delete.
  assert.equal(await ask(async () => envelope(200, [])), "unknown");
});

test("the request asks for the specific id", async () => {
  let seen = null;
  globalThis.fetch = async (url) => {
    seen = new URL(String(url));
    return envelope(200, [{ id_string: "826917247804211200" }]);
  };
  await postExists({ blog: "b.tumblr.com", apiKey: "K", id: "826917247804211200", retries: 0 });
  assert.equal(seen.searchParams.get("id"), "826917247804211200");
  assert.match(seen.pathname, /\/v2\/blog\/b\.tumblr\.com\/posts$/);
});
