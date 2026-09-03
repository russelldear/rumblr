# Rumblr

A minimal, scrolling mirror of an RSS feed. A scheduled job pulls new posts from
the feed, downloads and resizes their images into the repo, and a static site
built with [Eleventy](https://www.11ty.dev/) serves them from GitHub Pages.

No server, no database, no paid services — the git repo *is* the database.

## How it works

```
RSS feed ──▶ scripts/scrape.mjs ──▶ data/posts/<id>.json  +  media/<id>/<hash>.webp
                                              │
                                              ▼
                                   Eleventy build ──▶ _site/ ──▶ GitHub Pages
```

- **`scripts/scrape.mjs`** — fetches the feed, and for each post it hasn't seen
  before: parses the description HTML, picks the largest image from each
  `srcset`, downloads it, resizes to max 1080px wide, converts to WebP (animated
  GIFs are kept as-is), and writes a JSON record. Image URLs in the stored data
  are always local paths — the original remote URLs are never persisted.
- **`data/posts/`** and **`media/`** are committed to the repo. This is the
  persistence layer.
- **`eleventy.config.js` + `src/`** — builds the site. `src/_data/posts.js` reads
  every JSON file, newest first. `src/index.njk` is paginated 10 posts per page
  (`/`, `/page/2/`, `/page/3/`, …); a small script in the layout fetches the next
  page as you near the bottom and splices its posts in, so it reads as one
  infinite scroll. No-JS visitors get a plain "Older posts" link instead.
  `src/asc.njk` renders the full list oldest-first at `/asc/` on a single page
  (direct URL only, not linked, not paginated), and `src/post.njk` builds
  individual post pages at `/post/<id>/` with a link back to the original Tumblr
  post. All share the `src/_includes/feed.njk` macro.
- **`.github/workflows/publish.yml`** — runs every 30 minutes: scrape → commit
  any new content → build → deploy to Pages. Also runs on pushes that touch the
  site source.
- **`.github/workflows/keepalive.yml`** — a monthly commit so GitHub doesn't
  disable the schedule if the feed goes quiet for 60+ days.

## Local development

```bash
npm install
npm run scrape     # pull the feed into data/ and media/
npm run serve      # Eleventy dev server at http://localhost:8080
```

`npm run dev` does both.

## Deploying

1. Create a **public** GitHub repo (public = unlimited Actions minutes) and push.
2. Repo **Settings → Pages → Build and deployment → Source: GitHub Actions**.
3. The `publish` workflow runs on the half-hour. Trigger it manually the first
   time from the **Actions** tab (`Run workflow`).

If this is a project site (`<user>.github.io/<repo>/`), the workflow passes the
correct path prefix to Eleventy automatically. For a user site or custom domain
it just works at the root.

## Configuration

Environment variables (all optional):

| var | default | purpose |
| --- | --- | --- |
| `FEED_URL` | `https://feeds.feedburner.com/salaamji-updates` | source feed |
| `SITE_TITLE` | `salaamji` | header title |
| `SITE_DESCRIPTION` | `A mirror.` | header subtitle |
| `PATH_PREFIX` | `/` | Eleventy path prefix (set by CI for project pages) |

## Notes & limits

- GitHub Pages: ~1 GB soft site-size limit, 100 GB/month bandwidth. At ~200–500 KB
  per image that's thousands of posts. If it ever grows past that, move `media/`
  to object storage (Cloudflare R2 / S3) and change the `/media/...` base path —
  the scraper already stores paths, not hosts, so nothing else changes.
- The feed only exposes its most recent items, so posts are captured going
  forward from first run. There is no historical backfill (the Tumblr API v2
  could provide one later if wanted).
- A later iteration may add authenticated direct posting. The post schema carries
  a `source` field (`"rss"`) from day one so feed and authored posts stay
  identical in shape.
