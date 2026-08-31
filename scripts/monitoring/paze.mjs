#!/usr/bin/env node

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(SCRIPT_DIR, "../..");
const DATA_DIR = resolve(ROOT, "tools/monitoring/data");
const SOURCE_URL = "https://www.paze.com/merchant-directory?page=0";
const PAGE_LIMIT = 25;
const HISTORY_LIMIT = 336;
const FEED_LIMIT = 100;
const EXPECTED_INITIAL_COUNT = 33;

const paths = {
  baseline: resolve(DATA_DIR, "paze-baseline.json"),
  history: resolve(DATA_DIR, "history.json"),
  state: resolve(DATA_DIR, "state.json"),
  feed: resolve(DATA_DIR, "change-feed.json"),
};

const decoder = new TextDecoder();

export function decodeHtml(value) {
  const named = {
    amp: "&",
    apos: "'",
    quot: '"',
    nbsp: " ",
    lt: "<",
    gt: ">",
  };

  return value.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, entity) => {
    const lower = entity.toLowerCase();
    if (lower[0] === "#") {
      const hex = lower[1] === "x";
      const point = Number.parseInt(lower.slice(hex ? 2 : 1), hex ? 16 : 10);
      return Number.isFinite(point) ? String.fromCodePoint(point) : match;
    }
    return named[lower] ?? match;
  });
}

export function cleanName(value) {
  return decodeHtml(value)
    .normalize("NFKC")
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u2013\u2014]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

export function merchantKey(value) {
  return cleanName(value)
    .toLocaleLowerCase("en-US")
    .replace(/&/g, " and ")
    .replace(/\bthe\b/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

export function parsePage(html, pageNumber) {
  const merchants = [];
  const labelPattern = /aria-label\s*=\s*(["'])Visit\s+([\s\S]*?)\s+website\1/gi;
  let match;
  while ((match = labelPattern.exec(html))) {
    const name = cleanName(match[2]);
    if (name) merchants.push({ name, key: merchantKey(name) });
  }

  const unique = [...new Map(merchants.map((merchant) => [merchant.key, merchant])).values()];
  const nextMatch = html.match(
    /<a\b(?=[^>]*\brel\s*=\s*(["'])next\1)(?=[^>]*\btitle\s*=\s*(["'])Load more items\2)[^>]*\bhref\s*=\s*(["'])([^"']+)\3[^>]*>/i,
  ) ?? html.match(
    /<a\b(?=[^>]*\btitle\s*=\s*(["'])Load more items\1)(?=[^>]*\brel\s*=\s*(["'])next\2)[^>]*\bhref\s*=\s*(["'])([^"']+)\3[^>]*>/i,
  );
  const nextHref = nextMatch?.[4] ?? null;

  if (!unique.length) {
    throw new Error(`Page ${pageNumber} contained no server-rendered merchant labels.`);
  }
  if (merchants.length !== unique.length) {
    throw new Error(`Page ${pageNumber} contained duplicate normalized merchant labels.`);
  }

  return { merchants: unique, nextHref };
}

function pageNumberFromHref(href) {
  if (!href) return null;
  const url = new URL(href, SOURCE_URL);
  const value = Number.parseInt(url.searchParams.get("page") ?? "", 10);
  return Number.isInteger(value) ? value : null;
}

async function fetchWithRetry(url, fetchImpl, attempts = 3) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetchImpl(url, {
        headers: {
          accept: "text/html,application/xhtml+xml",
          "user-agent": "john-ta-monitor/1.0 (+https://john-ta.com/tools/monitoring/)",
        },
        signal: AbortSignal.timeout(20_000),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
      return await response.text();
    } catch (error) {
      lastError = error;
      if (attempt < attempts) await new Promise((done) => setTimeout(done, 750 * attempt));
    }
  }
  throw lastError;
}

export async function collectDirectory(fetchImpl = fetch) {
  const merchants = [];
  const pageCounts = [];
  const seen = new Set();
  let page = 0;

  while (page < PAGE_LIMIT) {
    const url = new URL(SOURCE_URL);
    url.searchParams.set("page", String(page));
    const html = await fetchWithRetry(url, fetchImpl);
    const parsed = parsePage(html, page);

    for (const merchant of parsed.merchants) {
      if (seen.has(merchant.key)) {
        throw new Error(`Merchant “${merchant.name}” appeared on more than one page.`);
      }
      seen.add(merchant.key);
      merchants.push(merchant);
    }
    pageCounts.push(parsed.merchants.length);

    if (!parsed.nextHref) break;
    const nextPage = pageNumberFromHref(parsed.nextHref);
    if (nextPage !== page + 1) {
      throw new Error(`Page ${page} continuation pointed to page ${nextPage ?? "unknown"}.`);
    }
    page = nextPage;
  }

  if (page >= PAGE_LIMIT) throw new Error(`Pagination exceeded the ${PAGE_LIMIT}-page safety limit.`);

  return {
    merchants: merchants.sort((a, b) => a.key.localeCompare(b.key)),
    pagination: {
      complete: true,
      pagesFetched: pageCounts.length,
      pageCounts,
      finalPage: page,
    },
  };
}

function levenshtein(a, b) {
  const previous = [...Array(b.length + 1).keys()];
  for (let i = 1; i <= a.length; i += 1) {
    let diagonal = previous[0];
    previous[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const saved = previous[j];
      previous[j] = Math.min(
        previous[j] + 1,
        previous[j - 1] + 1,
        diagonal + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
      diagonal = saved;
    }
  }
  return previous[b.length];
}

function similarity(a, b) {
  if (a === b) return 1;
  const max = Math.max(a.length, b.length);
  return max ? 1 - levenshtein(a, b) / max : 1;
}

export function diffMerchants(previous = [], current = []) {
  const oldKeys = new Set(previous.map(({ key }) => key));
  const newKeys = new Set(current.map(({ key }) => key));
  let removed = previous.filter(({ key }) => !newKeys.has(key));
  let added = current.filter(({ key }) => !oldKeys.has(key));
  const renameCandidates = [];

  for (const before of removed) {
    for (const after of added) {
      const score = similarity(before.key, after.key);
      if (score >= 0.72) renameCandidates.push({ before, after, score });
    }
  }
  renameCandidates.sort((a, b) => b.score - a.score);

  const usedBefore = new Set();
  const usedAfter = new Set();
  const renamed = [];
  for (const candidate of renameCandidates) {
    if (usedBefore.has(candidate.before.key) || usedAfter.has(candidate.after.key)) continue;
    usedBefore.add(candidate.before.key);
    usedAfter.add(candidate.after.key);
    renamed.push({ from: candidate.before.name, to: candidate.after.name });
  }

  removed = removed.filter(({ key }) => !usedBefore.has(key));
  added = added.filter(({ key }) => !usedAfter.has(key));

  return {
    added: added.map(({ name }) => name),
    removed: removed.map(({ name }) => name),
    renamed,
  };
}

function hasDiff(diff) {
  return diff.added.length > 0 || diff.removed.length > 0 || diff.renamed.length > 0;
}

function sameSet(first, second) {
  return first.length === second.length && first.every((merchant, index) => merchant.key === second[index].key);
}

async function readJson(path, fallback) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return fallback;
    throw error;
  }
}

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

function eventId(timestamp, type) {
  return `${timestamp.replace(/[-:.TZ]/g, "").slice(0, 14)}-${type}`;
}

function createState({ previousState, run, baseline, feed }) {
  const previousMonitor = previousState?.monitors?.find(({ id }) => id === "paze-directory") ?? {};
  const latestSuccessAt = run.status === "success" ? run.timestamp : previousMonitor.latestSuccessAt ?? null;
  const latestChangeAt = run.changed ? run.timestamp : previousMonitor.latestChangeAt ?? null;

  return {
    schemaVersion: 1,
    generatedAt: run.timestamp,
    overallStatus: run.status === "success" ? "healthy" : "attention",
    latestEventId: feed.events[0]?.id ?? null,
    monitors: [
      {
        id: "paze-directory",
        name: "Paze merchant directory",
        description: "Tracks additions, removals, and likely merchant renames across every server-rendered directory page.",
        configured: true,
        status: run.status === "success" ? "healthy" : "error",
        sourceUrl: SOURCE_URL,
        cadence: "Hourly",
        expectedCount: EXPECTED_INITIAL_COUNT,
        currentCount: baseline.merchants?.length ?? 0,
        latestRunAt: run.timestamp,
        latestSuccessAt,
        latestChangeAt,
        durationMs: run.durationMs,
        summary: run.summary,
        error: run.error,
        pagination: run.pagination,
        diff: run.diff,
      },
      {
        id: "paze-clover-map-ranking",
        name: "Paze / Clover map ranking",
        description: "Reserved for a configurable collector that tracks map-pack position and ranking movement.",
        configured: false,
        status: "not_configured",
        sourceUrl: null,
        cadence: null,
        config: { query: null, location: null, target: null },
      },
      {
        id: "paze-bonus-discovery",
        name: "Paze bonus discovery",
        description: "Reserved for a configurable collector that detects new Paze promotions and offer terms.",
        configured: false,
        status: "not_configured",
        sourceUrl: "https://www.paze.com/offers",
        cadence: null,
        config: { sources: [], keywords: [], notifyOn: ["new", "changed"] },
      },
    ],
  };
}

export async function runMonitor({ fetchImpl = fetch, now = () => new Date() } = {}) {
  const started = performance.now();
  const timestamp = now().toISOString();
  const baseline = await readJson(paths.baseline, {
    schemaVersion: 1,
    monitorId: "paze-directory",
    sourceUrl: SOURCE_URL,
    capturedAt: null,
    merchants: [],
  });
  const history = await readJson(paths.history, { schemaVersion: 1, maxRuns: HISTORY_LIMIT, runs: [] });
  const previousState = await readJson(paths.state, null);
  const feed = await readJson(paths.feed, {
    schemaVersion: 1,
    feedId: "john-ta-monitoring-changes",
    generatedAt: timestamp,
    latestEventId: null,
    events: [],
  });

  const priorStatus = previousState?.monitors?.find(({ id }) => id === "paze-directory")?.status;
  let nextBaseline = baseline;
  let run;

  try {
    const first = await collectDirectory(fetchImpl);
    if (!baseline.merchants.length && first.merchants.length !== EXPECTED_INITIAL_COUNT) {
      throw new Error(
        `Initial crawl found ${first.merchants.length} merchants; expected the validated baseline of ${EXPECTED_INITIAL_COUNT}.`,
      );
    }

    const initialized = !baseline.merchants.length;
    const diff = initialized
      ? { added: [], removed: [], renamed: [] }
      : diffMerchants(baseline.merchants, first.merchants);
    const changed = baseline.merchants.length > 0 && hasDiff(diff);
    let confirmed = !changed;

    if (changed) {
      const second = await collectDirectory(fetchImpl);
      if (!sameSet(first.merchants, second.merchants)) {
        throw new Error("A potential directory change was not reproduced by the confirmation crawl.");
      }
      confirmed = true;
    }

    nextBaseline = {
      schemaVersion: 1,
      monitorId: "paze-directory",
      sourceUrl: SOURCE_URL,
      capturedAt: timestamp,
      merchants: first.merchants,
    };

    const summary = initialized
      ? `Validated initial baseline of ${first.merchants.length} merchants.`
      : changed
        ? `${diff.added.length} added, ${diff.removed.length} removed, ${diff.renamed.length} renamed.`
        : `No merchant changes across ${first.pagination.pagesFetched} pages.`;

    run = {
      id: timestamp,
      monitorId: "paze-directory",
      timestamp,
      status: "success",
      changed,
      initialized,
      confirmed,
      durationMs: Math.round(performance.now() - started),
      count: first.merchants.length,
      previousCount: baseline.merchants.length || first.merchants.length,
      pagination: first.pagination,
      diff,
      summary,
      error: null,
    };
  } catch (error) {
    run = {
      id: timestamp,
      monitorId: "paze-directory",
      timestamp,
      status: "failure",
      changed: false,
      initialized: false,
      confirmed: false,
      durationMs: Math.round(performance.now() - started),
      count: null,
      previousCount: baseline.merchants.length || null,
      pagination: null,
      diff: { added: [], removed: [], renamed: [] },
      summary: "The crawl was incomplete; the last successful baseline was preserved.",
      error: error instanceof Error ? error.message : String(error),
    };
  }

  let event = null;
  if (run.changed) {
    event = {
      id: eventId(timestamp, "merchant-change"),
      type: "merchant_change",
      severity: "change",
      monitorId: run.monitorId,
      timestamp,
      title: "Paze merchant directory changed",
      summary: run.summary,
      count: run.count,
      diff: run.diff,
      dashboardUrl: "https://john-ta.com/tools/monitoring/",
      sourceUrl: SOURCE_URL,
    };
  } else if (run.status === "failure" && priorStatus !== "error") {
    event = {
      id: eventId(timestamp, "failure"),
      type: "monitor_failure",
      severity: "error",
      monitorId: run.monitorId,
      timestamp,
      title: "Paze directory monitor failed",
      summary: run.error,
      dashboardUrl: "https://john-ta.com/tools/monitoring/",
      sourceUrl: SOURCE_URL,
    };
  } else if (run.status === "success" && priorStatus === "error") {
    event = {
      id: eventId(timestamp, "recovery"),
      type: "monitor_recovery",
      severity: "recovery",
      monitorId: run.monitorId,
      timestamp,
      title: "Paze directory monitor recovered",
      summary: run.summary,
      dashboardUrl: "https://john-ta.com/tools/monitoring/",
      sourceUrl: SOURCE_URL,
    };
  }

  if (event) feed.events.unshift(event);
  feed.generatedAt = timestamp;
  feed.events = feed.events.slice(0, FEED_LIMIT);
  feed.latestEventId = feed.events[0]?.id ?? null;
  history.runs = [run, ...history.runs].slice(0, HISTORY_LIMIT);
  history.maxRuns = HISTORY_LIMIT;
  const state = createState({ previousState, run, baseline: nextBaseline, feed });

  await Promise.all([
    writeJson(paths.baseline, nextBaseline),
    writeJson(paths.history, history),
    writeJson(paths.feed, feed),
    writeJson(paths.state, state),
  ]);

  const label = run.status === "success" ? "PASS" : "FAIL";
  console.log(`${label} ${run.summary} (${run.durationMs} ms)`);
  if (run.error) console.error(run.error);
  process.exitCode = run.status === "success" ? 0 : 1;
  return run;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await runMonitor();
}
