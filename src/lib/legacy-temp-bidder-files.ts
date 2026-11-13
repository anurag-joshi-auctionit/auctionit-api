import { access, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { env } from "../env.js";

const LEGACY_HTTP_FETCH_TIMEOUT_MS = 8_000;
const DEFAULT_HTTP_PRESCAN_BATCH_SIZE = 20;
const LEGACY_HTTP_EXISTS_MAX_ATTEMPTS = 3;

function isHttpRoot(root: string): boolean {
  return /^https?:\/\//i.test(root);
}

async function fetchWithTimeout(
  url: string,
  init?: RequestInit,
  timeoutMs = LEGACY_HTTP_FETCH_TIMEOUT_MS,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

export function joinLegacyTempBidderInfoPath(
  root: string,
  fileName: string,
): string {
  if (isHttpRoot(root)) {
    return `${root.replace(/\/+$/, "")}/${fileName}`;
  }
  return join(root, fileName);
}

export function requireLegacyTempBidderInfoPath(): string {
  const root = env.LEGACY_BIDDER_TEMP_INFO_PATH;
  if (!root?.trim()) {
    throw new Error("LEGACY_BIDDER_TEMP_INFO_PATH must be set.");
  }
  return root;
}

export function isHttpLegacyTempBidderRoot(): boolean {
  return isHttpRoot(requireLegacyTempBidderInfoPath());
}

export async function listLegacyTempBidderFileNames(): Promise<Set<string>> {
  const root = requireLegacyTempBidderInfoPath();
  if (isHttpRoot(root)) {
    const listed = await listLegacyTempBidderFileNamesFromHttp(root);
    if (!listed) {
      throw new Error(
        "HTTP legacy root does not expose a directory listing; use discoverLegacyTempBidderFiles instead.",
      );
    }
    return listed;
  }
  const entries = await readdir(root);
  return new Set(entries);
}

/** Parse IIS/Apache-style directory index HTML into a filename set. */
export function parseHttpDirectoryListingHtml(html: string): Set<string> {
  const fileNames = new Set<string>();
  const hrefRegex = /href=["']([^"'?#]+)["']/gi;
  let match: RegExpExecArray | null;
  while ((match = hrefRegex.exec(html)) !== null) {
    const raw = decodeURIComponent(match[1]!.trim());
    if (
      !raw ||
      raw === ".." ||
      raw === "." ||
      raw.endsWith("/") ||
      raw.startsWith("?")
    ) {
      continue;
    }
    const name = raw.split("/").pop() ?? raw;
    if (name.includes(".")) {
      fileNames.add(name);
    }
  }
  return fileNames;
}

export async function listLegacyTempBidderFileNamesFromHttp(
  root: string,
): Promise<Set<string> | null> {
  const url = `${root.replace(/\/+$/, "")}/`;
  try {
    const response = await fetchWithTimeout(url);
    if (!response.ok) return null;

    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.includes("html")) return null;

    const html = await response.text();
    const fileNames = parseHttpDirectoryListingHtml(html);
    return fileNames.size > 0 ? fileNames : null;
  } catch {
    return null;
  }
}

function isRetryableLegacyHttpError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return (
    err.name === "AbortError" ||
    err.message.includes("fetch failed") ||
    err.message.includes("ECONNRESET") ||
    err.message.includes("ETIMEDOUT")
  );
}

async function legacyHttpFileExists(path: string): Promise<boolean> {
  const response = await fetchWithTimeout(path, { method: "HEAD" });
  if (response.status === 404) return false;
  if (response.ok) return true;
  if (response.status === 405) {
    const rangeResponse = await fetchWithTimeout(path, {
      method: "GET",
      headers: { Range: "bytes=0-0" },
    });
    return rangeResponse.ok || rangeResponse.status === 206;
  }
  return false;
}

export async function legacyTempBidderFileExists(
  fileName: string,
): Promise<boolean> {
  const root = requireLegacyTempBidderInfoPath();
  const path = joinLegacyTempBidderInfoPath(root, fileName);

  if (isHttpRoot(root)) {
    for (let attempt = 1; attempt <= LEGACY_HTTP_EXISTS_MAX_ATTEMPTS; attempt++) {
      try {
        return await legacyHttpFileExists(path);
      } catch (err) {
        if (
          attempt < LEGACY_HTTP_EXISTS_MAX_ATTEMPTS &&
          isRetryableLegacyHttpError(err)
        ) {
          await new Promise((resolve) => setTimeout(resolve, 200 * attempt));
          continue;
        }
        return false;
      }
    }
    return false;
  }

  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function filterConcurrentBatched<T>(
  items: readonly T[],
  batchSize: number,
  predicate: (item: T) => Promise<boolean>,
  onProgress?: (done: number, total: number, found: number) => void,
): Promise<T[]> {
  if (items.length === 0) return [];

  const matched: T[] = [];
  let done = 0;

  for (let offset = 0; offset < items.length; offset += batchSize) {
    const batch = items.slice(offset, offset + batchSize);
    const results = await Promise.all(
      batch.map(async (item) => ({
        item,
        ok: await predicate(item),
      })),
    );
    for (const { item, ok } of results) {
      if (ok) matched.push(item);
    }
    done += batch.length;
    onProgress?.(done, items.length, matched.length);
  }

  return matched;
}

export type LegacyTempBidderFileDiscoveryProgress = {
  done: number;
  total: number;
  found: number;
  mode: "local-listing" | "http-listing" | "http-head";
};

export async function discoverLegacyTempBidderFiles(
  fileNames: readonly string[],
  opts?: {
    concurrency?: number;
    onProgress?: (progress: LegacyTempBidderFileDiscoveryProgress) => void;
  },
): Promise<Set<string>> {
  const root = requireLegacyTempBidderInfoPath();
  const unique = [
    ...new Set(fileNames.map((f) => f.trim()).filter((f) => f.length > 0)),
  ];

  if (unique.length === 0) return new Set();

  const report = (
    mode: LegacyTempBidderFileDiscoveryProgress["mode"],
    done: number,
    total: number,
    found: number,
  ) => opts?.onProgress?.({ done, total, found, mode });

  if (!isHttpRoot(root)) {
    const available = await listLegacyTempBidderFileNames();
    const existing = unique.filter((fileName) => available.has(fileName));
    report("local-listing", unique.length, unique.length, existing.length);
    return new Set(existing);
  }

  const listed = await listLegacyTempBidderFileNamesFromHttp(root);
  if (listed) {
    const existing = unique.filter((fileName) => listed.has(fileName));
    report("http-listing", unique.length, unique.length, existing.length);
    return new Set(existing);
  }

  const batchSize = opts?.concurrency ?? DEFAULT_HTTP_PRESCAN_BATCH_SIZE;
  const existing = await filterConcurrentBatched(
    unique,
    batchSize,
    (fileName) => legacyTempBidderFileExists(fileName),
    (done, total, found) => report("http-head", done, total, found),
  );
  return new Set(existing);
}

export async function readLegacyTempBidderFile(
  fileName: string,
): Promise<Buffer> {
  const root = requireLegacyTempBidderInfoPath();
  const path = joinLegacyTempBidderInfoPath(root, fileName);

  if (isHttpRoot(root)) {
    const response = await fetchWithTimeout(path);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} fetching ${path}`);
    }
    const arrayBuffer = await response.arrayBuffer();
    return Buffer.from(arrayBuffer);
  }

  await access(path);
  return readFile(path);
}
