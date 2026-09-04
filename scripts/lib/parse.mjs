/**
 * Turn a Tumblr API v2 post (Neue Post Format) into a post record.
 *
 * NPF gives structured content blocks, so there is no HTML to scrape and no
 * srcset to pick apart: image blocks carry every stored size with explicit
 * dimensions, and text blocks are already plain text.
 *
 * Spec: https://github.com/tumblr/docs/blob/master/npf-spec.md
 */

const TITLE_SUBTYPES = new Set(["heading1", "heading2"]);
const MAX_DERIVED_TITLE = 80;

/**
 * Post ids exceed Number.MAX_SAFE_INTEGER (they are 18 digits), so the `id`
 * field is already lossy by the time JSON.parse is done with it. `id_string`
 * is the only safe source.
 */
export function postId(post) {
  const id = post?.id_string;
  if (typeof id === "string" && /^\d+$/.test(id)) return id;
  // Fall back to the permalink rather than the corrupted numeric id.
  const m = String(post?.post_url || "").match(/\/post\/(\d+)/);
  return m ? m[1] : null;
}

/** Largest entry in an NPF media array (or a lone media object). */
export function largestMedia(media) {
  const list = Array.isArray(media) ? media : media ? [media] : [];
  let best = null;
  for (const m of list) {
    if (!m || typeof m.url !== "string" || !m.url) continue;
    const width = Number.isFinite(m.width) ? m.width : 0;
    if (!best || width > best.width) {
      best = { url: m.url, width, height: Number.isFinite(m.height) ? m.height : null };
    }
  }
  if (!best) return null;
  return { url: best.url, width: best.width || null, height: best.height };
}

/**
 * Walk NPF content blocks into { images, videos, captionBlocks, headings }.
 * Unknown block types are ignored rather than throwing, so a new block type
 * shipped by Tumblr degrades to a missing caption line, not a failed sync.
 */
export function parseContent(content) {
  const images = [];
  const videos = [];
  const captionBlocks = [];
  const headings = [];

  for (const block of Array.isArray(content) ? content : []) {
    if (!block || typeof block !== "object") continue;

    switch (block.type) {
      case "image": {
        const best = largestMedia(block.media);
        if (best) {
          images.push({
            sourceUrl: best.url,
            origWidth: best.width,
            origHeight: best.height,
            alt: typeof block.alt_text === "string" ? block.alt_text.trim() : "",
          });
        }
        break;
      }

      case "video": {
        // Tumblr-hosted videos have a media object we can mirror. External
        // embeds (YouTube, Vimeo) have no downloadable file, so record the
        // canonical link as a caption line instead of a broken <video>.
        const best = largestMedia(block.media);
        const poster = largestMedia(block.poster);
        if (best) {
          videos.push({ sourceUrl: best.url, poster: poster ? poster.url : null });
        } else if (typeof block.url === "string" && block.url) {
          captionBlocks.push(block.url);
        }
        break;
      }

      case "audio": {
        const best = largestMedia(block.media);
        if (best) {
          videos.push({ sourceUrl: best.url, poster: null });
        } else if (typeof block.url === "string" && block.url) {
          captionBlocks.push(block.url);
        }
        break;
      }

      case "link": {
        const label = [block.title, block.description].filter(Boolean).join(": ");
        const text = label || block.url;
        if (text) captionBlocks.push(String(text));
        break;
      }

      case "text": {
        const text = typeof block.text === "string" ? block.text.trim() : "";
        if (!text) break;
        if (TITLE_SUBTYPES.has(block.subtype)) headings.push(text);
        captionBlocks.push(text);
        break;
      }

      default:
        break;
    }
  }

  return { images, videos, captionBlocks, headings };
}

/**
 * Build a post record from an API post. Media is still unresolved at this
 * point: images/videos carry remote sourceUrls, not local paths.
 */
export function apiPostToPost(post) {
  const id = postId(post);

  // A reblog with no commentary of its own has empty content; the reblogged
  // material lives in the trail. Use the last trail entry so those posts
  // still mirror something rather than rendering as an empty article.
  let content = Array.isArray(post?.content) ? post.content : [];
  if (content.length === 0 && Array.isArray(post?.trail) && post.trail.length > 0) {
    const last = post.trail[post.trail.length - 1];
    if (Array.isArray(last?.content)) content = last.content;
  }

  const { images, videos, captionBlocks, headings } = parseContent(content);
  const caption = captionBlocks.join("\n\n").trim();

  return {
    id,
    source: "tumblr-api",
    permalink: typeof post?.post_url === "string" ? post.post_url : null,
    publishedAt: publishedAt(post),
    title: headings[0] || deriveTitle(caption),
    caption,
    images,
    videos,
    tags: Array.isArray(post?.tags) ? post.tags.filter((t) => typeof t === "string") : [],
  };
}

function publishedAt(post) {
  if (Number.isFinite(post?.timestamp)) {
    return new Date(post.timestamp * 1000).toISOString();
  }
  const parsed = post?.date ? new Date(post.date) : null;
  if (parsed && !Number.isNaN(parsed.getTime())) return parsed.toISOString();
  return new Date().toISOString();
}

/** Individual post pages use `title` for <title>; fall back to the caption. */
function deriveTitle(caption) {
  if (!caption) return "";
  const firstLine = caption.split("\n")[0].trim();
  if (firstLine.length <= MAX_DERIVED_TITLE) return firstLine;
  return firstLine.slice(0, MAX_DERIVED_TITLE).trimEnd() + "…";
}
