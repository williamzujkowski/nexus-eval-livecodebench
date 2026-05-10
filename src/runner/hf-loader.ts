/**
 * HuggingFace-fetch loader for the LiveCodeBench `code_generation_lite`
 * dataset (v0.2).
 *
 * Source: `livecodebench/code_generation_lite` on HuggingFace.
 *
 * Approach:
 *   - Hit the datasets-server JSON endpoint
 *     (https://datasets-server.huggingface.co/rows?dataset=...&config=...&split=...&offset=...&length=N)
 *   - Page through up to 100 rows per request (HF cap)
 *   - Cache raw + normalised pages to disk per (dataset, config, split, version)
 *   - Filter at fetch boundary using the same predicates as the
 *     existing in-memory filter so we don't paginate everything just
 *     to drop most of it on the floor
 *
 * @module runner/hf-loader
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

import type { LiveCodeBenchInstance } from '../types.js';

/**
 * Default LiveCodeBench dataset slice. Pinned so runs reproduce; the
 * upstream rolls a new release every few months and operators who want
 * the bleeding edge override via `--source huggingface:<config>`.
 */
export const DEFAULT_HF_DATASET = 'livecodebench/code_generation_lite';
export const DEFAULT_HF_CONFIG = 'release_v3';
export const DEFAULT_HF_SPLIT = 'test';

const HF_PAGE_SIZE = 100;

export interface LoadFromHuggingFaceOptions {
  /** HF dataset slug. Default: `DEFAULT_HF_DATASET`. */
  readonly dataset?: string;
  /** Dataset config (release slice). Default: `DEFAULT_HF_CONFIG`. */
  readonly config?: string;
  /** Split name. Default: `DEFAULT_HF_SPLIT`. */
  readonly split?: string;
  /** Cache root. Default: `~/.nexus-eval-livecodebench/cache/`. */
  readonly cacheDir?: string;
  /** Filter platforms at fetch boundary. */
  readonly platforms?: ReadonlyArray<LiveCodeBenchInstance['platform']>;
  /** Filter difficulties at fetch boundary. */
  readonly difficulties?: ReadonlyArray<LiveCodeBenchInstance['difficulty']>;
  /** Filter to problems released on or after this ISO date. */
  readonly minReleaseDate?: string;
  /** Hard cap on the number of rows to fetch (saves on the wire). */
  readonly maxInstances?: number;
  /**
   * `fetch` injection point — only `globalThis.fetch` is used by default.
   * Tests inject a mock here without monkey-patching globals.
   */
  readonly fetchImpl?: typeof fetch;
}

export async function loadFromHuggingFace(
  options: LoadFromHuggingFaceOptions = {}
): Promise<readonly LiveCodeBenchInstance[]> {
  const dataset = options.dataset ?? DEFAULT_HF_DATASET;
  const config = options.config ?? DEFAULT_HF_CONFIG;
  const split = options.split ?? DEFAULT_HF_SPLIT;
  const cacheRoot =
    options.cacheDir ?? join(homedir(), '.nexus-eval-livecodebench', 'cache');
  const cacheDir = join(cacheRoot, slugify(dataset), slugify(config), slugify(split));
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;

  // 1. Try the cache.
  const cachePath = join(cacheDir, 'instances.json');
  if (existsSync(cachePath)) {
    const cached = JSON.parse(readFileSync(cachePath, 'utf8')) as readonly LiveCodeBenchInstance[];
    return applyFilters(cached, options);
  }

  // 2. Page through datasets-server.
  const all: LiveCodeBenchInstance[] = [];
  let offset = 0;
  while (true) {
    const url =
      `https://datasets-server.huggingface.co/rows?dataset=${encodeURIComponent(dataset)}` +
      `&config=${encodeURIComponent(config)}` +
      `&split=${encodeURIComponent(split)}` +
      `&offset=${String(offset)}` +
      `&length=${String(HF_PAGE_SIZE)}`;
    const page = await fetchPage(url, fetchImpl);
    if (page.rows.length === 0) break;
    for (const row of page.rows) {
      const inst = normaliseRow(row);
      if (inst === null) continue;
      all.push(inst);
    }
    offset += page.rows.length;
    // Be polite if the user hard-capped.
    if (options.maxInstances !== undefined && all.length >= options.maxInstances) break;
    // datasets-server signals the dataset end via num_rows_total but we
    // don't depend on that — the rows.length === 0 check is reliable.
    if (page.rows.length < HF_PAGE_SIZE) break;
  }

  // 3. Cache + return filtered.
  mkdirSync(dirname(cachePath), { recursive: true });
  writeFileSync(cachePath, JSON.stringify(all, null, 2), 'utf8');
  return applyFilters(all, options);
}

interface DatasetsServerRow {
  readonly row_idx: number;
  readonly row: Record<string, unknown>;
}

interface DatasetsServerPage {
  readonly rows: readonly DatasetsServerRow[];
  readonly num_rows_total?: number;
}

async function fetchPage(url: string, fetchImpl: typeof fetch): Promise<DatasetsServerPage> {
  const headers: Record<string, string> = {
    accept: 'application/json',
  };
  const token = process.env['HF_TOKEN'];
  if (token !== undefined && token !== '') headers.authorization = `Bearer ${token}`;
  const res = await fetchImpl(url, { headers });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(
      `HuggingFace datasets-server failed: ${String(res.status)} ${res.statusText}\n` +
        `URL: ${url}\nBody: ${body.slice(0, 500)}\n` +
        `If rate-limited or auth-blocked, set HF_TOKEN to a Hugging Face access token.`
    );
  }
  return (await res.json()) as DatasetsServerPage;
}

const VALID_PLATFORMS = new Set(['leetcode', 'atcoder', 'codeforces']);
const VALID_DIFFICULTIES = new Set(['easy', 'medium', 'hard']);

function normaliseRow(rowEntry: DatasetsServerRow): LiveCodeBenchInstance | null {
  const r = rowEntry.row;
  // The upstream schema uses snake_case + a few synonyms across releases.
  const instanceId = pickString(r, ['question_id', 'instance_id', 'id']) ?? `row-${String(rowEntry.row_idx)}`;
  const platform = pickString(r, ['platform', 'source']);
  if (platform === undefined || !VALID_PLATFORMS.has(platform)) return null;
  const difficulty = pickString(r, ['difficulty']);
  if (difficulty === undefined || !VALID_DIFFICULTIES.has(difficulty)) return null;
  const problemStatement = pickString(r, ['question_content', 'problem_statement', 'problemStatement']);
  if (problemStatement === undefined) return null;

  return {
    instanceId,
    platform: platform as LiveCodeBenchInstance['platform'],
    difficulty: difficulty as LiveCodeBenchInstance['difficulty'],
    problemStatement,
    publicTests: parsePublicTests(r['public_test_cases'] ?? r['publicTests'] ?? r['examples']),
    ...(pickString(r, ['starter_code', 'starterCode']) !== undefined && {
      starterCode: pickString(r, ['starter_code', 'starterCode']) as string,
    }),
    ...(pickString(r, ['contest_date', 'release_date', 'releaseDate']) !== undefined && {
      releaseDate: pickString(r, ['contest_date', 'release_date', 'releaseDate']) as string,
    }),
  };
}

function pickString(obj: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return undefined;
}

function parsePublicTests(raw: unknown): LiveCodeBenchInstance['publicTests'] {
  // The dataset publishes public test cases sometimes as JSON-stringified
  // arrays, sometimes as already-parsed arrays. Handle both.
  let arr: unknown = raw;
  if (typeof raw === 'string') {
    try {
      arr = JSON.parse(raw);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(arr)) return [];
  const out: Array<{ input: string; expectedOutput: string }> = [];
  for (const t of arr) {
    if (typeof t !== 'object' || t === null) continue;
    const r = t as Record<string, unknown>;
    const input = r['input'] ?? r['stdin'];
    const expectedOutput = r['expected_output'] ?? r['expectedOutput'] ?? r['stdout'] ?? r['output'];
    if (typeof input === 'string' && typeof expectedOutput === 'string') {
      out.push({ input, expectedOutput });
    }
  }
  return out;
}

function applyFilters(
  all: readonly LiveCodeBenchInstance[],
  options: LoadFromHuggingFaceOptions
): readonly LiveCodeBenchInstance[] {
  let filtered = all;
  if (options.platforms !== undefined && options.platforms.length > 0) {
    const allowed = new Set(options.platforms);
    filtered = filtered.filter((i) => allowed.has(i.platform));
  }
  if (options.difficulties !== undefined && options.difficulties.length > 0) {
    const allowed = new Set(options.difficulties);
    filtered = filtered.filter((i) => allowed.has(i.difficulty));
  }
  if (options.minReleaseDate !== undefined) {
    const cutoff = options.minReleaseDate;
    filtered = filtered.filter((i) => i.releaseDate === undefined || i.releaseDate >= cutoff);
  }
  if (options.maxInstances !== undefined && options.maxInstances < filtered.length) {
    filtered = filtered.slice(0, options.maxInstances);
  }
  return filtered;
}

function slugify(s: string): string {
  return s.replace(/[^a-zA-Z0-9._-]/g, '_');
}
