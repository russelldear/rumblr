#!/usr/bin/env node
import { mkdir, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { fetchPosts, postExists, MAX_LIMIT, redact } from "./lib/tumblr.mjs";
import { apiPostToPost } from "./lib/parse.mjs";
import { storeImage, storeFile, existingPostIds } from "./lib/media.mjs";
import { readState, writeState, evaluate } from "./lib/pollState.mjs";
import {
  deletionsToApply,
  isComplete,
  oldestId,
  checkDeletionSafety,
  DEFAULT_MAX_DELETIONS,
} from "./lib/reconcile.mjs";

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
// Deleting a post on Tumblr is how a post leaves the mirror. A batch larger
// than this stops and alerts instead, since it is indistinguishable from a
// bad API response.
const MAX_DELETIONS = intFromEnv("MAX_DELETIONS", DEFAULT_MAX_DELETIONS);
const DELETE_DRY_RUN = /^(1|true|yes)$/i.test(process.env.DELETE_DRY_RUN || "");
// Re-alert cadence once past the threshold: ~24 hours at the same interval.
const ALERT_REPEAT_EVERY = intFromEnv("ALERT_REPEAT_EVERY", 288);

async function main() {
  await mkdir(POSTS_DIR, { recursive: true });

  const known = await existingPostIds(POSTS_DIR);
  const previous = await readState(POLL_STATE_FILE);
  const state = { ...previous };

  let newPosts = 0;
  let deletedPosts = 0;
  let skippedDeletions = 0;
  let blockedReason = null;
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
    // Every upstream id this run has laid eyes on, and the oldest of them.
    // Together they bound what can be concluded about deletions.
    const upstreamIds = new Set();

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
        upstreamIds.add(post.id);
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

    // Reconcile deletions. Deleting on Tumblr is the only way a post leaves
    // the mirror, so absence upstream is the signal. It is treated carefully:
    // absence is also what a broken API response looks like.
    const localIds = new Set([...known, ...seenIds]);
    // "Complete" has to be earned by counting, never inferred from a page
    // being short or empty. A broken response returns no posts, which looks
    // identical to a walk that finished, and would read as "all deleted".
    let complete = isComplete({ upstreamCount: upstreamIds.size, totalPosts });
    const floor = oldestId(upstreamIds);

    let doomed = deletionsToApply({
      localIds,
      upstreamIds,
      windowFloor: floor,
      complete,
    });

    // Anything older than the fetched window is invisible to the check above.
    // A local count above total_posts is what says one of those is gone, and
    // is the only thing that buys the extra API calls of a full walk.
    const afterWindow = localIds.size - doomed.length;
    if (!complete && Number.isFinite(totalPosts) && afterWindow > totalPosts) {
      console.log(
        `${afterWindow} mirrored but ${totalPosts} upstream: walking the blog to find the difference`,
      );
      const all = await collectUpstreamIds(totalPosts);
      // The walk must plausibly have seen the blog. Coming back far short of
      // total_posts is a fault, not a mass deletion, and must delete nothing.
      if (all.size < totalPosts - MAX_DELETIONS) {
        blockedReason =
          `Full walk saw ${all.size} post(s) but total_posts is ${totalPosts}; ` +
          `skipped reconcile rather than risk deleting on a bad response.`;
        console.error(blockedReason);
      } else {
        complete = true;
        doomed = deletionsToApply({ localIds, upstreamIds: all, complete: true });
      }
    }

    if (doomed.length > 0 && !blockedReason) {
      const verdict = checkDeletionSafety(doomed, { max: MAX_DELETIONS });
      if (!verdict.safe) {
        blockedReason = verdict.reason;
        console.error(blockedReason);
      } else {
        for (const id of doomed) {
          // Absence from a listing is inference. Ask about the post itself
          // before removing it: a different question down a different path,
          // so a fault in the pagination logic cannot delete anything on its
          // own. Only an explicit 404 counts as confirmation.
          const upstream = await postExists({ blog: BLOG, apiKey: API_KEY, id });
          if (upstream !== "gone") {
            console.warn(
              `  ${id} looked deleted, but asking upstream directly says "${upstream}". Leaving it.`,
            );
            skippedDeletions++;
            continue;
          }
          console.log(
            `Confirmed deleted upstream, removing ${id}${DELETE_DRY_RUN ? " (dry run)" : ""}`,
          );
          if (!DELETE_DRY_RUN) {
            await rm(path.join(POSTS_DIR, `${id}.json`), { force: true });
            await rm(path.join(MEDIA_ROOT, id), { recursive: true, force: true });
          }
          deletedPosts++;
        }
      }
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

  let { alert, reason } = evaluate({
    previous,
    current: state,
    newPosts,
    threshold: ALERT_AFTER_FAILURES,
    repeatEvery: ALERT_REPEAT_EVERY,
  });

  // A reconcile that refused to act needs a person, not a silent green run.
  if (blockedReason) {
    alert = true;
    reason = blockedReason;
  }

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
        mirroredPosts: known.size + newPosts - deletedPosts,
        consecutiveFailures: state.consecutiveFailures,
      },
      null,
      2,
    ) + "\n",
  );

  console.log(
    `Done. ${newPosts} new post(s), ${deletedPosts} removed` +
      `${skippedDeletions ? ` (${skippedDeletions} unconfirmed, kept)` : ""}, ` +
      `${newImages} image(s) stored, ${unresolved} unresolved, ` +
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

/**
 * Every upstream post id, by paging through the whole blog. Only used when a
 * count mismatch says an older post has been deleted, so the steady-state
 * cost of the sync stays at a single API call.
 */
async function collectUpstreamIds(total) {
  const ids = new Set();
  const pages = Math.ceil((total || 0) / MAX_LIMIT);
  for (let page = 0; page < pages; page++) {
    const result = await fetchPosts({
      blog: BLOG,
      apiKey: API_KEY,
      limit: MAX_LIMIT,
      offset: page * MAX_LIMIT,
    });
    if (result.posts.length === 0) break;
    for (const apiPost of result.posts) {
      const id = apiPostToPost(apiPost).id;
      if (id) ids.add(id);
    }
  }
  return ids;
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
