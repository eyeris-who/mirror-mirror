import Parser from "rss-parser";
import { extract } from "@extractus/article-extractor";

const parser = new Parser({ timeout: 8000 });

// Publisher RSS by category — free, no key. Clean links to real articles
// (Google News RSS links are obfuscated and hard to resolve).
const FEEDS = {
  top: ["https://feeds.bbci.co.uk/news/rss.xml"],
  world: ["https://feeds.bbci.co.uk/news/world/rss.xml"],
  technology: [
    "https://www.theverge.com/rss/index.xml",
    "https://feeds.arstechnica.com/arstechnica/technology-lab",
    "https://feeds.bbci.co.uk/news/technology/rss.xml",
  ],
  science: ["https://feeds.bbci.co.uk/news/science_and_environment/rss.xml"],
  business: ["https://feeds.bbci.co.uk/news/business/rss.xml"],
  health: ["https://feeds.bbci.co.uk/news/health/rss.xml"],
  sports: ["https://www.espn.com/espn/rss/news"],
  entertainment: [
    "https://feeds.bbci.co.uk/news/entertainment_and_arts/rss.xml",
  ],
};

export const CATEGORIES = Object.keys(FEEDS);

const norm = (c) => (c && FEEDS[c.toLowerCase()] ? c.toLowerCase() : "top");

let cache = new Map(); // category -> { at, items }
const TTL = 15 * 60 * 1000;

function domainOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

export async function headlines(category = "top", n = 3) {
  const key = norm(category);
  const cached = cache.get(key);
  if (cached && Date.now() - cached.at < TTL) return cached.items.slice(0, n);

  const results = await Promise.allSettled(
    FEEDS[key].map((u) => parser.parseURL(u)),
  );
  let raw = [];
  for (const r of results) {
    if (r.status === "fulfilled") raw.push(...(r.value.items ?? []));
  }
  raw.sort(
    (a, b) =>
      new Date(b.isoDate || b.pubDate || 0) -
      new Date(a.isoDate || a.pubDate || 0),
  );

  const seen = new Set();
  const items = [];
  for (const it of raw) {
    const t = (it.title || "").trim();
    const dedupe = t.toLowerCase();
    if (!t || seen.has(dedupe)) continue;
    seen.add(dedupe);
    items.push({
      n: items.length + 1,
      title: t,
      source: it.creator || domainOf(it.link),
      link: it.link,
      snippet: (it.contentSnippet || "").replace(/\s+/g, " ").trim().slice(0, 400),
    });
    if (items.length >= 10) break;
  }

  cache.set(key, { at: Date.now(), items });
  return items.slice(0, n);
}

const CAPTION = /getty images|nurphoto|via getty|shutterstock|reuters\/|\bAP Photo\b|photo by|photograph|illustration|screenshot|image caption|image source|\|\s*\w+\s+images/i;

/** First ~130 words of an article, for reading aloud. Null if extraction fails. */
export async function readArticle(link, maxWords = 130) {
  try {
    const art = await extract(link);
    const text = (art?.content || "")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (!text) {
      const d = (art?.description || "").trim();
      return d.length > 40 ? d : null;
    }
    // Drop leading photo-caption noise + de-dupe repeated sentences.
    const seen = new Set();
    const sentences = text
      .split(/(?<=[.!?])\s+/)
      .filter((s, i) => {
        if (i < 4 && CAPTION.test(s)) return false;
        const k = s.toLowerCase().trim();
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      });
    const words = sentences
      .join(" ")
      .replace(/\bby [A-Z][a-z]+ [A-Z][a-z']+\b/g, "") // stray bylines
      .replace(/\s{2,}/g, " ")
      .trim()
      .split(" ");
    return (
      words.slice(0, maxWords).join(" ") +
      (words.length > maxWords ? "… That's the gist." : "")
    );
  } catch {
    return null;
  }
}
