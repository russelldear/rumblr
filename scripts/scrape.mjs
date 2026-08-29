#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Parser from "rss-parser";

import { itemToPost } from "./lib/parse.mjs";
import { storeImage, storeFile, existingPostIds } from "./lib/media.mjs";

const ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const POSTS_DIR = path.join(ROOT, "data", "posts");
const MEDIA_ROOT = path.join(ROOT, "media");

const FEED_URL =
  process.env.FEED_URL || "https://feeds.feedburner.com/salaamji-updates";

async function main() {
  const parser = new Parser({
    timeout: 20000,
    headers: { "user-agent": "RumblrBot/0.1 (RSS mirror)" },
  });

  console.log(`Fetching ${FEED_URL}`);
  const feed = await parser.parseURL(FEED_URL);
  console.log(`Feed "${feed.title}" — ${feed.items.length} items`);

  await mkdir(POSTS_DIR, { recursive: true });
  const known = await existingPostIds(POSTS_DIR);

  let newPosts = 0;
  let newImages = 0;
  let unresolved = 0;

  for (const item of feed.items) {
    const post = itemToPost(item);
    if (!post.id) {
      console.warn("Skipping item with no derivable id:", item.link);
      continue;
    }
    if (known.has(post.id)) continue;

    console.log(`New post ${post.id} — ${post.title || "(untitled)"}`);

    const images = [];
    for (const img of post.images) {
      try {
        const stored = await storeImage({
          sourceUrl: img.sourceUrl,
          postId: post.id,
          mediaRoot: MEDIA_ROOT,
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

    const videos = [];
    for (const vid of post.videos) {
      try {
        const stored = await storeFile({
          sourceUrl: vid.sourceUrl,
          postId: post.id,
          mediaRoot: MEDIA_ROOT,
        });
        let poster = null;
        if (vid.poster) {
          try {
            poster = (
              await storeImage({ sourceUrl: vid.poster, postId: post.id, mediaRoot: MEDIA_ROOT })
            ).src;
          } catch {
            poster = vid.poster;
          }
        }
        videos.push({ src: stored.src, poster });
      } catch (err) {
        console.warn(`  video failed (${vid.sourceUrl}): ${err.message}`);
        videos.push({ src: vid.sourceUrl, poster: vid.poster, unresolved: true });
        unresolved++;
      }
    }

    const record = {
      id: post.id,
      source: post.source,
      permalink: post.permalink,
      publishedAt: post.publishedAt,
      scrapedAt: new Date().toISOString(),
      title: post.title,
      caption: post.caption,
      images,
      videos,
    };

    await writeFile(
      path.join(POSTS_DIR, `${post.id}.json`),
      JSON.stringify(record, null, 2) + "\n",
    );
    newPosts++;
  }

  console.log(
    `Done. ${newPosts} new post(s), ${newImages} image(s) stored, ${unresolved} unresolved.`,
  );

  // Expose a summary for CI (used to decide whether to commit).
  if (process.env.GITHUB_OUTPUT) {
    await writeFile(process.env.GITHUB_OUTPUT, `new_posts=${newPosts}\n`, { flag: "a" });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
