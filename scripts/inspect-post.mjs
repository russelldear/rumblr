#!/usr/bin/env node
/**
 * Print a post's raw NPF exactly as the API returns it.
 *
 * Read-only. Nothing is written, downloaded or committed.
 *
 * Every content surprise in this project (WebP, .mov, third-party audio) was
 * a block shape nobody had looked at before a parser branch was written
 * against it. This is for looking first.
 *
 *   node scripts/inspect-post.mjs            # the newest post
 *   node scripts/inspect-post.mjs <id|URL>   # a specific one
 */
import { fetchPost, fetchPosts, redact } from "./lib/tumblr.mjs";
import { normalisePostId } from "./lib/feed.mjs";

const BLOG = process.env.TUMBLR_BLOG || "salaamji.tumblr.com";
const API_KEY = process.env.TUMBLR_API_KEY;

async function main() {
  if (!API_KEY) throw new Error("TUMBLR_API_KEY is not set.");
  const raw = process.argv[2] || process.env.POST_ID || "";

  let post;
  if (raw.trim()) {
    const id = normalisePostId(raw);
    if (!id) throw new Error(`Could not read a post id from ${JSON.stringify(raw)}`);
    post = await fetchPost({ blog: BLOG, apiKey: API_KEY, id });
    if (!post) throw new Error(`Post ${id} does not exist upstream.`);
  } else {
    const { posts } = await fetchPosts({ blog: BLOG, apiKey: API_KEY, limit: 1 });
    post = posts[0];
    if (!post) throw new Error("The blog returned no posts.");
  }

  console.log(`id         ${post.id_string}`);
  console.log(`url        ${post.post_url}`);
  console.log(`type       ${post.type}`);
  console.log(`date       ${post.date}`);
  console.log(`tags       ${JSON.stringify(post.tags || [])}`);
  console.log(`blocks     ${(post.content || []).map((b) => b?.type).join(", ") || "(none)"}`);
  console.log("");
  console.log("content:");
  console.log(JSON.stringify(post.content ?? null, null, 2));

  if (Array.isArray(post.trail) && post.trail.length) {
    console.log("");
    console.log("trail:");
    console.log(JSON.stringify(post.trail.map((t) => t?.content ?? null), null, 2));
  }
}

main().catch((err) => {
  console.error(redact(err.message, API_KEY));
  process.exit(1);
});
