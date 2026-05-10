/**
 * Sandboxed Python runner for LiveCodeBench (v0.2).
 *
 * Materialises the model's emitted Python solution into a tmpdir and
 * exercises it against the public tests bundled with the instance.
 * Pass = all public tests pass within timeout. Hidden tests (the
 * v0.2-loader's promised follow-up) drop in when the upstream
 * `private_test_cases` join lands.
 *
 * Two competitive-programming styles:
 *   - LeetCode-style: `class Solution: def methodName(self, ...)` —
 *     instantiate the class, call the method, compare the return value
 *     to the expected output (parse the upstream's `methodName(args)
 *     == result` test format).
 *   - AtCoder / Codeforces-style: read stdin, write stdout. Spawn
 *     python3 with the input on stdin and diff stdout against
 *     expected.
 *
 * Sandboxing matches nexus-eval-aider-polyglot's test-runner: tmpdir,
 * spawn (no shell), per-instance timeout via setTimeout + SIGKILL,
 * env scrubbed of secrets, stdout/stderr capped at 4 KB.
 *
 * @module runner/python-runner
 */

import { spawn as nodeSpawn } from 'node:child_process';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { LiveCodeBenchInstance, LiveCodeBenchPrediction } from '../types.js';

export type SpawnImpl = (
  command: string,
  args: readonly string[],
  options: SpawnOptions
) => ChildProcess;

export interface RunPythonOptions {
  /** Hard timeout for one test invocation. Default: 15s per test. */
  readonly perTestTimeoutMs?: number;
  /** Spawn injection point — tests inject without monkey-patching. */
  readonly spawnImpl?: SpawnImpl;
  /** Workspace dir override. Default: a fresh tmpdir created + deleted. */
  readonly workspaceDir?: string;
  /** Python binary. Default: `python3`. */
  readonly python?: string;
}

export interface PythonRunResult {
  readonly passed: boolean;
  readonly testsRun: number;
  readonly testsPassed: number;
  /** Truncated stderr from the failing test (if any). ≤ 4 KB. */
  readonly stderr: string;
  readonly toolchainMissing: boolean;
  readonly timedOut: boolean;
}

/**
 * Run the model's emitted Python solution against the instance's
 * public tests in a sandboxed subprocess.
 *
 * Never throws — failures come back via the `passed: false` path.
 */
export async function runPython(
  instance: LiveCodeBenchInstance,
  prediction: LiveCodeBenchPrediction,
  options: RunPythonOptions = {}
): Promise<PythonRunResult> {
  const perTestTimeoutMs = options.perTestTimeoutMs ?? 15_000;
  const spawnImpl = options.spawnImpl ?? nodeSpawn;
  const python = options.python ?? 'python3';

  const workspace =
    options.workspaceDir ?? mkdtempSync(join(tmpdir(), `livecodebench-${instance.platform}-`));

  try {
    if (prediction.code.length === 0) {
      return {
        passed: false,
        testsRun: 0,
        testsPassed: 0,
        stderr: 'no Python code emitted by model',
        toolchainMissing: false,
        timedOut: false,
      };
    }

    // 1. Write the model's solution + a runner script.
    const solutionPath = join(workspace, 'solution.py');
    writeFileSync(solutionPath, prediction.code, 'utf8');

    // 2. Decide LeetCode-vs-stdio shape from instance.starterCode.
    const isLeetCode =
      instance.starterCode !== undefined && /class\s+Solution/.test(instance.starterCode);

    let testsPassed = 0;
    let stderr = '';
    let timedOut = false;
    let toolchainMissing = false;
    const tests = instance.publicTests;
    for (const t of tests) {
      const result = isLeetCode
        ? await runLeetCodeTest(workspace, t, python, perTestTimeoutMs, spawnImpl)
        : await runStdioTest(workspace, t, python, perTestTimeoutMs, spawnImpl);
      if (result.toolchainMissing) {
        toolchainMissing = true;
        stderr = result.stderr;
        break;
      }
      if (result.timedOut) {
        timedOut = true;
        stderr = result.stderr;
        break;
      }
      if (result.passed) {
        testsPassed += 1;
      } else {
        stderr = result.stderr;
        break; // -x style: stop on first failure
      }
    }

    return {
      passed: testsPassed === tests.length && !timedOut && !toolchainMissing && tests.length > 0,
      testsRun: tests.length,
      testsPassed,
      stderr: stderr.slice(0, OUTPUT_CAP),
      toolchainMissing,
      timedOut,
    };
  } finally {
    if (options.workspaceDir === undefined) {
      rmSync(workspace, { recursive: true, force: true });
    }
  }
}

const OUTPUT_CAP = 4096;

interface SingleTestResult {
  readonly passed: boolean;
  readonly stderr: string;
  readonly toolchainMissing: boolean;
  readonly timedOut: boolean;
}

async function runStdioTest(
  workspace: string,
  test: { readonly input: string; readonly expectedOutput: string },
  python: string,
  timeoutMs: number,
  spawnImpl: SpawnImpl
): Promise<SingleTestResult> {
  return new Promise<SingleTestResult>((resolve) => {
    let child: ChildProcess;
    try {
      child = spawnImpl(python, ['-I', 'solution.py'], {
        cwd: workspace,
        env: scrubEnv(process.env),
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (e: unknown) {
      resolve({
        passed: false,
        stderr: e instanceof Error ? e.message : String(e),
        toolchainMissing: true,
        timedOut: false,
      });
      return;
    }

    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (c: Buffer | string) => {
      if (stdout.length < OUTPUT_CAP) stdout += String(c).slice(0, OUTPUT_CAP - stdout.length);
    });
    child.stderr?.on('data', (c: Buffer | string) => {
      if (stderr.length < OUTPUT_CAP) stderr += String(c).slice(0, OUTPUT_CAP - stderr.length);
    });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    timer.unref?.();

    let toolchainMissing = false;
    child.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') toolchainMissing = true;
      stderr += stderr.length === 0 ? err.message : `\n${err.message}`;
    });

    child.stdin?.write(test.input);
    child.stdin?.end();

    child.on('close', (exitCode: number | null) => {
      clearTimeout(timer);
      const expected = test.expectedOutput.replace(/\s+$/, '');
      const got = stdout.replace(/\s+$/, '');
      const passed = exitCode === 0 && got === expected;
      resolve({
        passed,
        stderr: passed ? '' : `Expected:\n${expected}\nGot (exit ${String(exitCode)}):\n${got}\n${stderr}`,
        toolchainMissing,
        timedOut,
      });
    });
  });
}

async function runLeetCodeTest(
  workspace: string,
  test: { readonly input: string; readonly expectedOutput: string },
  python: string,
  timeoutMs: number,
  spawnImpl: SpawnImpl
): Promise<SingleTestResult> {
  // LeetCode-style: tests look like
  //   `nums = [2,7,11,15], target = 9` -> `[0,1]`
  // We synthesise a small driver that imports Solution, instantiates,
  // evaluates the test expression, and compares.
  const driver = `import sys, json
from solution import Solution
sol = Solution()
${test.input}
import inspect
methods = [m for m in dir(sol) if not m.startswith('_') and callable(getattr(sol, m))]
if len(methods) != 1:
    sys.stderr.write(f"expected exactly one Solution method, got {methods}")
    sys.exit(2)
fn = getattr(sol, methods[0])
sig = inspect.signature(fn)
arg_names = list(sig.parameters.keys())
got = fn(*[eval(name) for name in arg_names])
expected = ${test.expectedOutput}
if got == expected:
    print("OK")
    sys.exit(0)
sys.stderr.write(f"got={got!r}, expected={expected!r}")
sys.exit(1)
`;
  const driverPath = join(workspace, '_driver.py');
  writeFileSync(driverPath, driver, 'utf8');

  return new Promise<SingleTestResult>((resolve) => {
    let child: ChildProcess;
    try {
      child = spawnImpl(python, ['-I', '_driver.py'], {
        cwd: workspace,
        env: scrubEnv(process.env),
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (e: unknown) {
      resolve({
        passed: false,
        stderr: e instanceof Error ? e.message : String(e),
        toolchainMissing: true,
        timedOut: false,
      });
      return;
    }

    let stderr = '';
    child.stderr?.on('data', (c: Buffer | string) => {
      if (stderr.length < OUTPUT_CAP) stderr += String(c).slice(0, OUTPUT_CAP - stderr.length);
    });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    timer.unref?.();

    let toolchainMissing = false;
    child.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') toolchainMissing = true;
      stderr += stderr.length === 0 ? err.message : `\n${err.message}`;
    });

    child.on('close', (exitCode: number | null) => {
      clearTimeout(timer);
      resolve({
        passed: exitCode === 0,
        stderr,
        toolchainMissing,
        timedOut,
      });
    });
  });
}

/**
 * Strip secrets from the env passed to the Python subprocess. Same set
 * as nexus-eval-aider-polyglot's test-runner.
 */
function scrubEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  const sensitivePrefixes = [
    'OPENAI_',
    'ANTHROPIC_',
    'GOOGLE_AI_',
    'OPENROUTER_',
    'NEXUS_',
    'GITHUB_TOKEN',
    'GH_TOKEN',
    'NPM_TOKEN',
    'HF_TOKEN',
    'AWS_',
  ];
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) continue;
    if (sensitivePrefixes.some((p) => k === p || k.startsWith(p))) continue;
    out[k] = v;
  }
  // Force unbuffered + don't write pyc.
  out['PYTHONDONTWRITEBYTECODE'] = '1';
  out['PYTHONUNBUFFERED'] = '1';
  return out;
}
