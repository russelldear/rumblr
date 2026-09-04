#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { fetchPosts, MAX_LIMIT, redact } from "./lib/tumblr.mjs";
import { apiPostToPost } from "./lib/parse.mjs";
import { storeImage, storeFile, existingPostIds } from "./lib/media.mjs";
import { readState, writeState, evaluate } from "./lib/pollState.mjs";

const ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const POSTS_DIR = path.join(ROOT, "data", "posts");
const MEDIA_ROOT = path.join(ROOT, "media");
const FEED_STATUS_FILE = path.join(ROOT, "data", "feed-status.json");
const POLL_STATE_FILE = path.join(ROOT, "data", "poll-state.json");

const BLOG = process.env.TUMBLR_BLOG || "salaamji.tumblr.com";
const API_KEY = process.env.TUMBLR_API_KEY;

// Safety ceiling on pagination. We stop as soon as a page contains a post we
// already have, so this only bites if the blog posted more than 100 times
// between runs, or on a first run against an empty repo.
const MAX_PAGES = intFromEnv("MAX_PAGES", 5);
// Counted in runs, not minutes, so this default tracks the poll interval:
// 72 runs at one every 5 minutes is roughly six hours of sustained failure.
const ALERT_AFTER_FAILURES = intFromEnv("ALERT_AFTER_FAILURES", 72);
// Re-alert cadence once past the threshold: ~24 hours at the same interval.
const ALERT_REPEAT_EVERY = intFromEnv("ALERT_REPEAT_EVERY", 288);

async function main() {
  await mkdir(POSTS_DIR, { recursive: true });

  const known = await existingPostIds(POSTS_DIR);
  const previous = await readState(POLL_STATE_FILE);
  const state = { ...previous };

  let newPosts = 0;
  let newImages = 0;
  let unresolved = 0;
  let totalPosts = null;
  let ok = false;
  let error = null;

  try {
    if (!API_KEY) {
      throw new Error(
        "TUMBLR_API_KEY is not set. Create an app at https://www.tumblr.com/oauth/apps " +
          "and use its OAuth consumer key.",
      );
    }

    // An empty repo means a first run. Take only the newest page rather than
    // paginating the whole blog: this mirror is forward-only by design.
    const pageLimit = known.size === 0 ? 1 : MAX_PAGES;
    const seen = [];
    // Within-run dedupe, kept separate from `known`. Offset pagination reads a
    // live list: a post published between two page fetches shifts the window,
    // so the next page repeats the previous page's last item. Counting that
    // repeat as "caught up" would stop pagination early and skip every older
    // post still outstanding.
    const seenIds = new Set();

    for (let page = 0; page < pageLimit; page++) {
      const result = await fetchPosts({
        blog: BLOG,
        apiKey: API_KEY,
        limit: MAX_LIMIT,
        offset: page * MAX_LIMIT,
      });

      if (page === 0) {
        totalPosts = result.totalPosts;
        console.log(
          `Blog "${result.blogTitle || BLOG}" — ${totalPosts ?? "?"} total post(s), ` +
            `${known.size} already mirrored`,
        );
      }

      if (result.posts.length === 0) break;

      let sawKnown = false;
      for (const apiPost of result.posts) {
        const post = apiPostToPost(apiPost);
        if (!post.id) {
          console.warn("Skipping post with no derivable id:", apiPost?.post_url);
          continue;
        }
        if (known.has(post.id)) {
          sawKnown = true;
          continue;
        }
        if (seenIds.has(post.id)) continue;
        seenIds.add(post.id);
        seen.push(post);
      }

      // Newest-first ordering means one known post on a page implies we have
      // caught up; anything older is already mirrored.
      if (sawKnown || result.posts.length < MAX_LIMIT) break;
    }

    // Write oldest-first so an interrupted run leaves a contiguous history
    // rather than a hole that the next run would skip past.
    for (const post of seen.reverse()) {
      console.log(`New post ${post.id} — ${post.title || "(untitled)"}`);
      const stored = await storePostMedia(post);
      newImages += stored.newImages;
      unresolved += stored.unresolved;

      await writeFile(
        path.join(POSTS_DIR, `${post.id}.json`),
        JSON.stringify(
          {
            id: post.id,
            source: post.source,
            permalink: post.permalink,
            publishedAt: post.publishedAt,
            scrapedAt: new Date().toISOString(),
            title: post.title,
            caption: post.caption,
            tags: post.tags,
            images: stored.images,
            videos: stored.videos,
          },
          null,
          2,
        ) + "\n",
      );
      newPosts++;
    }

    ok = true;
    state.consecutiveFailures = 0;
    state.lastError = null;
    state.failingSince = null;
    if (Number.isFinite(totalPosts)) state.totalPosts = totalPosts;
  } catch (err) {
    error = redact(err.message, API_KEY);
    console.warn(`Feed fetch failed: ${error}`);
    state.consecutiveFailures = previous.consecutiveFailures + 1;
    state.lastError = error;
    // Keep the start of the outage, not the time of the latest retry.
    state.failingSince = previous.failingSince || new Date().toISOString();
  }

  const { alert, reason } = evaluate({
    previous,
    current: state,
    newPosts,
    threshold: ALERT_AFTER_FAILURES,
    repeatEvery: ALERT_REPEAT_EVERY,
  });

  await writeState(POLL_STATE_FILE, state);

  // Volatile, gitignored: drives the "Last poll" line in the site footer.
  await writeFile(
    FEED_STATUS_FILE,
    JSON.stringify(
      {
        polledAt: new Date().toISOString(),
        ok,
        error,
        newPosts,
        totalPosts: state.totalPosts,
        mirroredPosts: known.size + newPosts,
        consecutiveFailures: state.consecutiveFailures,
      },
      null,
      2,
    ) + "\n",
  );

  console.log(
    `Done. ${newPosts} new post(s), ${newImages} image(s) stored, ${unresolved} unresolved, ` +
      `${state.consecutiveFailures} consecutive failure(s).`,
  );
  if (alert) console.error(`ALERT: ${reason}`);

  if (process.env.GITHUB_OUTPUT) {
    await writeFile(
      process.env.GITHUB_OUTPUT,
      `new_posts=${newPosts}\nshould_alert=${alert}\nalert_reason=${(reason || "").replace(/\n/g, " ")}\n`,
      { flag: "a" },
    );
  }
}

/** Download and store every image and video a post references. */
async function storePostMedia(post) {
  const images = [];
  const videos = [];
  let newImages = 0;
  let unresolved = 0;

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

  return { images, videos, newImages, unresolved };
}

function intFromEnv(name, fallback) {
  const n = parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
