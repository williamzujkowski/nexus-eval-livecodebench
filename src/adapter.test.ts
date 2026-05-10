/**
 * Smoke tests for LiveCodeBenchAdapter.
 *
 * Mocks IModelAdapter so tests don't make real model calls.
 */
import { describe, it, expect, vi } from 'vitest';
import { ok, runBenchmark, type IModelAdapter } from 'nexus-agents';
import { LiveCodeBenchAdapter } from './adapter.js';
import { extractPythonCode } from './runner/code-extractor.js';
import { composeUserPrompt, getSystemPrompt } from './runner/prompt-template.js';
import type { LiveCodeBenchInstance } from './types.js';

const fixtureInstance: LiveCodeBenchInstance = {
  instanceId: 'leetcode__two-sum',
  platform: 'leetcode',
  difficulty: 'easy',
  problemStatement: 'Return indices of two numbers that sum to target.',
  publicTests: [{ input: '[2,7,11,15], target=9', expectedOutput: '[0,1]' }],
  starterCode: 'class Solution:\n    def twoSum(self, nums, target): pass\n',
};

function makeMockModelAdapter(response: string): IModelAdapter {
  const completion = vi.fn(() => Promise.resolve(ok({ content: response })));
  return {
    providerId: 'mock',
    modelId: 'mock-livecodebench-model',
    capabilities: [],
    complete: completion as never,
    stream: (() => (async function* () {})()) as never,
    countTokens: () => Promise.resolve(0),
    validateConfig: () => ({ ok: true as const, value: undefined }),
  };
}

describe('LiveCodeBenchAdapter', () => {
  it('parses fenced python code from a model response', async () => {
    const code = 'class Solution:\n    def twoSum(self, nums, target):\n        return [0, 1]';
    const adapter = new LiveCodeBenchAdapter(
      makeMockModelAdapter('Reasoning...\n```python\n' + code + '\n```')
    );
    const prediction = await adapter.runInstance(fixtureInstance, {} as never);
    expect(prediction.code).toContain('def twoSum');
    expect(prediction.code).toContain('return [0, 1]');
  });

  it('captures empty code when model returns prose only', async () => {
    const adapter = new LiveCodeBenchAdapter(
      makeMockModelAdapter('I cannot solve this problem.')
    );
    const prediction = await adapter.runInstance(fixtureInstance, {} as never);
    expect(prediction.code).toBe('');
    const verdict = await adapter.evaluate(fixtureInstance, prediction);
    expect(verdict.passed).toBe(false);
    expect(adapter.isPass(verdict)).toBe(false);
  });

  it('isPass true when code is non-empty (with runTests off)', async () => {
    const adapter = new LiveCodeBenchAdapter(
      makeMockModelAdapter('```python\ndef f(): return 1\n```'),
      { runTests: false }
    );
    const prediction = await adapter.runInstance(fixtureInstance, {} as never);
    const verdict = await adapter.evaluate(fixtureInstance, prediction);
    expect(adapter.isPass(verdict)).toBe(true);
  });

  it('end-to-end against bundled fixture (4 problems, runTests off)', async () => {
    const response = '```python\nclass Solution:\n    pass\n```';
    const adapter = new LiveCodeBenchAdapter(makeMockModelAdapter(response), {
      source: 'fixture',
      runTests: false,
    });
    const summary = await runBenchmark(adapter, {});
    expect(summary.name).toBe('livecodebench');
    expect(summary.variant).toBe('code_generation');
    expect(summary.total).toBe(4);
    expect(summary.passed).toBe(4);
  });

  it('platform filter narrows the fixture set', async () => {
    const adapter = new LiveCodeBenchAdapter(makeMockModelAdapter(''), {
      source: 'fixture',
      platforms: ['leetcode'],
    });
    const instances = await adapter.loadInstances({});
    expect(instances.length).toBeGreaterThan(0);
    expect(instances.every((i) => i.platform === 'leetcode')).toBe(true);
  });

  it('difficulty filter narrows the fixture set', async () => {
    const adapter = new LiveCodeBenchAdapter(makeMockModelAdapter(''), {
      source: 'fixture',
      difficulties: ['easy'],
    });
    const instances = await adapter.loadInstances({});
    expect(instances.every((i) => i.difficulty === 'easy')).toBe(true);
  });

  it('minReleaseDate filter excludes pre-cutoff problems', async () => {
    const adapter = new LiveCodeBenchAdapter(makeMockModelAdapter(''), {
      source: 'fixture',
      minReleaseDate: '2024-01-01',
    });
    const instances = await adapter.loadInstances({});
    for (const i of instances) {
      if (i.releaseDate !== undefined) {
        expect(i.releaseDate >= '2024-01-01').toBe(true);
      }
    }
  });

  it('summarize includes byPlatform and byDifficulty', () => {
    const adapter = new LiveCodeBenchAdapter(makeMockModelAdapter(''));
    const verdicts = [
      { instanceId: 'a', platform: 'leetcode' as const, difficulty: 'easy' as const, passed: true },
      { instanceId: 'b', platform: 'leetcode' as const, difficulty: 'hard' as const, passed: false, reason: 'empty' },
      { instanceId: 'c', platform: 'codeforces' as const, difficulty: 'easy' as const, passed: true },
    ];
    const summary = adapter.summarize(verdicts, 200);
    const meta = summary.metadata as {
      byPlatform: Record<string, { total: number; passed: number; passRate: number }>;
      byDifficulty: Record<string, { total: number; passed: number; passRate: number }>;
    };
    expect(meta.byPlatform['leetcode']).toEqual({ total: 2, passed: 1, passRate: 0.5 });
    expect(meta.byPlatform['codeforces']).toEqual({ total: 1, passed: 1, passRate: 1 });
    expect(meta.byDifficulty['easy']).toEqual({ total: 2, passed: 2, passRate: 1 });
    expect(meta.byDifficulty['hard']).toEqual({ total: 1, passed: 0, passRate: 0 });
  });
});

describe('extractPythonCode', () => {
  it('returns the last python-tagged fence when multiple exist', () => {
    const response = '```python\nold\n```\nthen\n```python\nnew\n```';
    expect(extractPythonCode(response)).toBe('new');
  });

  it('falls back to last untagged fence', () => {
    const response = 'prose\n```\ncode\n```';
    expect(extractPythonCode(response)).toBe('code');
  });

  it('returns the whole response when it looks like raw python', () => {
    expect(extractPythonCode('def f():\n    return 1')).toBe('def f():\n    return 1');
  });

  it('returns empty for refusals / prose', () => {
    expect(extractPythonCode('I cannot solve this.')).toBe('');
  });

  it('handles import-only raw python', () => {
    expect(extractPythonCode('import sys\nprint(sys.argv)')).toBe('import sys\nprint(sys.argv)');
  });
});

describe('prompt template', () => {
  it('system prompt names Python 3 + stdlib + fenced format', () => {
    const sys = getSystemPrompt();
    expect(sys).toContain('Python 3');
    expect(sys).toContain('standard library');
    expect(sys).toContain('```python');
  });

  it('user prompt includes problem + public tests + starter when present', () => {
    const prompt = composeUserPrompt(fixtureInstance);
    expect(prompt).toContain('two-sum');
    expect(prompt).toContain('Return indices');
    expect(prompt).toContain('Test 1');
    expect(prompt).toContain('Starter code');
    expect(prompt).toContain('twoSum');
  });

  it('user prompt omits starter section when not provided', () => {
    const noStarter: LiveCodeBenchInstance = {
      ...fixtureInstance,
      starterCode: undefined,
    };
    const prompt = composeUserPrompt(noStarter);
    expect(prompt).not.toContain('Starter code');
  });
});
