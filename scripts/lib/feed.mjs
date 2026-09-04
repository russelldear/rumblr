/**
 * Selection and rendering for the site's own RSS feed.
 *
 * The feed deliberately starts partway through the archive. Everything older
 * than the cutoff was already delivered to subscribers by Tumblr's own feed
 * before this mirror took over, so republishing it would show up downstream as
 * a wave of duplicates.
 */

/**
 * Oldest post to include, by id. This is "Stupid sexy Flanders.", the first
 * post Tumblr's own feed never delivered.
 *
 * The boundary sits here rather than one post earlier because the post before
 * it, "Stunning jellyfish at the aquarium" (826639118293516288), was the last
 * one Tumblr's feed did deliver. Subscribers already hold it, so starting on
 * it would re-send a post they have. Starting after it means the two feeds
 * meet exactly, with no gap and no overlap.
 */
export const DEFAULT_SINCE_POST_ID = "826644056326176768";

/** Feed readers do not want the whole archive; recent items are enough. */
export const DEFAULT_MAX_ITEMS = 50;

/**
 * Accept a bare post id or any Tumblr permalink shape, since both are in
 * circulation: https://salaamji.tumblr.com/post/<id> and
 * https://www.tumblr.com/salaamji/<id>/<slug>.
 */
export function normalisePostId(value) {
  if (value == null) return null;
  const s = String(value).trim();
  if (!s) return null;
  if (/^\d+$/.test(s)) return s;
  const m = s.match(/\d{10,}/);
  return m ? m[0] : null;
}

/**
 * Posts belonging in the feed: at or newer than the cutoff, newest first,
 * capped. Ids are compared as BigInt because they are 18 digits and would lose
 * precision as Numbers.
 */
export function selectFeedPosts(posts, { sincePostId, maxItems } = {}) {
  const since = normalisePostId(sincePostId) ?? DEFAULT_SINCE_POST_ID;
  const cutoff = BigInt(since);
  const limit = Number.isFinite(maxItems) && maxItems > 0 ? maxItems : DEFAULT_MAX_ITEMS;

  return (posts || [])
    .filter((p) => p && /^\d+$/.test(String(p.id)) && BigInt(p.id) >= cutoff)
    .sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt))
    .slice(0, limit);
}

/** Join a root-relative path onto the site's base URL. */
export function absolute(pathname, baseUrl) {
  const p = String(pathname || "");
  if (/^https?:\/\//i.test(p)) return p;
  const base = String(baseUrl || "").replace(/\/+$/, "");
  return base + (p.startsWith("/") ? p : `/${p}`);
}

const MIME_BY_EXT = {
  webp: "image/webp",
  gif: "image/gif",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  mp4: "video/mp4",
  webm: "video/webm",
};

export function mimeFor(pathname) {
  const ext = String(pathname || "").split(".").pop().toLowerCase();
  return MIME_BY_EXT[ext] || "application/octet-stream";
}

/**
 * Structured media for a feed item, as <media:content> and <enclosure>.
 *
 * Inline <img> in the description is not enough on its own: plenty of readers
 * strip or ignore markup in descriptions and look for Media RSS instead, so a
 * post can arrive with its picture missing. Declaring the media separately
 * gives those readers something to render.
 *
 * `mediaRoot` is the on-disk directory behind /media, used only to stat file
 * sizes, since <enclosure> requires a length. A file that cannot be measured
 * is still listed, without a length.
 */
export function feedMedia(post, baseUrl, mediaRoot, statSize) {
  const out = [];
  const add = (src, width, height) => {
    if (!src) return;
    let length = null;
    if (mediaRoot && statSize && src.startsWith("/media/")) {
      length = statSize(mediaRoot + src.slice("/media".length));
    }
    out.push({
      url: absolute(src, baseUrl),
      type: mimeFor(src),
      width: width ?? null,
      height: height ?? null,
      length,
    });
  };

  for (const img of post.images || []) add(img.src, img.width, img.height);
  for (const vid of post.videos || []) add(vid.src, null, null);
  return out;
}

export function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Item body: the images, then the caption. Media is referenced by absolute URL
 * because a feed item is read far from the page it came from.
 */
export function feedDescription(post, baseUrl) {
  const parts = [];

  for (const img of post.images || []) {
    const dims =
      (img.width ? ` width="${img.width}"` : "") + (img.height ? ` height="${img.height}"` : "");
    parts.push(
      `<p><img src="${escapeHtml(absolute(img.src, baseUrl))}" alt="${escapeHtml(img.alt || "")}"${dims}></p>`,
    );
  }

  for (const vid of post.videos || []) {
    const src = escapeHtml(absolute(vid.src, baseUrl));
    parts.push(`<p><video src="${src}" controls></video></p>`);
    parts.push(`<p><a href="${src}">View video</a></p>`);
  }

  for (const para of String(post.caption || "").split(/\n{2,}/)) {
    const t = para.trim();
    if (t) parts.push(`<p>${escapeHtml(t)}</p>`);
  }

  return parts.join("\n");
}

/** CDATA cannot contain the terminator; split it so the payload survives. */
export function cdata(html) {
  return `<![CDATA[${String(html ?? "").replace(/\]\]>/g, "]]]]><![CDATA[>")}]]>`;
}
