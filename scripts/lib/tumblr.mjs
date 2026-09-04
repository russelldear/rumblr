/**
 * Minimal Tumblr API v2 client.
 *
 * Reading a public blog's posts needs only API-key auth: the OAuth consumer
 * key from https://www.tumblr.com/oauth/apps, passed as the `api_key` query
 * parameter. No OAuth signing, no user token.
 *
 * This talks to api.tumblr.com, which is a separate host from the www/blog
 * frontend that serves HTML and RSS. That frontend applies bot protection;
 * the API is built for programmatic clients and is keyed instead.
 *
 * Docs: https://github.com/tumblr/docs/blob/master/api.md
 */

const API_ROOT = "https://api.tumblr.com/v2";

// Tumblr caps `limit` at 20 for /posts.
export const MAX_LIMIT = 20;

const USER_AGENT = "RumblrBot/1.0 (+https://github.com/russelldear/rumblr)";

/**
 * Fetch one page of a blog's posts in Neue Post Format.
 *
 * Returns { posts, totalPosts, blogTitle }. Throws on transport failure or a
 * non-OK API envelope, so callers can record the error verbatim.
 */
export async function fetchPosts({
  blog,
  apiKey,
  limit = MAX_LIMIT,
  offset = 0,
  before = null,
  timeoutMs = 20000,
  retries = 2,
}) {
  if (!blog) throw new Error("fetchPosts: blog identifier is required");
  if (!apiKey) throw new Error("fetchPosts: apiKey is required");

  const url = new URL(`${API_ROOT}/blog/${encodeURIComponent(blog)}/posts`);
  url.searchParams.set("api_key", apiKey);
  url.searchParams.set("npf", "true");
  url.searchParams.set("limit", String(Math.min(limit, MAX_LIMIT)));
  if (before != null) {
    url.searchParams.set("before", String(before));
  } else if (offset) {
    url.searchParams.set("offset", String(offset));
  }

  const body = await getJson(url, { timeoutMs, retries });

  const status = body?.meta?.status;
  if (status !== 200) {
    const msg = body?.meta?.msg || "unknown error";
    throw new Error(`Tumblr API returned ${status ?? "no status"}: ${msg}`);
  }

  const response = body.response || {};
  return {
    posts: Array.isArray(response.posts) ? response.posts : [],
    totalPosts: Number.isFinite(response.total_posts) ? response.total_posts : null,
    blogTitle: response.blog?.title || null,
  };
}

async function getJson(url, { timeoutMs, retries }) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        headers: { "user-agent": USER_AGENT, accept: "application/json" },
        signal: controller.signal,
      });
      const text = await res.text();

      // 4xx other than 429 are permanent (bad key, blog gone): fail fast.
      if (!res.ok && res.status !== 429 && res.status < 500) {
        throw Object.assign(new Error(`HTTP ${res.status}: ${summarise(text)}`), {
          permanent: true,
        });
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${summarise(text)}`);

      try {
        return JSON.parse(text);
      } catch {
        throw new Error(`Non-JSON response: ${summarise(text)}`);
      }
    } catch (err) {
      lastErr = err.name === "AbortError" ? new Error(`Timed out after ${timeoutMs}ms`) : err;
      if (err.permanent || attempt === retries) break;
      await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr;
}

/** Keep error messages short enough to sit in a JSON status file. */
function summarise(text) {
  return String(text || "").replace(/\s+/g, " ").trim().slice(0, 200);
}

/** Redact the api_key so it can never reach a log or a committed status file. */
export function redact(message, apiKey) {
  if (!apiKey) return message;
  return String(message).split(apiKey).join("<api_key>");
}
