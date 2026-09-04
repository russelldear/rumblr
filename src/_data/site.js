export default {
  title: process.env.SITE_TITLE || "salaamji",
  description:
    process.env.SITE_DESCRIPTION || "Bamji in Morocco.",
  source: "https://salaamji.tumblr.com/",
  refresh: {
    feedUrl: "https://salaamji.tumblr.com/rss",
    dispatchUrl: "https://api.github.com/repos/russelldear/rumblr/dispatches",
    eventType: "browser_feed_refresh",
  },
};
