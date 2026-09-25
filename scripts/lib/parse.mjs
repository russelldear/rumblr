/**
 * Turn a Tumblr API v2 post (Neue Post Format) into a post record.
 *
 * NPF gives structured content blocks, so there is no HTML to scrape and no
 * srcset to pick apart: image blocks carry every stored size with explicit
 * dimensions, and text blocks are already plain text.
 *
 * Spec: https://github.com/tumblr/docs/blob/master/npf-spec.md
 */

import { escapeHtml, safeHref } from "./html.mjs";

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
 * Render a text block's inline formatting as HTML.
 *
 * Only `link` ranges are honoured. Bold, italic, colour and the rest are
 * dropped, exactly as they were before this existed; the text still renders,
 * just unstyled.
 *
 * The offsets are code points, not UTF-16 code units. The NPF spec is explicit
 * about it: "Unicode code points are always treated as one character in this
 * indexing", with an emoji given as an example of a single character. Slicing
 * the JS string directly would therefore drift by one position per astral
 * character appearing before a link, so the text is split into code points
 * first. Ranges are inclusive at the start and exclusive at the end.
 *
 * Anything malformed is skipped rather than thrown: a range with a bad index,
 * an unusable URL, or one overlapping a range already emitted. The caller gets
 * escaped text with fewer links, never a failed sync.
 */
export function inlineHtml(text, formatting) {
  const chars = Array.from(String(text ?? ""));

  const ranges = (Array.isArray(formatting) ? formatting : [])
    .filter((f) => f && f.type === "link")
    .map((f) => ({ start: f.start, end: f.end, href: safeHref(f.url) }))
    .filter(
      (r) =>
        r.href &&
        Number.isInteger(r.start) &&
        Number.isInteger(r.end) &&
        r.start >= 0 &&
        r.start < r.end &&
        r.end <= chars.length,
    )
    .sort((a, b) => a.start - b.start);

  let out = "";
  let at = 0;
  for (const r of ranges) {
    if (r.start < at) continue;
    out += escapeHtml(chars.slice(at, r.start).join(""));
    const label = escapeHtml(chars.slice(r.start, r.end).join(""));
    out += `<a href="${escapeHtml(r.href)}">${label}</a>`;
    at = r.end;
  }
  return out + escapeHtml(chars.slice(at).join(""));
}

/**
 * Walk NPF content blocks into
 * { images, videos, links, captionBlocks, headings, trackTitles }.
 * Unknown block types are ignored rather than throwing, so a new block type
 * shipped by Tumblr degrades to a missing caption line, not a failed sync.
 */
export function parseContent(content) {
  const images = [];
  const videos = [];
  const links = [];
  const captionBlocks = [];
  const captionHtmlBlocks = [];
  const headings = [];
  const trackTitles = [];

  // The two caption arrays stay index-aligned: every plain line has an HTML
  // counterpart, which is just the escaped line unless a text block carried
  // inline formatting.
  const pushCaption = (plain, html) => {
    captionBlocks.push(plain);
    captionHtmlBlocks.push(html ?? escapeHtml(plain));
  };

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
          pushCaption(block.url);
        }
        break;
      }

      case "audio": {
        // Third-party audio (Spotify, SoundCloud) carries no downloadable
        // media, so there is nothing to mirror. What makes the post readable
        // is the track details, carried as the link's text: Tumblr's own
        // display_text is a generic "Listen on Spotify", and the bare URL is
        // worse still.
        //
        // The block's album art is deliberately ignored. Tumblr rehosts it and
        // it could be mirrored, but a cover thumbnail beside the photograph
        // the post is actually about is noise.
        const best = largestMedia(block.media);
        if (best) videos.push({ sourceUrl: best.url, poster: null });

        const described = [block.artist, block.title].filter(Boolean).join(" — ");

        const href = block.url || block.attribution?.url;
        if (typeof href === "string" && href) {
          links.push({
            url: href,
            label: described || block.attribution?.display_text || href,
          });
        }

        // The track details are the link's text, so repeating them as a
        // caption line would print the same string twice. They are still the
        // best title a track-only post has, hence trackTitles rather than
        // dropping them: without a caption to derive from, the title would
        // fall back to the post's date.
        if (described && !href) pushCaption(described);
        if (described) trackTitles.push(described);
        break;
      }

      case "link": {
        // The url is the only field the spec requires, and Tumblr fills the
        // title in from OpenGraph, so the old `label || block.url` discarded
        // the link on every well-formed block and left bare text behind.
        const label = [block.title, block.description].filter(Boolean).join(": ");
        if (typeof block.url === "string" && block.url) {
          links.push({ url: block.url, label: label || block.url });
        } else if (label) {
          pushCaption(label);
        }
        break;
      }

      case "text": {
        // Formatting offsets index the raw text, so the trim happens after the
        // ranges are applied, not before: trimming first would shift every
        // index by the leading whitespace.
        const raw = typeof block.text === "string" ? block.text : "";
        const text = raw.trim();
        if (!text) break;
        if (TITLE_SUBTYPES.has(block.subtype)) headings.push(text);
        pushCaption(text, inlineHtml(raw, block.formatting).trim());
        break;
      }

      default:
        break;
    }
  }

  return { images, videos, links, captionBlocks, captionHtmlBlocks, headings, trackTitles };
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

  const { images, videos, links, captionBlocks, captionHtmlBlocks, headings, trackTitles } =
    parseContent(content);
  const caption = captionBlocks.join("\n\n").trim();
  const captionHtml = captionHtmlBlocks.join("\n\n").trim();

  return {
    id,
    source: "tumblr-api",
    permalink: typeof post?.post_url === "string" ? post.post_url : null,
    publishedAt: publishedAt(post),
    title: headings[0] || deriveTitle(caption) || trackTitles[0] || "",
    caption,
    // Carried only when it says something the plain caption cannot, so a post
    // with no inline formatting keeps a record free of a duplicate caption.
    ...(captionHtml === escapeHtml(caption) ? {} : { captionHtml }),
    images,
    videos,
    links,
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
