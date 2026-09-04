const OWNER = process.env.RUMBLR_REPO_OWNER || "russelldear";
const REPO = process.env.RUMBLR_REPO_NAME || "rumblr";
const TOKEN = process.env.RUMBLR_DISPATCH_TOKEN;
const EVENT_TYPE = "browser_feed_refresh";
const DISPATCH_URL = `https://api.github.com/repos/${OWNER}/${REPO}/dispatches`;

function readBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  if (typeof req.body === "string" && req.body.length > 0) {
    try {
      return JSON.parse(req.body);
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

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("allow", "POST");
    return send(res, 405, { error: "Method not allowed" });
  }
  if (!TOKEN) {
    return send(res, 500, { error: "Dispatch token is not configured" });
  }

  const body = readBody(req);
  if (!body || !body.feed || typeof body.feed.feed_url !== "string") {
    return send(res, 400, { error: "Invalid request body" });
  }

  const dispatchRes = await fetch(DISPATCH_URL, {
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
        feed: body.feed,
      },
    }),
  });

  if (!dispatchRes.ok) {
    return send(res, 502, { error: `GitHub dispatch failed (${dispatchRes.status})` });
  }

  return send(res, 202, { ok: true });
}
