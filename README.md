# nexus-eval-livecodebench

LiveCodeBench evaluation harness for [nexus-agents](https://github.com/williamzujkowski/nexus-agents) — implements the `BenchmarkAdapter` contract from nexus-agents ≥ 2.33.1.

> **Status**: v0.3 — multi-turn agentic flow. Opt in with `agenticMode: true` (or `--agentic-mode`); the model gets `read_problem` / `write_solution` / `run_tests` tools and iterates until tests pass. Built on the `IAgenticAdapter` primitive from nexus-agents 2.72.1. v0.2 single-shot mode (HF loader + sandboxed Python runner) remains the default. Hidden-test join from upstream's `private_test_cases` companion dataset is still a follow-up.

## Why LiveCodeBench

[LiveCodeBench](https://livecodebench.github.io/) is a holistic, contamination-resistant code-generation benchmark from UC Berkeley. Distinguishing properties:

- **Rolling, dated problem set** — collected continuously from LeetCode, AtCoder, and Codeforces. Operators routinely slice runs by `min-release-date >= <model_cutoff>` to evaluate on problems the model couldn't have memorised.
- **Multi-platform** — three problem styles: LeetCode (function-fill), AtCoder (stdin/stdout), Codeforces (stdin/stdout, contest-graded). Catches platform-idiom blind spots that single-source benchmarks hide.
- **Three-bucket difficulty normalised across platforms** — easy/medium/hard. Lets summaries surface "does this model degrade on hard problems".
- **Deterministic hidden tests** — every problem has a fixed test set, so pass/fail is mechanical (no LLM-judge, no human eval).
- **Standard reference number** — Anthropic and OpenAI both publish LiveCodeBench scores routinely, so operators have a calibration target for routing decisions.

This repo is the dedicated harness for running LiveCodeBench through nexus-agents' orchestration. Per the [nexus-agents harness-extraction policy](https://github.com/williamzujkowski/nexus-agents/issues/2514), benchmarks live in standalone `nexus-eval-*` repos so they evolve independently of the core.

## Install

```sh
npm install nexus-eval-livecodebench nexus-agents
```

`nexus-agents` is a peer dependency.

## Quick start (CLI)

```sh
# Set the OpenAI-compat endpoint
export OPENAI_API_KEY=sk-...
export OPENAI_BASE_URL=https://your-gateway/v1   # optional
export MODEL_ID=anthropic/claude-sonnet-4-6      # optional

# Smoke test against the bundled four-problem fixture (no network, no
# python3 needed — fixture has hand-curated public tests).
npx nexus-eval-livecodebench --source fixture --no-run-tests

# Real run against the upstream HuggingFace dataset (v0.2: paginates
# datasets-server, caches to ~/.nexus-eval-livecodebench/). Requires
# python3 in PATH for true test-based pass/fail.
npx nexus-eval-livecodebench --source huggingface --limit 25

# Pin a specific release slice for reproducibility
npx nexus-eval-livecodebench --source huggingface:release_v3 --limit 25

# Run against a local .jsonl matching code_generation_lite schema
npx nexus-eval-livecodebench --source ./code_generation_lite.jsonl --limit 25

# Filter to LeetCode + Codeforces, hard only
npx nexus-eval-livecodebench --source huggingface \
  --platforms leetcode,codeforces --difficulties hard --limit 10

# Contamination guard — only problems released after the model's training cutoff
npx nexus-eval-livecodebench --source huggingface \
  --min-release-date 2024-08-01 --limit 10

# Skip the test runner (fast smoke without python3 installed)
npx nexus-eval-livecodebench --source huggingface --no-run-tests --limit 5

# JSON summary for piping
npx nexus-eval-livecodebench --json --source fixture > run.json
```

## Library usage

```ts
import { runBenchmark, createOpenAIAdapter } from 'nexus-agents';
import { LiveCodeBenchAdapter } from 'nexus-eval-livecodebench';

const modelAdapter = createOpenAIAdapter({
  apiKey: process.env.OPENAI_API_KEY!,
  modelId: 'gpt-4o',
});

const adapter = new LiveCodeBenchAdapter(modelAdapter, {
  source: 'fixture',
  difficulties: ['medium', 'hard'],
});
const summary = await runBenchmark(adapter, {}, { concurrency: 4 });

console.log(
  `Produced solutions for ${summary.passed}/${summary.total} ` +
    `(${(summary.passRate * 100).toFixed(1)}%)`
);

const meta = summary.metadata as {
  byPlatform: Record<string, { total: number; passed: number; passRate: number }>;
  byDifficulty: Record<string, { total: number; passed: number; passRate: number }>;
};
for (const [name, stats] of Object.entries(meta.byDifficulty)) {
  console.log(`  ${name}: ${stats.passed}/${stats.total} (${(stats.passRate * 100).toFixed(1)}%)`);
}
```

Operators with their own `IModelAdapter` (Claude API, Ollama, anything implementing the contract) can substitute it for `createOpenAIAdapter` without changing anything else.

## What v0.2 actually does

**Loader (3 sources):**

- `--source fixture` — bundled four-problem smoke set (LeetCode / AtCoder / Codeforces × easy/medium/hard), no network
- `--source huggingface[:<config>]` — pages through the [`livecodebench/code_generation_lite` HuggingFace dataset](https://huggingface.co/datasets/livecodebench/code_generation_lite) via the datasets-server JSON API. Default config: `release_v3`. Caches to `~/.nexus-eval-livecodebench/cache/<dataset>/<config>/<split>/instances.json`. Set `HF_TOKEN` env var if you hit rate limits on heavy paginations
- `--source <local.jsonl>` — read from disk; same schema as the upstream dataset

**Filters apply at fetch boundary:** `--platforms` / `--difficulties` / `--min-release-date` / `--limit` short-circuit pagination so we don't fetch everything just to filter most of it.

**Prompt:** competitive-programming format. Problem statement + public sample I/O pairs + (optional) starter code. Model emits a single fenced ` ```python ``` ` block.

**Code extraction:** prefers the last `python`-tagged fence > last untagged fence > raw-Python heuristic.

**Evaluation (v0.2 default):** materialises the model's solution to a tmpdir + spawns `python3` per public test. Two competitive-programming styles auto-detected from the instance:

- **LeetCode-style** (starterCode declares `class Solution`): synthesises a tiny driver that imports `Solution`, evaluates the test setup expression (e.g. `nums = [1,2], target = 3`), introspects the only public method, calls it with the named args, compares to the expected output literal.
- **AtCoder/Codeforces-style** (no class skeleton): spawns `python3` with `test.input` on stdin, diffs stdout against `test.expectedOutput`.

Pass = all public tests pass within timeout. `-x` semantics: stops on first failing test. Sandboxing: tmpdir, `spawn` (no shell), 15s default per-test timeout via `setTimeout` + `SIGKILL`, env scrubbed of secrets (`OPENAI_*`, `NEXUS_*`, `HF_TOKEN`, `AWS_*`, ...), output capped at 4 KB per stream.

Per-platform AND per-difficulty pass-rate breakdowns surface in the summary metadata.

## What v0.2 does NOT do

- Join the upstream `private_test_cases` companion dataset for the full hidden-test set. v0.2 evaluation runs the published `public_test_cases` only — adequate for the rolling-contamination signal but understates real LiveCodeBench pass-rates relative to the leaderboard.
- Other LiveCodeBench tasks (`self_repair`, `test_output_prediction`, `code_execution`) — each is a separate task family that would land as its own adapter variant.
- Multi-turn agentic flows.

## Roadmap

| Issue | Scope                                                                                                                                                                                  |
| ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| TBD   | **v0.3 — Hidden tests join**. Pull `private_test_cases` from the companion dataset; combine with the public set so pass/fail matches the upstream leaderboard's grading.               |
| TBD   | **v0.3 — Other task families** (`self_repair` / `test_output_prediction` / `code_execution`).                                                                                          |
| TBD   | **v0.3 — Agentic flow** via `ICliAdapter` so the model can iterate when initial tests fail.                                                                                            |

Cross-repo tracking lives at [nexus-agents #2519](https://github.com/williamzujkowski/nexus-agents/issues/2519) (Tier 2 prioritisation).

## The contract

`BenchmarkAdapter` from nexus-agents:

```ts
interface BenchmarkAdapter<TInstance, TPrediction, TEvalResult> {
  readonly name: string;
  readonly variant?: string;
  loadInstances(config): Promise<readonly TInstance[]>;
  runInstance(instance, ctx): Promise<TPrediction>;
  evaluate(instance, prediction): Promise<TEvalResult>;
  isPass(result): boolean;
  summarize(results, runTimeMs): BenchmarkRunSummary;
}
```

The orchestrator (`runBenchmark` in nexus-agents) handles concurrency, timeouts, progress, and partial failure — this repo doesn't reimplement the harness.

## License

MIT.
