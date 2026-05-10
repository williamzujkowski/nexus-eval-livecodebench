/**
 * LiveCodeBench instance loader.
 *
 * v0.1 scope:
 *   - Bundled fixture (4 problems spanning platforms × difficulties)
 *     for smoke testing without network.
 *   - Local `.jsonl` source — point at any file matching the upstream
 *     dataset's schema (`livecodebench/code_generation_lite` rows).
 *
 * v0.2 follow-up: HuggingFace-fetch source. The dataset lives at
 * https://huggingface.co/datasets/livecodebench/code_generation_lite
 * and is paginated through the datasets-server JSON API.
 *
 * @module runner/instance-loader
 */

import { existsSync, readFileSync } from 'node:fs';

import type { LiveCodeBenchInstance } from '../types.js';
import { loadFromHuggingFace, type LoadFromHuggingFaceOptions } from './hf-loader.js';

const FIXTURE: readonly LiveCodeBenchInstance[] = [
  {
    instanceId: 'leetcode__two-sum',
    platform: 'leetcode',
    difficulty: 'easy',
    problemStatement:
      'Given an array of integers nums and an integer target, return indices of the two numbers such that they add up to target. You may assume that each input would have exactly one solution, and you may not use the same element twice.',
    publicTests: [
      { input: 'nums = [2,7,11,15], target = 9', expectedOutput: '[0,1]' },
      { input: 'nums = [3,2,4], target = 6', expectedOutput: '[1,2]' },
    ],
    starterCode:
      'class Solution:\n    def twoSum(self, nums: list[int], target: int) -> list[int]:\n        pass\n',
    releaseDate: '2015-08-08',
  },
  {
    instanceId: 'codeforces__sum-of-array',
    platform: 'codeforces',
    difficulty: 'easy',
    problemStatement:
      'Read an integer N on the first line, then N integers on the second line. Print their sum.',
    publicTests: [
      { input: '3\n1 2 3', expectedOutput: '6' },
      { input: '5\n10 20 30 40 50', expectedOutput: '150' },
    ],
    releaseDate: '2024-01-15',
  },
  {
    instanceId: 'atcoder__abc-300-a',
    platform: 'atcoder',
    difficulty: 'medium',
    problemStatement:
      'You are given two integers A and B (1 ≤ A, B ≤ 100). Print "Yes" if A * B is even, "No" otherwise.',
    publicTests: [
      { input: '2 3', expectedOutput: 'Yes' },
      { input: '5 7', expectedOutput: 'No' },
    ],
    releaseDate: '2024-04-22',
  },
  {
    instanceId: 'leetcode__longest-palindromic-substring',
    platform: 'leetcode',
    difficulty: 'hard',
    problemStatement:
      'Given a string s, return the longest palindromic substring in s.',
    publicTests: [
      { input: 's = "babad"', expectedOutput: '"bab"' },
      { input: 's = "cbbd"', expectedOutput: '"bb"' },
    ],
    starterCode:
      'class Solution:\n    def longestPalindrome(self, s: str) -> str:\n        pass\n',
    releaseDate: '2014-10-08',
  },
];

const VALID_PLATFORMS = new Set(['leetcode', 'atcoder', 'codeforces']);
const VALID_DIFFICULTIES = new Set(['easy', 'medium', 'hard']);

export async function loadLiveCodeBenchInstances(args: {
  readonly source?: 'fixture' | 'huggingface' | string;
  readonly platforms?: ReadonlyArray<LiveCodeBenchInstance['platform']>;
  readonly difficulties?: ReadonlyArray<LiveCodeBenchInstance['difficulty']>;
  readonly minReleaseDate?: string;
  readonly maxInstances?: number;
  readonly hfOptions?: LoadFromHuggingFaceOptions;
}): Promise<readonly LiveCodeBenchInstance[]> {
  const source = args.source ?? 'fixture';

  let all: readonly LiveCodeBenchInstance[];
  if (source === 'fixture') {
    all = FIXTURE;
  } else if (source === 'huggingface' || source.startsWith('huggingface:')) {
    const config = source.startsWith('huggingface:')
      ? source.slice('huggingface:'.length)
      : undefined;
    all = await loadFromHuggingFace({
      ...(args.hfOptions ?? {}),
      ...(config !== undefined && config !== '' && { config }),
      ...(args.platforms !== undefined && { platforms: args.platforms }),
      ...(args.difficulties !== undefined && { difficulties: args.difficulties }),
      ...(args.minReleaseDate !== undefined && { minReleaseDate: args.minReleaseDate }),
      ...(args.maxInstances !== undefined && { maxInstances: args.maxInstances }),
    });
    // hf-loader applies filters internally; return early.
    return all;
  } else {
    all = loadFromJsonl(source);
  }

  let filtered = all;
  if (args.platforms !== undefined && args.platforms.length > 0) {
    const allowed = new Set(args.platforms);
    filtered = filtered.filter((i) => allowed.has(i.platform));
  }
  if (args.difficulties !== undefined && args.difficulties.length > 0) {
    const allowed = new Set(args.difficulties);
    filtered = filtered.filter((i) => allowed.has(i.difficulty));
  }
  if (args.minReleaseDate !== undefined) {
    const cutoff = args.minReleaseDate;
    filtered = filtered.filter(
      (i) => i.releaseDate === undefined || i.releaseDate >= cutoff
    );
  }
  if (args.maxInstances !== undefined && args.maxInstances < filtered.length) {
    filtered = filtered.slice(0, args.maxInstances);
  }
  return filtered;
}

function loadFromJsonl(path: string): readonly LiveCodeBenchInstance[] {
  if (!existsSync(path)) {
    throw new Error(`LiveCodeBench .jsonl path not found: ${path}`);
  }
  const lines = readFileSync(path, 'utf8').split('\n').filter((l) => l.trim().length > 0);
  return lines.map((line, idx) => {
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch (e: unknown) {
      throw new Error(
        `Failed to parse .jsonl row ${String(idx)} in ${path}: ${e instanceof Error ? e.message : String(e)}`
      );
    }
    return normaliseRow(raw, idx);
  });
}

function normaliseRow(raw: unknown, idx: number): LiveCodeBenchInstance {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error(`.jsonl row ${String(idx)} is not an object`);
  }
  const r = raw as Record<string, unknown>;
  const instanceId = pickString(r, ['instanceId', 'instance_id', 'question_id', 'id']);
  const platform = pickString(r, ['platform', 'source']);
  if (!VALID_PLATFORMS.has(platform)) {
    throw new Error(
      `.jsonl row ${String(idx)} has invalid platform '${platform}' — must be one of: ${[...VALID_PLATFORMS].join(', ')}`
    );
  }
  const difficulty = pickString(r, ['difficulty']);
  if (!VALID_DIFFICULTIES.has(difficulty)) {
    throw new Error(
      `.jsonl row ${String(idx)} has invalid difficulty '${difficulty}' — must be one of: ${[...VALID_DIFFICULTIES].join(', ')}`
    );
  }
  const problemStatement = pickString(r, ['problemStatement', 'problem_statement', 'question_content']);
  const publicTests = parsePublicTests(r['publicTests'] ?? r['public_tests'] ?? r['examples']);
  const starterCode = optString(r, ['starterCode', 'starter_code']);
  const releaseDate = optString(r, ['releaseDate', 'release_date', 'contest_date']);

  return {
    instanceId,
    platform: platform as LiveCodeBenchInstance['platform'],
    difficulty: difficulty as LiveCodeBenchInstance['difficulty'],
    problemStatement,
    publicTests,
    ...(starterCode !== undefined && { starterCode }),
    ...(releaseDate !== undefined && { releaseDate }),
  };
}

function pickString(obj: Record<string, unknown>, keys: readonly string[]): string {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  throw new Error(`Missing required field — tried: ${keys.join(', ')}`);
}

function optString(obj: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return undefined;
}

function parsePublicTests(raw: unknown): LiveCodeBenchInstance['publicTests'] {
  if (!Array.isArray(raw)) return [];
  const out: Array<{ input: string; expectedOutput: string }> = [];
  for (const t of raw) {
    if (typeof t !== 'object' || t === null) continue;
    const r = t as Record<string, unknown>;
    const input = r['input'] ?? r['stdin'];
    const expectedOutput = r['expectedOutput'] ?? r['expected_output'] ?? r['stdout'] ?? r['output'];
    if (typeof input === 'string' && typeof expectedOutput === 'string') {
      out.push({ input, expectedOutput });
    }
  }
  return out;
}
