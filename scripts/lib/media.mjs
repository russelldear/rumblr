import { createHash } from "node:crypto";
import { mkdir, writeFile, readdir } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";

const MAX_WIDTH = 1000;
/**
 * Hard ceiling on a single downloaded file.
 *
 * GitHub refuses a push containing a file over 100 MB and warns above 50 MB.
 * Video arrives verbatim, with no transcoding, so without this a large clip
 * would be downloaded, committed, and then fail to push. Each run starts from
 * a fresh checkout, so that failure would repeat every five minutes forever
 * rather than being a single bad run.
 */
const MAX_MEDIA_BYTES = intFromEnv("MAX_MEDIA_BYTES", 50 * 1024 * 1024);

function intFromEnv(name, fallback) {
  const n = parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
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
      return await readCapped(res, url);
    } catch (err) {
      lastErr = err;
      // Too large is a fact about the file, not a transient failure.
      if (err.tooLarge) break;
      if (attempt < retries) await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
    }
  }
  throw lastErr;
}

/**
 * Read a response body, refusing anything past the size ceiling.
 *
 * The declared length is checked first so an oversized file costs nothing to
 * reject, and the running total is checked too, because Content-Length can be
 * absent or wrong and the point is to bound what reaches memory and disk.
 */
async function readCapped(res, url) {
  const tooLarge = (bytes) =>
    Object.assign(
      new Error(`${url} is ${bytes} bytes, over the ${MAX_MEDIA_BYTES} byte limit`),
      { tooLarge: true },
    );

  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_MEDIA_BYTES) throw tooLarge(declared);

  if (!res.body) {
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > MAX_MEDIA_BYTES) throw tooLarge(buf.length);
    return buf;
  }

  const chunks = [];
  let total = 0;
  for await (const chunk of res.body) {
    total += chunk.length;
    if (total > MAX_MEDIA_BYTES) {
      await res.body.cancel?.().catch(() => {});
      throw tooLarge(total);
    }
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
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

/**
 * Download and store every image and video a post references, returning the
 * record's media arrays. Shared by the scheduled sync and by a targeted
 * resync, so both store media identically.
 */
export async function storePostMedia(post, mediaRoot) {
  const images = [];
  const videos = [];
  let newImages = 0;
  let unresolved = 0;

  for (const img of post.images) {
    try {
      const stored = await storeImage({
        sourceUrl: img.sourceUrl,
        postId: post.id,
        mediaRoot,
      });
      images.push({
        src: stored.src,
        width: stored.width ?? img.origWidth ?? null,
        height: stored.height ?? img.origHeight ?? null,
        alt: img.alt || "",
      });
      newImages++;
    } catch (err) {
      console.warn(`  image failed (${img.sourceUrl}): ${err.message}`);
      images.push({
        src: img.sourceUrl,
        width: img.origWidth ?? null,
        height: img.origHeight ?? null,
        alt: img.alt || "",
        unresolved: true,
      });
      unresolved++;
    }
  }

  for (const vid of post.videos) {
    // The poster is stored first and independently. A video too large to
    // mirror should still leave the page, and its link preview, with a local
    // image rather than nothing.
    let poster = null;
    if (vid.poster) {
      try {
        poster = (await storeImage({ sourceUrl: vid.poster, postId: post.id, mediaRoot })).src;
      } catch (err) {
        console.warn(`  poster failed (${vid.poster}): ${err.message}`);
        poster = vid.poster;
      }
    }

    try {
      const stored = await storeFile({
        sourceUrl: vid.sourceUrl,
        postId: post.id,
        mediaRoot,
      });
      videos.push({ src: stored.src, poster });
    } catch (err) {
      // Keeping the remote URL means the video still plays, from Tumblr,
      // rather than the post losing it entirely.
      console.warn(`  video failed (${vid.sourceUrl}): ${err.message}`);
      videos.push({ src: vid.sourceUrl, poster, unresolved: true });
      unresolved++;
    }
  }

  return { images, videos, newImages, unresolved };
}
