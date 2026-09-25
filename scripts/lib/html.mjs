/**
 * HTML helpers shared by the parser and the feed renderer.
 *
 * Escaping used to live in feed.mjs, where it was the only thing building
 * markup. The parser now does too, for a text block's inline links, and a
 * parser reaching into the feed renderer for it would be the wrong way round.
 */

export function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const SAFE_SCHEMES = new Set(["http:", "https:", "mailto:"]);

/**
 * An href we are willing to put in the page, or null.
 *
 * These URLs come from Tumblr rather than a stranger, but they are still data
 * arriving over the network on their way into an attribute, and `javascript:`
 * in an href is script execution. Anything not http, https or mailto — and
 * anything that will not parse as an absolute URL — is dropped, leaving the
 * caller to render the text without a link.
 */
export function safeHref(url) {
  const raw = String(url ?? "").trim();
  if (!raw) return null;
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  return SAFE_SCHEMES.has(parsed.protocol) ? parsed.href : null;
}
