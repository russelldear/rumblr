import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const POSTS_DIR = path.resolve(
  fileURLToPath(new URL("../../data/posts", import.meta.url)),
);

export default async function () {
  let files;
  try {
    files = await readdir(POSTS_DIR);
  } catch (err) {
    if (err.code === "ENOENT") return [];
    throw err;
  }

  const posts = await Promise.all(
    files
      .filter((f) => f.endsWith(".json"))
      .map(async (f) => JSON.parse(await readFile(path.join(POSTS_DIR, f), "utf8"))),
  );

  posts.sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt));
  return posts;
}
