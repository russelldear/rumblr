import * as cheerio from "cheerio";

/**
 * Derive a stable post id from the feed guid/link.
 * Tumblr guids look like https://salaamji.tumblr.com/post/825866333548937216
 */
export function postIdFromGuid(guid) {
  if (!guid) return null;
  const m = String(guid).match(/\/post\/(\d+)/);
  if (m) return m[1];
  // Fallback: last non-empty path segment, sanitised.
  try {
    const url = new URL(guid);
    const seg = url.pathname.split("/").filter(Boolean).pop();
    if (seg) return seg.replace(/[^a-zA-Z0-9_-]/g, "-");
  } catch {
    /* not a url */
  }
  return String(guid).replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 80);
}

/**
 * Pick the highest-resolution URL from an <img>'s srcset, falling back to src.
 * Returns { url, width } where width may be null when unknown.
 */
export function bestFromImg($img) {
  const srcset = $img.attr("srcset");
  let best = null;
  if (srcset) {
    for (const entry of srcset.split(",")) {
      const parts = entry.trim().split(/\s+/);
      if (parts.length < 2) continue;
      const url = parts[0];
      const desc = parts[1];
      const wm = desc.match(/^(\d+)w$/);
      if (wm) {
        const width = parseInt(wm[1], 10);
        if (!best || width > best.width) best = { url, width };
      }
    }
  }
  if (best) return best;
  const src = $img.attr("src");
  if (src) {
    const w = parseInt($img.attr("data-orig-width") || "", 10);
    return { url: src, width: Number.isFinite(w) ? w : null };
  }
  return null;
}

/**
 * Parse a feed item's description HTML into structured media + caption.
 * Returns { images: [{sourceUrl, origWidth, origHeight, alt}], videos: [{sourceUrl, poster}], caption }
 */
export function parseDescription(html) {
  const $ = cheerio.load(html || "", null, false);

  const images = [];
  $("img").each((_, el) => {
    const $img = $(el);
    const best = bestFromImg($img);
    if (!best) return;
    images.push({
      sourceUrl: best.url,
      origWidth: intOrNull($img.attr("data-orig-width")) ?? best.width,
      origHeight: intOrNull($img.attr("data-orig-height")),
      alt: ($img.attr("alt") || "").trim(),
    });
  });

  const videos = [];
  $("video").each((_, el) => {
    const $v = $(el);
    let src = $v.attr("src");
    if (!src) src = $v.find("source").first().attr("src");
    if (!src) return;
    videos.push({ sourceUrl: src, poster: $v.attr("poster") || null });
  });

  // Caption: text of the description with media stripped out.
  $("figure, img, video, script, style").remove();
  const blocks = [];
  $("p, h1, h2, h3, blockquote, li").each((_, el) => {
    const t = $(el).text().replace(/\s+/g, " ").trim();
    if (t) blocks.push(t);
  });
  let caption = blocks.join("\n\n").trim();
  if (!caption) {
    caption = $.root().text().replace(/\s+/g, " ").trim();
  }

  return { images, videos, caption };
}

function intOrNull(v) {
  const n = parseInt(v ?? "", 10);
  return Number.isFinite(n) ? n : null;
}

/**
 * Turn a raw rss-parser item into a post record (media still unresolved).
 */
export function itemToPost(item) {
  const link = item.link || item.guid;
  const id = postIdFromGuid(item.guid || item.link);
  const { images, videos, caption } = parseDescription(item.content || item["content:encoded"] || "");
  const publishedAt = item.isoDate
    ? new Date(item.isoDate).toISOString()
    : item.pubDate
      ? new Date(item.pubDate).toISOString()
      : new Date().toISOString();

  return {
    id,
    source: "rss",
    permalink: link,
    publishedAt,
    title: (item.title || "").trim(),
    caption,
    images, // unresolved: still have sourceUrl, no local src yet
    videos,
  };
}
