#!/usr/bin/env node
/**
 * Checks the built _site before it ships.
 *
 * The unit tests run against source and cannot see the rendered output, but
 * every image problem this project has had was invisible until a subscriber
 * hit it: a wrong protocol, a wrong format, a canonical pointing at another
 * site. These are the assertions that would have caught them.
 */
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

const SITE = process.argv[2] || "_site";
const base = (process.env.SITE_URL || "").replace(/\/+$/, "");
const problems = [];

async function html(dir) {
  const out = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...(await html(p)));
    else if (e.name.endsWith(".html")) out.push(p);
  }
  return out;
}

const attr = (s, re) => (s.match(re) || [])[1] || null;

for (const file of await html(SITE)) {
  const doc = await readFile(file, "utf8");
  const rel = "/" + path.relative(SITE, file).replace(/index\.html$/, "");
  const canonical = attr(doc, /<link rel="canonical" href="([^"]+)"/);
  const image = attr(doc, /<meta property="og:image" content="([^"]+)"/);

  if (!canonical) problems.push(`${rel}: no canonical`);
  else if (base && canonical !== base + rel) {
    problems.push(`${rel}: canonical is ${canonical}, expected ${base + rel}`);
  }

  if (!image) problems.push(`${rel}: no og:image`);
  else if (!/^https:\/\//.test(image)) {
    // Slack cannot resolve a relative path, and will not load an http image
    // into its https client.
    problems.push(`${rel}: og:image is not an absolute https URL (${image})`);
  }
}

const feed = await readFile(path.join(SITE, "feed.xml"), "utf8");
if (feed.includes(".webp")) problems.push("feed.xml: references WebP");
if (/(src|url)="http:\/\//.test(feed)) problems.push("feed.xml: contains an http:// URL");
if (!feed.includes("<item>")) problems.push("feed.xml: has no items");

if (problems.length) {
  console.error("Built site failed verification:");
  for (const p of problems) console.error(`  ${p}`);
  process.exit(1);
}
console.log("Built site verified: canonicals, og:image, and feed all clean.");
