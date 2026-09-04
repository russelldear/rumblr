import { statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  selectFeedPosts,
  feedDescription,
  feedMedia,
  cdata,
  absolute,
} from "./scripts/lib/feed.mjs";

const MEDIA_ROOT = path.resolve(fileURLToPath(new URL("./media", import.meta.url)));

/** Byte size for an <enclosure> length, or null when the file is unreadable. */
function statSize(p) {
  try {
    return statSync(p).size;
  } catch {
    return null;
  }
}

export default function (eleventyConfig) {
  // Persisted media lives at repo-root /media and is served verbatim.
  eleventyConfig.addPassthroughCopy({ media: "media" });

  eleventyConfig.addFilter("isoDate", (d) => new Date(d).toISOString());
  // RSS pubDate wants RFC 822; toUTCString() is the compatible form.
  eleventyConfig.addFilter("rfc822", (d) => new Date(d).toUTCString());
  eleventyConfig.addFilter("absolute", (p, base) => absolute(p, base));
  eleventyConfig.addFilter("feedItems", (posts, opts) => selectFeedPosts(posts, opts || {}));
  eleventyConfig.addFilter("feedBody", (post, base) => cdata(feedDescription(post, base)));
  eleventyConfig.addFilter("feedMedia", (post, base) =>
    feedMedia(post, base, MEDIA_ROOT, statSize),
  );
  eleventyConfig.addFilter("displayDate", (d) =>
    new Date(d).toLocaleDateString("en-GB", {
      day: "numeric",
      month: "short",
      year: "numeric",
    }),
  );

  return {
    dir: {
      input: "src",
      output: "_site",
      includes: "_includes",
      data: "_data",
    },
    pathPrefix: process.env.PATH_PREFIX || "/",
    htmlTemplateEngine: "njk",
    markdownTemplateEngine: "njk",
  };
}
