import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const FEED_STATUS_FILE = path.resolve(
  fileURLToPath(new URL("../../data/feed-status.json", import.meta.url)),
);

export default async function () {
  try {
    return JSON.parse(await readFile(FEED_STATUS_FILE, "utf8"));
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw err;
  }
}
