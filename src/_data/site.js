export default {
  title: process.env.SITE_TITLE || "salaamji",
  description:
    process.env.SITE_DESCRIPTION || "Bamji in Morocco.",
  source: "https://salaamji.tumblr.com/",
  // Absolute base URL, used for the feed's links and media. CI passes the
  // `base_url` output of actions/configure-pages, so it is correct for the
  // custom domain and path prefix without being hardcoded here.
  url: (process.env.SITE_URL || "http://localhost:8080").replace(/\/+$/, ""),
  feed: {
    path: "/feed.xml",
    sincePostId: process.env.FEED_SINCE_POST_ID || null,
    maxItems: parseInt(process.env.FEED_MAX_ITEMS || "", 10) || null,
  },
};
