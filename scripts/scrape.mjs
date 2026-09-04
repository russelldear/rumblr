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
const FEED_STATUS_FILE = path.join(ROOT, "data", "feed-status.json");

const DEFAULT_FEED_URLS = [
  "https://feeds.feedburner.com/salaamji-updates",
  "https://salaamji.tumblr.com/rss",
];
const FEED_URLS = (process.env.FEED_URLS || process.env.FEED_URL || DEFAULT_FEED_URLS.join(","))
  .split(/[,\n]/)
  .map((v) => v.trim())
  .filter(Boolean);

const FEED_HEADERS = {
  "user-agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36",
  accept: "application/rss+xml, application/xml;q=0.9, text/xml;q=0.8, */*;q=0.5",
  "accept-language": "en-US,en;q=0.9",
  "cache-control": "no-cache",
  pragma: "no-cache",
};

async function main() {
  const parser = new Parser({
    timeout: 20000,
    headers: FEED_HEADERS,
  });

  if (FEED_URLS.length === 0) {
    throw new Error("No feed URLs configured.");
  }

  await mkdir(POSTS_DIR, { recursive: true });
  const known = await existingPostIds(POSTS_DIR);

  let newPosts = 0;
  let newImages = 0;
  let unresolved = 0;
  let duplicates = 0;
  const feedStatus = [];

  for (const feedUrl of FEED_URLS) {
    console.log(`Fetching ${feedUrl}`);

    let feed;
    try {
      feed = await parser.parseURL(feedUrl);
    } catch (err) {
      console.warn(`Feed fetch failed (${feedUrl}): ${err.message}`);
      feedStatus.push({ url: feedUrl, ok: false, error: err.message });
      continue;
    }

    console.log(`Feed "${feed.title}" — ${feed.items.length} items`);
    feedStatus.push({ url: feedUrl, ok: true, title: feed.title, itemCount: feed.items.length });

    for (const item of feed.items) {
      const post = itemToPost(item);
      if (!post.id) {
        console.warn("Skipping item with no derivable id:", item.link);
        continue;
      }
      if (known.has(post.id)) {
        duplicates++;
        continue;
      }

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
      known.add(post.id);
      newPosts++;
    }
  }

  const okCount = feedStatus.filter((f) => f.ok).length;
  const failedCount = feedStatus.length - okCount;
  await writeFile(
    FEED_STATUS_FILE,
    JSON.stringify(
      {
        polledAt: new Date().toISOString(),
        ok: failedCount === 0,
        okCount,
        failedCount,
        feeds: feedStatus,
      },
      null,
      2,
    ) + "\n",
  );

  console.log(
    `Done. ${newPosts} new post(s), ${duplicates} duplicate(s), ${newImages} image(s) stored, ${unresolved} unresolved, ${failedCount} feed failure(s).`,
  );

  // Expose a summary for CI (used to decide whether to commit).
  if (process.env.GITHUB_OUTPUT) {
    await writeFile(
      process.env.GITHUB_OUTPUT,
      `new_posts=${newPosts}\nfailed_feeds=${failedCount}\n`,
      { flag: "a" },
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
