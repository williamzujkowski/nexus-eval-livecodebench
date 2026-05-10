/**
 * Tests for the HuggingFace datasets-server loader.
 *
 * Mocks `fetch` via the fetchImpl injection — no network in CI.
 */
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { loadFromHuggingFace } from './hf-loader.js';

interface FakeRow {
  question_id: string;
  platform: string;
  difficulty: string;
  question_content: string;
  public_test_cases?: string;
  starter_code?: string;
  contest_date?: string;
}

function makePage(rows: readonly FakeRow[]): Response {
  return new Response(
    JSON.stringify({
      rows: rows.map((row, idx) => ({ row_idx: idx, row })),
      num_rows_total: rows.length,
    }),
    { status: 200, headers: { 'content-type': 'application/json' } }
  );
}

describe('loadFromHuggingFace', () => {
  let cacheDir: string;
  beforeEach(() => {
    cacheDir = mkdtempSync(join(tmpdir(), 'livecodebench-hf-test-'));
    delete process.env['HF_TOKEN'];
  });
  afterEach(() => {
    rmSync(cacheDir, { recursive: true, force: true });
  });

  it('paginates the datasets-server JSON endpoint', async () => {
    let calls = 0;
    const fetchImpl = vi.fn(async () => {
      calls += 1;
      if (calls === 1) {
        return makePage([
          {
            question_id: 'leetcode-1',
            platform: 'leetcode',
            difficulty: 'easy',
            question_content: 'Two sum.',
            public_test_cases: '[]',
          },
        ]);
      }
      // Empty page to terminate.
      return makePage([]);
    }) as unknown as typeof fetch;

    const instances = await loadFromHuggingFace({ cacheDir, fetchImpl });
    expect(instances).toHaveLength(1);
    expect(instances[0]?.instanceId).toBe('leetcode-1');
    expect(instances[0]?.platform).toBe('leetcode');
  });

  it('drops rows with invalid platform', async () => {
    const fetchImpl = vi.fn(async () => {
      return makePage([
        {
          question_id: 'bad',
          platform: 'codewars', // not in VALID_PLATFORMS
          difficulty: 'easy',
          question_content: 'Q',
        },
        {
          question_id: 'good',
          platform: 'leetcode',
          difficulty: 'easy',
          question_content: 'Q',
        },
      ]);
    }) as unknown as typeof fetch;
    const instances = await loadFromHuggingFace({ cacheDir, fetchImpl });
    expect(instances).toHaveLength(1);
    expect(instances[0]?.instanceId).toBe('good');
  });

  it('parses public_test_cases when supplied as a JSON string', async () => {
    const fetchImpl = vi.fn(async () => {
      return makePage([
        {
          question_id: 'q1',
          platform: 'leetcode',
          difficulty: 'easy',
          question_content: 'Q',
          public_test_cases: JSON.stringify([
            { input: 'in', expected_output: 'out' },
          ]),
        },
      ]);
    }) as unknown as typeof fetch;
    const instances = await loadFromHuggingFace({ cacheDir, fetchImpl });
    expect(instances[0]?.publicTests).toEqual([{ input: 'in', expectedOutput: 'out' }]);
  });

  it('caches rows to disk; second call serves from cache', async () => {
    let networkCalls = 0;
    const fetchImpl = vi.fn(async () => {
      networkCalls += 1;
      return makePage(
        networkCalls === 1
          ? [
              {
                question_id: 'cache-test',
                platform: 'leetcode',
                difficulty: 'easy',
                question_content: 'Q',
              },
            ]
          : []
      );
    }) as unknown as typeof fetch;

    await loadFromHuggingFace({ cacheDir, fetchImpl });
    const firstCalls = networkCalls;
    expect(firstCalls).toBeGreaterThan(0);

    await loadFromHuggingFace({ cacheDir, fetchImpl });
    expect(networkCalls).toBe(firstCalls); // no new fetches
  });

  it('attaches HF_TOKEN auth header when env is set', async () => {
    process.env['HF_TOKEN'] = 'sekret';
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string> | undefined;
      expect(headers?.['authorization']).toBe('Bearer sekret');
      return makePage([]);
    }) as unknown as typeof fetch;
    await loadFromHuggingFace({ cacheDir, fetchImpl });
  });

  it('surfaces a clear error on non-2xx', async () => {
    const fetchImpl = vi.fn(async () => {
      return new Response('rate limit', { status: 429, statusText: 'Too Many Requests' });
    }) as unknown as typeof fetch;
    await expect(loadFromHuggingFace({ cacheDir, fetchImpl })).rejects.toThrow(
      /HuggingFace.*429.*HF_TOKEN/s
    );
  });

  it('applies platforms / difficulties filters', async () => {
    const fetchImpl = vi.fn(async () => {
      return makePage([
        {
          question_id: 'lc-easy',
          platform: 'leetcode',
          difficulty: 'easy',
          question_content: 'Q',
        },
        {
          question_id: 'cf-hard',
          platform: 'codeforces',
          difficulty: 'hard',
          question_content: 'Q',
        },
        {
          question_id: 'lc-hard',
          platform: 'leetcode',
          difficulty: 'hard',
          question_content: 'Q',
        },
      ]);
    }) as unknown as typeof fetch;
    const instances = await loadFromHuggingFace({
      cacheDir,
      fetchImpl,
      platforms: ['leetcode'],
      difficulties: ['easy'],
    });
    expect(instances).toHaveLength(1);
    expect(instances[0]?.instanceId).toBe('lc-easy');
  });

  it('writes cache file in JSON form', async () => {
    const fetchImpl = vi.fn(async () => {
      return makePage([
        {
          question_id: 'c1',
          platform: 'leetcode',
          difficulty: 'easy',
          question_content: 'Q',
        },
      ]);
    }) as unknown as typeof fetch;
    await loadFromHuggingFace({ cacheDir, fetchImpl, dataset: 'foo/bar', config: 'v1' });
    const cachePath = join(cacheDir, 'foo_bar', 'v1', 'test', 'instances.json');
    const cached = JSON.parse(readFileSync(cachePath, 'utf8')) as Array<{ instanceId: string }>;
    expect(cached[0]?.instanceId).toBe('c1');
  });
});
