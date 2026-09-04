import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";

const OWNER = process.env.RUMBLR_REPO_OWNER || "russelldear";
const REPO = process.env.RUMBLR_REPO_NAME || "rumblr";
const TOKEN = process.env.RUMBLR_DISPATCH_TOKEN;
const SIGNING_SECRET = process.env.RUMBLR_REFRESH_SIGNING_SECRET;
const ALLOWED_ORIGIN = process.env.RUMBLR_ALLOWED_ORIGIN;
const EXPECTED_FEED_URL = process.env.RUMBLR_FEED_URL || "https://salaamji.tumblr.com/rss";
const EVENT_TYPE = "browser_feed_refresh";
const DISPATCH_URL = `https://api.github.com/repos/${OWNER}/${REPO}/dispatches`;
const NONCE_COOKIE = "rumblr_refresh_nonce";

async function readBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  if (typeof req.body === "string" && req.body.length > 0) {
    try {
      return JSON.parse(req.body);
    } catch {
      return null;
    }
  }
  if (typeof req.on === "function") {
    const chunks = [];
    await new Promise((resolve, reject) => {
      req.on("data", (chunk) => chunks.push(chunk));
      req.on("end", resolve);
      req.on("error", reject);
    });
    const raw = Buffer.concat(chunks).toString("utf8");
    if (!raw) return {};
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }
  return {};
}

function send(res, status, body) {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(body));
}

function parseCookies(header = "") {
  return Object.fromEntries(
    header
      .split(";")
      .map((v) => v.trim())
      .filter(Boolean)
      .map((entry) => {
        const idx = entry.indexOf("=");
        if (idx === -1) return [entry, ""];
        return [entry.slice(0, idx), decodeURIComponent(entry.slice(idx + 1))];
      }),
  );
}

function signNonce(nonce) {
  return createHmac("sha256", SIGNING_SECRET).update(nonce).digest("hex");
}

function verifySignature(nonce, signature) {
  const expected = Buffer.from(signNonce(nonce), "utf8");
  const received = Buffer.from(String(signature || ""), "utf8");
  if (expected.length !== received.length) return false;
  return timingSafeEqual(expected, received);
}

function checkBaseConfig(res) {
  if (!TOKEN) {
    send(res, 500, { error: "Dispatch token is not configured" });
    return false;
  }
  if (!SIGNING_SECRET) {
    send(res, 500, { error: "Refresh signing secret is not configured" });
    return false;
  }
  if (!ALLOWED_ORIGIN) {
    send(res, 500, { error: "Allowed origin is not configured" });
    return false;
  }
  return true;
}

export default async function handler(req, res) {
  if (!checkBaseConfig(res)) return;
  if (req.headers.origin && req.headers.origin !== ALLOWED_ORIGIN) {
    return send(res, 403, { error: "Origin not allowed" });
  }
  if (req.headers["x-requested-with"] !== "rumblr-refresh") {
    return send(res, 403, { error: "Request not allowed" });
  }

  if (req.method === "GET") {
    const nonce = randomUUID();
    const signature = signNonce(nonce);
    res.setHeader(
      "set-cookie",
      `${NONCE_COOKIE}=${encodeURIComponent(`${nonce}.${signature}`)}; Path=/; Max-Age=120; HttpOnly; SameSite=Strict; Secure`,
    );
    return send(res, 200, { nonce });
  }

  if (req.method !== "POST") {
    res.setHeader("allow", "GET, POST");
    return send(res, 405, { error: "Method not allowed" });
  }

  const body = await readBody(req);
  if (
    !body
    || !body.feed
    || typeof body.feed.feed_url !== "string"
    || !body.auth
    || typeof body.auth.nonce !== "string"
  ) {
    return send(res, 400, { error: "Invalid request body" });
  }
  if (body.feed.feed_url !== EXPECTED_FEED_URL) {
    return send(res, 400, { error: "Unexpected feed URL" });
  }

  const cookies = parseCookies(req.headers.cookie);
  const signedNonce = cookies[NONCE_COOKIE] || "";
  const dot = signedNonce.indexOf(".");
  const cookieNonce = dot === -1 ? "" : signedNonce.slice(0, dot);
  const cookieSig = dot === -1 ? "" : signedNonce.slice(dot + 1);
  if (cookieNonce !== body.auth.nonce || !verifySignature(cookieNonce, cookieSig)) {
    return send(res, 403, { error: "Invalid refresh token" });
  }

  let dispatchRes;
  try {
    dispatchRes = await fetch(DISPATCH_URL, {
      method: "POST",
      headers: {
        accept: "application/vnd.github+json",
        authorization: "Bearer " + TOKEN,
        "content-type": "application/json",
        "x-github-api-version": "2022-11-28",
      },
      body: JSON.stringify({
        event_type: EVENT_TYPE,
        client_payload: {
          source: "browser",
          feed: {
            feed_url: body.feed.feed_url,
            requested_at: new Date().toISOString(),
          },
        },
      }),
    });
  } catch (err) {
    console.error("GitHub dispatch failed:", err);
    return send(res, 502, { error: "GitHub dispatch failed" });
  }

  if (!dispatchRes.ok) {
    return send(res, 502, { error: "GitHub dispatch failed" });
  }

  res.setHeader("set-cookie", `${NONCE_COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict; Secure`);
  return send(res, 202, { ok: true });
}
