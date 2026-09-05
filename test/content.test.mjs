import { test } from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Invariants over the committed content, not over any one function. These run
// in CI on every sync, which is the moment a bad record would first appear.

const ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const POSTS = path.join(ROOT, "data", "posts");

async function records() {
  const files = (await readdir(POSTS)).filter((f) => f.endsWith(".json"));
  return Promise.all(
    files.map(async (f) => JSON.parse(await readFile(path.join(POSTS, f), "utf8"))),
  );
}

function localPaths(rec) {
  const out = [];
  for (const img of rec.images || []) if (img.src?.startsWith("/")) out.push(img.src);
  for (const v of rec.videos || []) {
    if (v.src?.startsWith("/")) out.push(v.src);
    if (v.poster?.startsWith("/")) out.push(v.poster);
  }
  return out;
}

test("no post references a WebP file", async () => {
  // Feed readers would not render WebP, which is why images are stored as
  // JPEG. A stray one here means it reached a subscriber as a blank space.
  // The likely cause is a post captured before the JPEG switch, or the
  // animated-WebP fallback in storeImage firing because GIF encoding failed.
  const offenders = [];
  for (const rec of await records()) {
    for (const p of localPaths(rec)) if (p.endsWith(".webp")) offenders.push(`${rec.id} ${p}`);
  }
  assert.deepEqual(offenders, [], `WebP still referenced by:\n  ${offenders.join("\n  ")}`);
});

test("every referenced media file exists on disk", async () => {
  const missing = [];
  for (const rec of await records()) {
    for (const p of localPaths(rec)) {
      try {
        await stat(path.join(ROOT, p.replace(/^\//, "")));
      } catch {
        missing.push(`${rec.id} ${p}`);
      }
    }
  }
  assert.deepEqual(missing, [], `Missing media:\n  ${missing.join("\n  ")}`);
});
