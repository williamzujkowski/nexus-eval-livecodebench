/**
 * Tests for the sandboxed Python runner. Mocks spawn via spawnImpl.
 */
import { EventEmitter } from 'node:events';
import { describe, it, expect, vi } from 'vitest';

import { runPython, type SpawnImpl } from './python-runner.js';
import type { LiveCodeBenchInstance, LiveCodeBenchPrediction } from '../types.js';

interface MockChildOptions {
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  delayMs?: number;
  errorCode?: string;
}

function makeMockChild(opts: MockChildOptions = {}) {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    stdin: { write: (s: string) => void; end: () => void };
    kill: (sig: string) => boolean;
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = { write: () => undefined, end: () => undefined };
  child.kill = vi.fn(() => true);

  const fire = (): void => {
    if (opts.stdout !== undefined) child.stdout.emit('data', opts.stdout);
    if (opts.stderr !== undefined) child.stderr.emit('data', opts.stderr);
    if (opts.errorCode !== undefined) {
      const err = new Error('spawn failed') as NodeJS.ErrnoException;
      err.code = opts.errorCode;
      child.emit('error', err);
    }
    child.emit('close', opts.exitCode ?? 0, null);
  };
  if (opts.delayMs !== undefined) setTimeout(fire, opts.delayMs);
  else queueMicrotask(fire);
  return child;
}

const stdioInstance: LiveCodeBenchInstance = {
  instanceId: 'cf-1',
  platform: 'codeforces',
  difficulty: 'easy',
  problemStatement: 'Echo input.',
  publicTests: [
    { input: '5\n', expectedOutput: '5' },
    { input: '7\n', expectedOutput: '7' },
  ],
};

const leetcodeInstance: LiveCodeBenchInstance = {
  instanceId: 'lc-1',
  platform: 'leetcode',
  difficulty: 'easy',
  problemStatement: 'Two-sum.',
  publicTests: [{ input: 'nums = [1, 2]\ntarget = 3', expectedOutput: '[0, 1]' }],
  starterCode: 'class Solution:\n    def twoSum(self, nums, target): pass\n',
};

const goodPrediction: LiveCodeBenchPrediction = {
  instanceId: 'cf-1',
  code: 'print(input())',
  modelLabel: 'mock',
  durationMs: 10,
};

const emptyPrediction: LiveCodeBenchPrediction = {
  instanceId: 'cf-1',
  code: '',
  modelLabel: 'mock',
  durationMs: 10,
};

describe('runPython', () => {
  it('reports passed when stdio output matches all expected outputs', async () => {
    let callCount = 0;
    const spawnImpl: SpawnImpl = vi.fn(() => {
      callCount += 1;
      const expected = callCount === 1 ? '5' : '7';
      return makeMockChild({ exitCode: 0, stdout: expected }) as unknown as ReturnType<SpawnImpl>;
    });
    const result = await runPython(stdioInstance, goodPrediction, { spawnImpl });
    expect(result.passed).toBe(true);
    expect(result.testsPassed).toBe(2);
    expect(result.testsRun).toBe(2);
  });

  it('reports failure on first test mismatch (-x semantics)', async () => {
    let callCount = 0;
    const spawnImpl: SpawnImpl = vi.fn(() => {
      callCount += 1;
      // First test gets the wrong answer; second never runs.
      return makeMockChild({ exitCode: 0, stdout: 'wrong' }) as unknown as ReturnType<SpawnImpl>;
    });
    const result = await runPython(stdioInstance, goodPrediction, { spawnImpl });
    expect(result.passed).toBe(false);
    expect(result.testsPassed).toBe(0);
    expect(callCount).toBe(1); // stopped after first failure
    expect(result.stderr).toContain('Expected');
  });

  it('reports toolchainMissing on ENOENT', async () => {
    const spawnImpl = vi.fn(() =>
      makeMockChild({ errorCode: 'ENOENT', exitCode: null }) as unknown as ReturnType<SpawnImpl>
    );
    const result = await runPython(stdioInstance, goodPrediction, { spawnImpl });
    expect(result.toolchainMissing).toBe(true);
    expect(result.passed).toBe(false);
  });

  it('returns "no Python code emitted" when prediction is empty', async () => {
    const spawnImpl = vi.fn(() =>
      makeMockChild({ exitCode: 0 }) as unknown as ReturnType<SpawnImpl>
    );
    const result = await runPython(stdioInstance, emptyPrediction, { spawnImpl });
    expect(result.passed).toBe(false);
    expect(result.testsRun).toBe(0);
    expect(result.stderr).toContain('no Python code');
    expect(spawnImpl).not.toHaveBeenCalled();
  });

  it('reports timedOut when subprocess exceeds perTestTimeoutMs', async () => {
    const spawnImpl = vi.fn(() =>
      makeMockChild({ exitCode: null, delayMs: 200 }) as unknown as ReturnType<SpawnImpl>
    );
    const result = await runPython(stdioInstance, goodPrediction, {
      spawnImpl,
      perTestTimeoutMs: 50,
    });
    expect(result.timedOut).toBe(true);
    expect(result.passed).toBe(false);
  });

  it('uses LeetCode driver when starterCode declares `class Solution`', async () => {
    let capturedArgs: readonly string[] | undefined;
    const spawnImpl: SpawnImpl = vi.fn((_cmd, args) => {
      capturedArgs = args;
      return makeMockChild({ exitCode: 0, stdout: 'OK' }) as unknown as ReturnType<SpawnImpl>;
    });
    await runPython(
      leetcodeInstance,
      { ...goodPrediction, code: 'class Solution:\n    def twoSum(self,nums,target): return [0,1]\n' },
      { spawnImpl }
    );
    // _driver.py is the LeetCode driver path.
    expect(capturedArgs).toEqual(['-I', '_driver.py']);
  });

  it('scrubs sensitive env vars from the subprocess', async () => {
    const before = {
      OPENAI_API_KEY: process.env['OPENAI_API_KEY'],
      NEXUS_LOG_LEVEL: process.env['NEXUS_LOG_LEVEL'],
      HF_TOKEN: process.env['HF_TOKEN'],
    };
    process.env['OPENAI_API_KEY'] = 'sk-secret';
    process.env['NEXUS_LOG_LEVEL'] = 'debug';
    process.env['HF_TOKEN'] = 'hf-secret';
    try {
      let capturedEnv: NodeJS.ProcessEnv | undefined;
      const spawnImpl: SpawnImpl = vi.fn((_cmd, _args, options) => {
        capturedEnv = options.env as NodeJS.ProcessEnv | undefined;
        return makeMockChild({ exitCode: 0, stdout: '5' }) as unknown as ReturnType<SpawnImpl>;
      });
      await runPython(stdioInstance, goodPrediction, { spawnImpl });
      expect(capturedEnv?.['OPENAI_API_KEY']).toBeUndefined();
      expect(capturedEnv?.['NEXUS_LOG_LEVEL']).toBeUndefined();
      expect(capturedEnv?.['HF_TOKEN']).toBeUndefined();
      expect(capturedEnv?.['PYTHONDONTWRITEBYTECODE']).toBe('1');
    } finally {
      for (const [k, v] of Object.entries(before)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });

  it('uses python override when supplied', async () => {
    let capturedCmd: string | undefined;
    const spawnImpl: SpawnImpl = vi.fn((cmd) => {
      capturedCmd = cmd;
      return makeMockChild({ exitCode: 0, stdout: '5' }) as unknown as ReturnType<SpawnImpl>;
    });
    await runPython(stdioInstance, goodPrediction, { spawnImpl, python: '/opt/py3/bin/python' });
    expect(capturedCmd).toBe('/opt/py3/bin/python');
  });
});
