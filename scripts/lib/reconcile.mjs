/**
 * Working out which mirrored posts have been deleted upstream.
 *
 * Deleting on Tumblr is the only way to remove a post from the mirror, so the
 * sync has to notice absence. Absence is a dangerous signal: a truncated or
 * empty API response looks exactly like "the blog was emptied". Everything
 * here is therefore built to say "I don't know" rather than to guess.
 *
 * Two things make it cheap. The sync already fetches the newest page and
 * already reads total_posts, so deletions inside that window cost no extra
 * API calls, and a count mismatch is what says an older one needs looking for.
 */

/** Refuse to remove more than this in one run without being told to. */
export const DEFAULT_MAX_DELETIONS = 5;

/**
 * Local posts that upstream no longer has.
 *
 * With `complete`, every upstream id was seen and anything missing is gone.
 * Otherwise only the fetched window can be judged: a local post older than
 * the oldest id fetched was simply never looked at, and must be left alone.
 */
export function deletionsToApply({ localIds, upstreamIds, windowFloor, complete = false }) {
  const upstream = upstreamIds instanceof Set ? upstreamIds : new Set(upstreamIds || []);
  const ids = [...(localIds || [])].filter((id) => /^\d+$/.test(String(id)));

  if (!complete && (windowFloor == null || !/^\d+$/.test(String(windowFloor)))) {
    return []; // No window and no full walk: nothing can be concluded.
  }
  const floor = complete ? null : BigInt(windowFloor);

  return ids
    .filter((id) => !upstream.has(id) && (complete || BigInt(id) >= floor))
    .sort();
}

/**
 * Whether the ids collected this run account for the whole blog.
 *
 * This has to be earned by counting. Inferring it from a page being short or
 * empty is how a broken response gets mistaken for a mass deletion: no posts
 * came back, so every mirrored post looks absent.
 */
export function isComplete({ upstreamCount, totalPosts }) {
  return Number.isFinite(totalPosts) && upstreamCount >= totalPosts;
}

/** The oldest id in a set, as a string, or null when empty. */
export function oldestId(ids) {
  let min = null;
  for (const id of ids || []) {
    if (!/^\d+$/.test(String(id))) continue;
    const v = BigInt(id);
    if (min === null || v < min) min = v;
  }
  return min === null ? null : String(min);
}

/**
 * Whether a set of deletions is safe to carry out unattended.
 *
 * A large batch is indistinguishable from an API fault, so it stops and asks
 * rather than acting. Nothing is deleted in that case.
 */
export function checkDeletionSafety(deletions, { max = DEFAULT_MAX_DELETIONS } = {}) {
  if (deletions.length === 0) return { safe: true, reason: null };
  if (deletions.length > max) {
    return {
      safe: false,
      reason:
        `Upstream is missing ${deletions.length} mirrored post(s), more than the ` +
        `limit of ${max}. Refusing to delete in case this is a bad API response. ` +
        `Raise MAX_DELETIONS to proceed if the removals are genuine.`,
    };
  }
  return { safe: true, reason: null };
}
