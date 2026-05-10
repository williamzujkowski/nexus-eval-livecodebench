/**
 * Public type contracts for the LiveCodeBench harness.
 *
 * @module types
 */

/**
 * LiveCodeBench's three task families. v0.1 covers `code_generation`
 * only — it's the most common task and has the simplest evaluation
 * (run hidden tests against generated code). The other two are tracked
 * as v0.3+ follow-ups:
 *
 * - `code_generation`     — given problem + starter, emit Python solution.
 * - `self_repair`         — given a failing solution + tests, fix it.
 * - `test_output_prediction` — given problem + solution, predict test outputs.
 * - `code_execution`      — given solution + input, predict output.
 */
export type LiveCodeBenchTask =
  | 'code_generation'
  | 'self_repair'
  | 'test_output_prediction'
  | 'code_execution';

/**
 * One LiveCodeBench problem (code_generation flavour).
 *
 * Mirrors the `livecodebench/code_generation_lite` HuggingFace dataset
 * row shape. The loader normalises into camelCase here.
 */
export interface LiveCodeBenchInstance {
  /** Stable cross-run identifier — `<contest>__<problem-id>` style. */
  readonly instanceId: string;
  /** Source platform: `'leetcode'`, `'atcoder'`, `'codeforces'`. */
  readonly platform: 'leetcode' | 'atcoder' | 'codeforces';
  /**
   * Difficulty bucket — LiveCodeBench standardises these across
   * platforms but each has its own native scale (LeetCode easy/medium/hard,
   * Codeforces ratings, etc.). Loader normalises into the three-bucket form.
   */
  readonly difficulty: 'easy' | 'medium' | 'hard';
  /** Natural-language problem statement. */
  readonly problemStatement: string;
  /**
   * Public sample I/O pairs surfaced in the prompt (so the model can
   * reason about the expected shape without reaching for the hidden tests).
   */
  readonly publicTests: ReadonlyArray<{
    readonly input: string;
    readonly expectedOutput: string;
  }>;
  /**
   * Optional starter code (LeetCode-style class skeleton). When present,
   * the model is expected to fill in the function body.
   */
  readonly starterCode?: string;
  /**
   * Date the problem was released — LiveCodeBench's headline contamination-
   * resistance claim is "evaluate on problems published *after* the model's
   * training cutoff". Loader carries it through so consumers can slice runs
   * by release window.
   */
  readonly releaseDate?: string;
}

/**
 * One model prediction for a LiveCodeBench problem.
 */
export interface LiveCodeBenchPrediction {
  readonly instanceId: string;
  /** The full Python solution the model emitted. */
  readonly code: string;
  readonly modelLabel: string;
  readonly durationMs: number;
}

/**
 * Verdict for one LiveCodeBench problem.
 *
 * v0.1 scope: `passed` reflects "did the model emit any extractable
 * Python code". v0.2 follow-up runs the hidden tests in a sandboxed
 * Python subprocess and turns that into the canonical pass/fail.
 */
export interface LiveCodeBenchEvalResult {
  readonly instanceId: string;
  readonly platform: LiveCodeBenchInstance['platform'];
  readonly difficulty: LiveCodeBenchInstance['difficulty'];
  /**
   * v0.1: passed = "did the model produce extractable Python code".
   * v0.2: passed = "did all public tests pass" when `runTests` is on.
   */
  readonly passed: boolean;
  readonly reason?: string;
  /** v0.2: count of public tests run. Undefined when tests skipped. */
  readonly testsRun?: number;
  /** v0.2: count of public tests that passed. */
  readonly testsPassed?: number;
  /** v0.2: truncated stderr from the failing test, for diagnosis. */
  readonly testStderr?: string;
  /** v0.2: true iff the Python toolchain wasn't installed. */
  readonly toolchainMissing?: boolean;
}

export interface LiveCodeBenchAdapterConfig {
  /**
   * Where to load instances from.
   *
   * - `'fixture'` (default): bundled four-problem smoke set
   * - `'huggingface'`: fetch from `livecodebench/code_generation_lite` default release slice
   * - `'huggingface:<config>'`: fetch a specific dataset release slice (e.g. `release_v3`)
   * - any other string: treat as an absolute path to a `.jsonl` file
   */
  readonly source?: 'fixture' | 'huggingface' | string;
  /** Filter the problem set to specific platforms. */
  readonly platforms?: ReadonlyArray<LiveCodeBenchInstance['platform']>;
  /** Filter by difficulty bucket. */
  readonly difficulties?: ReadonlyArray<LiveCodeBenchInstance['difficulty']>;
  /**
   * Filter to problems released after this ISO date — the standard way
   * to avoid training-data contamination on a given model.
   */
  readonly minReleaseDate?: string;
  /** v0.2 HuggingFace-fetch caching root. */
  readonly cacheDir?: string;
  /**
   * v0.2: actually run the model's emitted code against the public
   * tests via a sandboxed Python subprocess. Default: `true`.
   * Set to `false` for fast smoke runs without Python installed.
   */
  readonly runTests?: boolean;
  /** v0.2: per-test timeout. Default: 15_000ms. */
  readonly testTimeoutMs?: number;
}
