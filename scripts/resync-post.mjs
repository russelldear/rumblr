#!/usr/bin/env node
/**
 * Re-fetch one post and rewrite its stored record.
 *
 * The scheduled sync has no edit detection, and the Tumblr API exposes no edit
 * timestamp to build one from, so an edited post keeps whatever it was
 * mirrored with. This is the manual escape hatch.
 *
 * It fetches by id rather than by paging, so it works on any post regardless
 * of age. Deleting a record and waiting for the sync only works for posts
 * still inside the fetch window; for an older one the sync stops at the first
 * post it already has and the record is simply lost.
 *
 *   node scripts/resync-post.mjs <post id or Tumblr URL>
 */
import { readFile, writeFile, readdir, unlink, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { fetchPost, redact } from "./lib/tumblr.mjs";
import { apiPostToPost } from "./lib/parse.mjs";
import { storePostMedia } from "./lib/media.mjs";
import { normalisePostId } from "./lib/feed.mjs";

const ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const POSTS_DIR = path.join(ROOT, "data", "posts");
const MEDIA_ROOT = path.join(ROOT, "media");

const BLOG = process.env.TUMBLR_BLOG || "salaamji.tumblr.com";
const API_KEY = process.env.TUMBLR_API_KEY;

async function main() {
  const raw = process.argv[2] || process.env.POST_ID;
  const id = normalisePostId(raw);
  if (!id) {
    throw new Error(`Could not read a post id from ${JSON.stringify(raw ?? null)}`);
  }
  if (!API_KEY) throw new Error("TUMBLR_API_KEY is not set.");

  const recordPath = path.join(POSTS_DIR, `${id}.json`);
  const before = await readJson(recordPath);
  if (!before) console.log(`No existing record for ${id}; it will be created.`);

  const apiPost = await fetchPost({ blog: BLOG, apiKey: API_KEY, id });
  if (!apiPost) {
    // Deleting is the sync's job, and only after its own confirmation. This
    // says what it found and changes nothing.
    console.log(`Post ${id} no longer exists upstream. Nothing resynced.`);
    console.log("The scheduled sync removes deleted posts on its own.");
    await emitOutputs({ changed: false, missing: true });
    return;
  }

  const post = apiPostToPost(apiPost);
  if (post.id !== id) {
    throw new Error(`Asked for ${id} but the API returned ${post.id}`);
  }

  await mkdir(POSTS_DIR, { recursive: true });
  const stored = await storePostMedia(post, MEDIA_ROOT);
  const after = {
    id: post.id,
    source: post.source,
    permalink: post.permalink,
    publishedAt: post.publishedAt,
    // Keep the original capture time; this is the same post, re-read.
    scrapedAt: before?.scrapedAt || new Date().toISOString(),
    resyncedAt: new Date().toISOString(),
    title: post.title,
    caption: post.caption,
    tags: post.tags,
    images: stored.images,
    videos: stored.videos,
  };

  const changes = describeChanges(before, after);
  await writeFile(recordPath, JSON.stringify(after, null, 2) + "\n");
  await pruneMedia(id, after);

  if (changes.length === 0) {
    console.log(`Post ${id} resynced; nothing changed.`);
  } else {
    console.log(`Post ${id} resynced. Changed: ${changes.join(", ")}`);
    for (const field of changes) {
      if (field === "images" || field === "videos") continue;
      console.log(`  ${field}:`);
      console.log(`    was: ${JSON.stringify(before?.[field] ?? null)}`);
      console.log(`    now: ${JSON.stringify(after[field])}`);
    }
  }
  await emitOutputs({ changed: changes.length > 0, missing: false, changes });
}

/** Which stored fields differ. Media compares by resolved path. */
export function describeChanges(before, after) {
  if (!before) return ["created"];
  const out = [];
  for (const field of ["title", "caption", "permalink", "publishedAt"]) {
    if ((before[field] ?? null) !== (after[field] ?? null)) out.push(field);
  }
  if (JSON.stringify(before.tags ?? []) !== JSON.stringify(after.tags ?? [])) out.push("tags");
  if (srcs(before.images) !== srcs(after.images)) out.push("images");
  if (srcs(before.videos) !== srcs(after.videos)) out.push("videos");
  return out;
}

const srcs = (list) => JSON.stringify((list || []).map((m) => m.src));

/**
 * Drop media the rewritten record no longer points at. Filenames are content
 * hashes, so an unchanged image keeps its path and survives this untouched.
 */
async function pruneMedia(id, record) {
  const dir = path.join(MEDIA_ROOT, id);
  const keep = new Set();
  for (const m of [...(record.images || []), ...(record.videos || [])]) {
    for (const p of [m.src, m.poster]) {
      if (typeof p === "string" && p.startsWith("/")) keep.add(path.basename(p));
    }
  }
  let files;
  try {
    files = await readdir(dir);
  } catch {
    return;
  }
  for (const file of files) {
    if (keep.has(file)) continue;
    console.log(`  removing superseded media ${file}`);
    await unlink(path.join(dir, file));
  }
}

async function readJson(file) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw err;
  }
}

async function emitOutputs({ changed, missing, changes = [] }) {
  if (!process.env.GITHUB_OUTPUT) return;
  await writeFile(
    process.env.GITHUB_OUTPUT,
    `changed=${changed}\nmissing=${missing}\nchanged_fields=${changes.join(" ")}\n`,
    { flag: "a" },
  );
}

// Only run when invoked directly, so the helpers above stay importable.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(redact(err.message, API_KEY));
    process.exit(1);
  });
}
