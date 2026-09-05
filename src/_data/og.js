import posts from "./posts.js";

/**
 * Fallback preview image for pages that are not a single post: the newest
 * post that has one. Without an og:image a Slack unfurl renders as plain
 * text, which is what a link to the site would otherwise look like.
 */
export default async function () {
  for (const post of await posts()) {
    const img = (post.images || [])[0];
    if (img?.src) return { image: img.src, width: img.width, height: img.height };
  }
  return { image: null, width: null, height: null };
}
