#!/usr/bin/env node
/**
 * LiveCodeBench evaluation CLI.
 *
 * Usage:
 *   nexus-eval-livecodebench [run] [options]
 *   nexus-eval-livecodebench --version
 *   nexus-eval-livecodebench --help
 *
 * Constructs an OpenAI-compatible IModelAdapter from env vars
 * (OPENAI_API_KEY, optional OPENAI_BASE_URL, MODEL_ID). Operators
 * who need a different adapter shape can compose LiveCodeBenchAdapter
 * directly via the library API.
 *
 * @module cli
 */

import { parseArgs } from 'node:util';
import { runBenchmark, createOpenAIAdapter } from 'nexus-agents';
import { LiveCodeBenchAdapter } from './adapter.js';
import type { LiveCodeBenchInstance } from './types.js';

const VALID_PLATFORMS: ReadonlyArray<LiveCodeBenchInstance['platform']> = [
  'leetcode',
  'atcoder',
  'codeforces',
];
const VALID_DIFFICULTIES: ReadonlyArray<LiveCodeBenchInstance['difficulty']> = [
  'easy',
  'medium',
  'hard',
];

const HELP = `nexus-eval-livecodebench — LiveCodeBench evaluation harness

Usage:
  nexus-eval-livecodebench [run] [options]
  nexus-eval-livecodebench --version
  nexus-eval-livecodebench --help

Options:
  --model-id <id>             Model identifier passed to the OpenAI-compat
                              endpoint. Default: env MODEL_ID or 'gpt-4o'.
  --source <fixture|huggingface|huggingface:<config>|path>
                              Where to load problems from. Default: fixture.
                              'fixture' loads the bundled four-problem smoke
                              set; 'huggingface' fetches from
                              livecodebench/code_generation_lite (set
                              HF_TOKEN if rate-limited); 'huggingface:<config>'
                              pins a release slice (default: release_v3);
                              <path> points at a local .jsonl.
  --no-run-tests              Skip the sandboxed Python runner; pass/fail
                              degrades to v0.1 "did the model produce code".
                              Useful for fast smoke runs without python3.
  --test-timeout <ms>         Per-test timeout. Default: 15000.
  --platforms <comma-list>    Filter by platform (leetcode,atcoder,
                              codeforces). Default: all.
  --difficulties <comma-list> Filter by difficulty (easy,medium,hard).
  --min-release-date <YYYY-MM-DD>
                              Only include problems released on or after
                              this date — the standard contamination
                              guard for a given training cutoff.
  --limit <n>                 Limit problems. Default: all.
  --concurrency <n>           Max parallel solver calls. Default: 1.
  --timeout <ms>              Per-instance timeout. Default: 300000.
  --json                      JSON summary instead of human text.
  --help, -h                  Show this help.
  --version, -v               Show version.

Environment:
  OPENAI_API_KEY      (required) auth for the OpenAI-compat endpoint.
  OPENAI_BASE_URL     (optional) override base URL.
  MODEL_ID            (optional) default model — overridden by --model-id.

Notes:
  v0.1 is a model-only baseline — sends each problem's statement +
  public tests + (optional) starter code to the model and parses out a
  Python solution. Pass/fail reflects "did the model produce extractable
  code", NOT test-based resolution. v0.2 adds the sandboxed Python
  runner for true test-based pass/fail.
`;

function parsePlatforms(input: string | undefined): LiveCodeBenchInstance['platform'][] | undefined {
  return parseEnumList(input, VALID_PLATFORMS, '--platforms');
}

function parseDifficulties(input: string | undefined): LiveCodeBenchInstance['difficulty'][] | undefined {
  return parseEnumList(input, VALID_DIFFICULTIES, '--difficulties');
}

function parseEnumList<T extends string>(
  input: string | undefined,
  valid: readonly T[],
  flag: string
): T[] | undefined {
  if (input === undefined || input === '') return undefined;
  const parts = input.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
  for (const p of parts) {
    if (!(valid as readonly string[]).includes(p)) {
      throw new Error(
        `Invalid ${flag} value '${p}'. Must be one of: ${valid.join(', ')}`
      );
    }
  }
  return parts as T[];
}

async function main(argv: readonly string[]): Promise<number> {
  const args = argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    process.stdout.write(HELP);
    return 0;
  }
  if (args.includes('--version') || args.includes('-v')) {
    process.stdout.write('nexus-eval-livecodebench 0.2.0\n');
    return 0;
  }

  const parsed = parseArgs({
    args: args[0] === 'run' ? args.slice(1) : args,
    options: {
      'model-id': { type: 'string' },
      source: { type: 'string' },
      platforms: { type: 'string' },
      difficulties: { type: 'string' },
      'min-release-date': { type: 'string' },
      'no-run-tests': { type: 'boolean', default: false },
      'test-timeout': { type: 'string' },
      limit: { type: 'string' },
      concurrency: { type: 'string', default: '1' },
      timeout: { type: 'string', default: '300000' },
      json: { type: 'boolean', default: false },
    },
    allowPositionals: true,
    strict: true,
  });

  const apiKey = process.env['OPENAI_API_KEY']?.trim();
  if (apiKey === undefined || apiKey === '') {
    process.stderr.write(
      'Error: OPENAI_API_KEY is not set. Set it to the auth token for your\n' +
        'OpenAI-compat endpoint (real OpenAI, a workspace proxy, vLLM, etc.).\n'
    );
    return 2;
  }

  const modelId =
    parsed.values['model-id'] ?? process.env['MODEL_ID'] ?? 'gpt-4o';
  const baseUrl = process.env['OPENAI_BASE_URL'];
  const limit =
    parsed.values.limit !== undefined ? Number(parsed.values.limit) : undefined;
  const concurrency = Number(parsed.values.concurrency ?? '1');
  const timeoutMs = Number(parsed.values.timeout ?? '300000');
  const platforms = parsePlatforms(parsed.values.platforms);
  const difficulties = parseDifficulties(parsed.values.difficulties);

  const modelAdapter = createOpenAIAdapter({
    apiKey,
    modelId,
    ...(baseUrl !== undefined && baseUrl !== '' && { baseUrl }),
  });

  const adapter = new LiveCodeBenchAdapter(modelAdapter, {
    ...(parsed.values.source !== undefined && { source: parsed.values.source }),
    ...(platforms !== undefined && { platforms }),
    ...(difficulties !== undefined && { difficulties }),
    ...(parsed.values['min-release-date'] !== undefined && {
      minReleaseDate: parsed.values['min-release-date'],
    }),
    ...(parsed.values['no-run-tests'] === true && { runTests: false }),
    ...(parsed.values['test-timeout'] !== undefined && {
      testTimeoutMs: Number(parsed.values['test-timeout']),
    }),
  });

  const summary = await runBenchmark(adapter, {}, {
    concurrency,
    instanceTimeoutMs: timeoutMs,
    ...(limit !== undefined ? { limit } : {}),
    onProgress: (done: number, total: number): void => {
      if (!parsed.values.json) {
        process.stderr.write(`[${String(done)}/${String(total)}]\r`);
      }
    },
  });

  if (parsed.values.json) {
    process.stdout.write(JSON.stringify(summary, null, 2) + '\n');
  } else {
    process.stdout.write('\n');
    process.stdout.write(`${adapter.name} (model=${modelId})\n`);
    process.stdout.write(
      `  produced:   ${String(summary.passed)} / ${String(summary.total)} extractable solutions\n`
    );
    process.stdout.write(`  rate:       ${(summary.passRate * 100).toFixed(1)}%\n`);
    process.stdout.write(`  runtime:    ${(summary.runTimeMs / 1000).toFixed(1)}s\n`);
    const meta = summary.metadata as {
      byPlatform?: Record<string, { total: number; passed: number; passRate: number }>;
      byDifficulty?: Record<string, { total: number; passed: number; passRate: number }>;
    };
    if (meta.byPlatform !== undefined) {
      process.stdout.write('  by platform:\n');
      for (const [name, stats] of Object.entries(meta.byPlatform)) {
        process.stdout.write(
          `    ${name.padEnd(11)}  ${String(stats.passed)}/${String(stats.total)} ` +
            `(${(stats.passRate * 100).toFixed(1)}%)\n`
        );
      }
    }
    if (meta.byDifficulty !== undefined) {
      process.stdout.write('  by difficulty:\n');
      for (const [name, stats] of Object.entries(meta.byDifficulty)) {
        process.stdout.write(
          `    ${name.padEnd(11)}  ${String(stats.passed)}/${String(stats.total)} ` +
            `(${(stats.passRate * 100).toFixed(1)}%)\n`
        );
      }
    }
  }

  return summary.passed === summary.total ? 0 : 1;
}

main(process.argv)
  .then((code) => {
    process.exit(code);
  })
  .catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`Fatal: ${msg}\n`);
    process.exit(2);
  });
