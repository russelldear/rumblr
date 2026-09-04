/**
 * Durable poll state, committed to the repo.
 *
 * Deliberately carries no "last polled" timestamp. If it did, every hourly
 * run would rewrite the file and produce a commit, so the repo would fill
 * with noise and a real change would be invisible. As written, a successful
 * poll that finds nothing new leaves the file byte-identical and commits
 * nothing.
 *
 * The volatile half (polledAt, per-run detail for the site footer) lives in
 * the gitignored data/feed-status.json instead.
 */
import { readFile, writeFile } from "node:fs/promises";

export const DEFAULT_STATE = {
  consecutiveFailures: 0,
  lastError: null,
  failingSince: null,
  totalPosts: null,
};

export async function readState(file) {
  try {
    const parsed = JSON.parse(await readFile(file, "utf8"));
    return { ...DEFAULT_STATE, ...parsed };
  } catch (err) {
    if (err.code === "ENOENT") return { ...DEFAULT_STATE };
    throw err;
  }
}

export async function writeState(file, state) {
  await writeFile(file, JSON.stringify(state, null, 2) + "\n");
}

/**
 * Decide whether this run deserves to break the build.
 *
 * Two things are worth an alert, and nothing else is:
 *
 *  - Retrieval has been failing for `threshold` runs in a row. A single
 *    blip is noise; a sustained outage is the thing that went unnoticed
 *    for two days last time.
 *  - The blog's total_posts went up but we captured nothing. That means a
 *    post exists that we did not see, which no amount of green runs would
 *    otherwise reveal. RSS could never tell us this.
 *
 * Once past the threshold it re-alerts only every `repeatEvery` runs, so a
 * long outage does not send an email every hour.
 */
export function evaluate({ previous, current, newPosts, threshold, repeatEvery = 288 }) {
  const failing = current.consecutiveFailures;

  if (failing > 0) {
    const crossed = failing === threshold;
    const periodic = failing > threshold && (failing - threshold) % repeatEvery === 0;
    if (crossed || periodic) {
      return {
        alert: true,
        reason:
          `Feed retrieval has failed ${failing} consecutive time(s)` +
          `${current.failingSince ? ` since ${current.failingSince}` : ""}. ` +
          `Last error: ${current.lastError}`,
      };
    }
    return { alert: false, reason: null };
  }

  const before = previous.totalPosts;
  const after = current.totalPosts;
  if (Number.isFinite(before) && Number.isFinite(after) && after > before && newPosts === 0) {
    return {
      alert: true,
      reason:
        `Blog total_posts rose from ${before} to ${after} but no new posts were captured. ` +
        `Posts are being missed.`,
    };
  }

  return { alert: false, reason: null };
}
