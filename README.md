# Rumblr

A minimal, scrolling mirror of a Tumblr blog. A scheduled job pulls new posts
from the Tumblr API, downloads and resizes their images into the repo, and a
static site built with [Eleventy](https://www.11ty.dev/) serves them from
GitHub Pages.

No server, no database, no paid services — the git repo *is* the database.

## How it works

```
Tumblr API v2 ──▶ scripts/scrape.mjs ──▶ data/posts/<id>.json + media/<id>/<hash>.webp
                                                   │
                                                   ▼
                                        Eleventy build ──▶ _site/ ──▶ GitHub Pages
```

### Why the API and not RSS

`salaamji.tumblr.com/rss` is served by Tumblr's web frontend, which blocks
automated requests. Spoofing a browser user-agent did not get past it, and
proxying through FeedBurner only moved the problem. `api.tumblr.com` is a
separate host, gated by a key rather than by bot detection, and is the
supported way to read a blog programmatically.

Reading a public blog needs only **API-key auth**: register an app at
[tumblr.com/oauth/apps](https://www.tumblr.com/oauth/apps) and pass its OAuth
consumer key as the `api_key` query parameter. No OAuth signing, no user
token, no expiry. Tumblr documents a limit of 300 API calls per minute per IP,
against which hourly polling is nothing.

The API also returns structured
[NPF](https://github.com/tumblr/docs/blob/master/npf-spec.md) content blocks
rather than description HTML, so there is no markup to scrape, every stored
image size comes with real dimensions, and `total_posts` gives a way to tell
"the blog is quiet" apart from "retrieval is broken".

- **`scripts/scrape.mjs`** — pages back through the blog until it reaches a post
  it already has, and for each new one: picks the largest size from each NPF
  image block, downloads it, resizes to max 1000px wide, converts to JPEG
  (animated images keep their frames as GIF), and writes a JSON record. Image URLs in the
  stored data are always local paths; the original remote URLs are never
  persisted. Videos hosted by Tumblr are mirrored too; external embeds
  (YouTube, Vimeo) have no downloadable file, so their link is kept in the
  caption instead of rendering a broken player.
- **`scripts/lib/tumblr.mjs`** — the API client. Retries transient errors with
  backoff, fails fast on permanent ones (bad key, blog gone), and redacts the
  key from any error message before it can reach a log or a committed file.
- **`data/posts/`** and **`media/`** are committed to the repo. This is the
  persistence layer.
- **`eleventy.config.js` + `src/`** — builds the site. `src/_data/posts.js` reads
  every JSON file, newest first. `src/index.njk` is paginated 10 posts per page
  (`/`, `/page/2/`, `/page/3/`, …); a small script in the layout fetches the next
  page as you near the bottom and splices its posts in, so it reads as one
  infinite scroll. No-JS visitors get a plain "Older posts" link instead.
  `src/rss.njk` publishes the site's own RSS feed at `/feed.xml`, linked for
  autodiscovery from every page.
  `src/asc.njk` renders the full list oldest-first at `/asc/` on a single page
  (direct URL only, not linked, not paginated), and `src/post.njk` builds
  individual post pages at `/post/<id>/` with a link back to the original Tumblr
  post. All share the `src/_includes/feed.njk` macro.
- **`.github/workflows/publish.yml`** — runs every 5 minutes: sync → commit any
  new content → build → deploy to Pages. Also runs on pushes that touch the
  site source.
- **`.github/workflows/keepalive.yml`** — a monthly commit so GitHub doesn't
  disable the schedule if the feed goes quiet for 60+ days.

## Setup

You need a Tumblr API key. Register an app at
[tumblr.com/oauth/apps](https://www.tumblr.com/oauth/apps) (any name and URL
will do; the blog does not have to be yours, only public). Copy the **OAuth
consumer key**.

Add it to the repo as a secret named `TUMBLR_API_KEY` under
**Settings → Secrets and variables → Actions → New repository secret**. The
key only reads public posts, so it is low-risk, but it is still a credential:
keep it out of the repo. The scraper redacts it from error output.

## Local development

```bash
npm install
export TUMBLR_API_KEY=your-consumer-key
npm run scrape     # pull new posts into data/ and media/
npm run serve      # Eleventy dev server at http://localhost:8080
npm test           # feed selection and rendering
```

`npm run dev` does the scrape and serve.

## Deploying

1. Create a **public** GitHub repo (public = unlimited Actions minutes) and push.
2. Repo **Settings → Pages → Build and deployment → Source: GitHub Actions**.
3. Add the `TUMBLR_API_KEY` secret (see [Setup](#setup)).
4. The `publish` workflow runs hourly. Trigger it manually the first
   time from the **Actions** tab (`Run workflow`).

If this is a project site (`<user>.github.io/<repo>/`), the workflow passes the
correct path prefix to Eleventy automatically. For a user site or custom domain
it just works at the root.

## Configuration

Environment variables (all optional):

| var | default | purpose |
| --- | --- | --- |
| `TUMBLR_API_KEY` | (none, **required**) | OAuth consumer key from tumblr.com/oauth/apps |
| `TUMBLR_BLOG` | `salaamji.tumblr.com` | blog identifier to mirror |
| `MAX_PAGES` | `5` | pages of 20 posts to walk back per run, at most |
| `ALERT_AFTER_FAILURES` | `72` | consecutive failures before the workflow goes red (~6h at a 5-minute interval) |
| `ALERT_REPEAT_EVERY` | `288` | failures between repeat alerts once past the threshold (~24h) |
| `SITE_URL` | `http://localhost:8080` | absolute base URL for feed links (CI passes the Pages `base_url`) |
| `FEED_SINCE_POST_ID` | `826644056326176768` | oldest post to publish in the feed; accepts an id or a Tumblr URL |
| `FEED_MAX_ITEMS` | `50` | most items to publish in the feed |
| `SITE_TITLE` | `salaamji` | header title |
| `SITE_DESCRIPTION` | `Bamji in Morocco.` | header subtitle |
| `PATH_PREFIX` | `/` | Eleventy path prefix (set by CI for project pages) |

## Notes & limits

- GitHub Pages: ~1 GB soft site-size limit, 100 GB/month bandwidth. At ~200–500 KB
  per image that's thousands of posts. If it ever grows past that, move `media/`
  to object storage (Cloudflare R2 / S3) and change the `/media/...` base path —
  the scraper already stores paths, not hosts, so nothing else changes.
- The mirror is **forward-only**: it captures posts from first run onward. The
  API can paginate the whole blog (`offset`, or `before` with a Unix
  timestamp), so a historical backfill is now possible; it is deliberately not
  wired up, because pulling a full image history would grow the repo against
  the ~1 GB Pages limit above.
- A later iteration may add authenticated direct posting. The post schema
  carries a `source` field so API-sourced and authored posts stay identical in
  shape. Records written before the API switch carry `source: "rss"`.

## Our own RSS feed

The site publishes `/feed.xml`, so subscribers can follow the mirror instead
of Tumblr. Every page carries an autodiscovery `<link>`, so pointing a reader
at the site is enough to find it.

**The feed does not start at the beginning of the archive.** It begins at
"Stupid sexy Flanders." (`826644056326176768`), the first post Tumblr's own
feed never delivered. Everything older was already sent to subscribers once,
and republishing it would arrive downstream as a wave of duplicates.

The boundary sits there rather than one post earlier because the post before
it, "Stunning jellyfish at the aquarium" (`826639118293516288`), was the last
one Tumblr's feed did deliver. The two feeds therefore meet exactly, with no
gap and no overlap. Change the boundary with `FEED_SINCE_POST_ID`, which takes
a bare post id or any Tumblr URL; the post it names is included as the oldest
item.

Two details aimed at not duplicating anything downstream:

- `<guid>` is the Tumblr permalink, which is what the feed this replaces used
  as its guid. A reader that saw both feeds across the handover can therefore
  recognise an overlapping post as one it already has.
- `<link>` points at this site's own post page rather than Tumblr, since the
  point of the feed is to stop depending on Tumblr being reachable.

Absolute URLs throughout, for the item links and the images in each item body,
built from `SITE_URL`. CI passes the `base_url` output of
`actions/configure-pages`, so the custom domain and path prefix stay correct
without being hardcoded. Setting a repository *variable* named `SITE_URL`
overrides that, which is the lever for the problem below.

Each item also declares its media as `<media:content>`, `<media:thumbnail>`
and an `<enclosure>`, with real byte sizes read off disk at build time. Inline
`<img>` in the description is not enough on its own: plenty of readers strip
or ignore markup in descriptions and look for Media RSS instead, so without
this a post can arrive with its picture missing.

### Images and http

Pages currently serves this site over **http**, not https: the deploy step
reports `http://guid.nz/rumblr/`, and `base_url` follows it, so every image
URL in the feed is `http://`.

That is the likely reason images fail to appear in readers. Feed readers are
mostly web applications served over https, and a browser will not load an
`http://` image into an https page: it upgrades the request to https and, when
that fails, blocks the image. The result is a blank space, regardless of the
image format.

The fix is to get the site onto https, at which point `base_url` becomes
https on its own and the feed heals with no code change:

1. Confirm `https://guid.nz/rumblr/` loads in a browser.
2. If it does, turn on **Enforce HTTPS** in the Pages settings for the domain,
   or set a repository variable `SITE_URL=https://guid.nz/rumblr` to switch
   the feed over immediately without waiting for that.

### Images are JPEG, not WebP

Moving the feed to https was not enough on its own: readers still would not
render the images, and the remaining difference was the format. Stored images
are now JPEG at quality 85.

WebP "should" work, which is why it was the original choice: every browser has
supported it since Safari 14 in 2020. But a reader that will not show a picture
is worse than a larger file, and JPEG removes the question. It also sidesteps
a second possibility that was never ruled out, that GitHub Pages serves `.webp`
with a content type some readers reject, since `.jpg` is mapped everywhere.

The cost is about 17% more bytes, measured across the existing images when they
were converted (2380KB to 2776KB). Against the ~1 GB Pages limit that is
thousands of posts away from mattering.

Two format notes:

- **Animation cannot be JPEG.** Animated images keep their frames and are
  stored as GIF. An animated WebP is re-containered as GIF, so nothing WebP
  ever reaches the feed.
- **JPEG has no transparency.** Images are flattened onto white, because
  otherwise a transparent PNG renders with a black background.

## Polling frequency

The cron is `*/5 * * * *`, which is as often as GitHub allows: scheduled
workflows have a floor of five minutes.

**Do not expect five minutes.** That is what the cron asks for, not what
GitHub delivers. Measured against this repository's own run history while the
cron was set to hourly (`0 * * * *`), scheduled runs actually arrived like
this:

| | minutes between scheduled runs |
| --- | --- |
| shortest | 115 |
| median | 215 |
| longest | 452 |

Not one interval came close to the 60 minutes requested. The `schedule` event
is best effort, and the documented note that it "can be delayed during periods
of high loads" understates what happens here: delivery is closer to one run
every two to seven hours, whatever the cron says.

Tightening the cron changed the request, not the delivery. If the mirror has
to be prompt, the schedule is the wrong mechanism. Every other trigger fires
immediately, so the fix is an external scheduler calling `workflow_dispatch`
through the API, with the cron kept as a free best-effort backstop. That
needs a fine-grained token with Actions write, which is deliberately narrower
than `repository_dispatch`, whose Contents write permission can push code.

The Tumblr API is nowhere near being the constraint. Each poll costs a single
API call in the steady state (one page, stopping at the first post already
mirrored), against a documented ceiling of 300 calls per minute per IP.

One further note: every run rebuilds and redeploys the site, even when nothing
changed. That is deliberate rather than overlooked. The footer's "Last poll"
line is only as fresh as the last deploy, and a stale timestamp reads exactly
like a dead poller, which is the ambiguity this design exists to remove.
GitHub Pages' 10-builds-per-hour soft limit does not apply to custom Actions
workflows, so the redeploys cost nothing but runner time, which is free on
public repositories.

## Knowing when retrieval breaks

A mirror that silently stops mirroring looks exactly like a blog that has gone
quiet. Both produce green hourly runs and no new commits. That ambiguity once
went unnoticed for two days, so the sync tracks it explicitly.

`data/poll-state.json` is committed and holds the durable part:

```json
{ "consecutiveFailures": 0, "lastError": null, "failingSince": null, "totalPosts": 47 }
```

It carries no "last polled" timestamp on purpose. If it did, every hourly run
would rewrite it and commit, burying real changes in noise. A successful poll
that finds nothing new leaves the file byte-identical and commits nothing.

The workflow goes red in exactly two cases:

- **Sustained failure.** After `ALERT_AFTER_FAILURES` consecutive failures
  (72 by default, so roughly six hours at the 5-minute poll interval). A single
  blip stays silent, and once past the threshold it re-alerts only every
  `ALERT_REPEAT_EVERY` runs (~24 hours), so a long outage does not mail you
  every five minutes. The alert reports `failingSince`, because a count of runs
  only means something if you know the interval.

  Both are counts of runs, not durations. **If you change the cron, rescale
  them**, or a faster poll turns a brief blip into a red build.
- **A gap.** The blog's `total_posts` went up but the sync captured nothing.
  That means a post exists which was not seen, which no number of green runs
  would otherwise reveal. This check is only possible because the API reports
  a total; RSS never could.

The alert step runs last, so the site still rebuilds and deploys before the run
is marked failed. For a glance without opening Actions, the site footer shows
the last poll time and either `N of M posts mirrored` or `failed N times in a
row`, from the gitignored `data/feed-status.json` written at build time.
