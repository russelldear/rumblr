import { createHash } from "node:crypto";
import { mkdir, writeFile, readdir } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";

const MAX_WIDTH = 1000;
// JPEG rather than WebP: some feed readers will not render WebP, and an image
// that does not appear in a subscriber's reader is worse than a larger file.
const JPEG_QUALITY = 85;
const USER_AGENT =
  "RumblrBot/1.0 (+https://github.com/russelldear/rumblr)";

async function fetchBuffer(url, { retries = 2 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, { headers: { "user-agent": USER_AGENT } });
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
      const arr = await res.arrayBuffer();
      return Buffer.from(arr);
    } catch (err) {
      lastErr = err;
      if (attempt < retries) await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
    }
  }
  throw lastErr;
}

/**
 * Download an image, resize/convert it, and write it under mediaDir/<postId>/.
 * Returns { src, width, height, bytes } with src as a root-relative path.
 */
export async function storeImage({ sourceUrl, postId, mediaRoot }) {
  const raw = await fetchBuffer(sourceUrl);

  let outBuf;
  let ext;
  let width = null;
  let height = null;

  const meta = await sharp(raw).metadata();
  const animated = (meta.pages || 1) > 1;

  if (animated) {
    // Animation cannot survive JPEG, so these keep their frames. Resizing them
    // is expensive and lossy, so the bytes pass through untouched. An animated
    // WebP is re-containered as a GIF, because nothing WebP may reach the feed.
    width = meta.width || null;
    height = meta.pageHeight || meta.height || null;
    if (meta.format === "webp") {
      try {
        outBuf = await sharp(raw, { animated: true }).gif().toBuffer();
        ext = "gif";
      } catch {
        outBuf = raw;
        ext = "webp";
      }
    } else {
      outBuf = raw;
      ext = "gif";
    }
  } else {
    const { data, info } = await sharp(raw)
      .rotate()
      .resize({ width: MAX_WIDTH, withoutEnlargement: true })
      // JPEG has no alpha; without this, transparency renders black.
      .flatten({ background: "#ffffff" })
      .jpeg({ quality: JPEG_QUALITY, mozjpeg: true })
      .toBuffer({ resolveWithObject: true });
    outBuf = data;
    ext = "jpg";
    width = info.width;
    height = info.height;
  }

  const hash = createHash("sha256").update(outBuf).digest("hex").slice(0, 40);
  const dir = path.join(mediaRoot, postId);
  await mkdir(dir, { recursive: true });
  const filename = `${hash}.${ext}`;
  await writeFile(path.join(dir, filename), outBuf);

  return {
    src: `/media/${postId}/${filename}`,
    width,
    height,
    bytes: outBuf.length,
  };
}

/**
 * Download a video/poster verbatim (no transcoding).
 */
export async function storeFile({ sourceUrl, postId, mediaRoot }) {
  const raw = await fetchBuffer(sourceUrl);
  const urlExt = path.extname(new URL(sourceUrl).pathname).replace(".", "") || "bin";
  const hash = createHash("sha256").update(raw).digest("hex").slice(0, 40);
  const dir = path.join(mediaRoot, postId);
  await mkdir(dir, { recursive: true });
  const filename = `${hash}.${urlExt}`;
  await writeFile(path.join(dir, filename), raw);
  return { src: `/media/${postId}/${filename}`, bytes: raw.length };
}

export async function existingPostIds(postsDir) {
  try {
    const files = await readdir(postsDir);
    return new Set(
      files.filter((f) => f.endsWith(".json")).map((f) => f.replace(/\.json$/, "")),
    );
  } catch (err) {
    if (err.code === "ENOENT") return new Set();
    throw err;
  }
}
