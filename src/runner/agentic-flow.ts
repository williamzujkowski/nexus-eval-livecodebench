/**
 * Agentic-flow runner for LiveCodeBench problems (v0.3).
 *
 * Drives an `IAgenticAdapter` from `nexus-agents` with three tools:
 *
 *   - `read_problem()` — get the problem statement + public test I/O
 *   - `write_solution(code)` — overwrite the model's current solution
 *   - `run_tests()` — exercise the current solution via the v0.2 sandboxed
 *     Python runner (LeetCode-driver or stdio dispatch); return pass/fail
 *     + truncated stderr
 *
 * The agent loop iterates: write → test → see failure → re-write →
 * ... until pass or turn budget. Stops on AbortSignal.
 *
 * Shape mirrors nexus-eval-aider-polyglot's agentic-flow (#9). The
 * v0.3 RFC ([livecodebench#7](https://github.com/nexus-substrate/nexus-eval-livecodebench/issues/7))
 * called for hidden-test join + agentic flow as separate v0.3 pieces;
 * this PR ships the agentic flow against the public tests we already
 * surface in v0.2. Hidden-test join is the natural follow-up.
 *
 * @module runner/agentic-flow
 */

import {
  createAgenticAdapter,
  type AgentRunResult,
  type IModelAdapter,
  type AgenticToolCall as ToolCall,
  type AgenticToolResult as ToolResult,
} from 'nexus-agents';

import { runPython, type SpawnImpl, type PythonRunResult } from './python-runner.js';
import type { LiveCodeBenchInstance, LiveCodeBenchPrediction } from '../types.js';

export interface AgenticFlowResult {
  readonly prediction: LiveCodeBenchPrediction;
  readonly testResult: PythonRunResult | null;
  readonly agentRun: AgentRunResult;
}

export interface RunAgenticFlowOptions {
  readonly turnBudget?: number;
  readonly perTestTimeoutMs?: number;
  readonly spawnImpl?: SpawnImpl;
  readonly python?: string;
  readonly signal?: AbortSignal;
  readonly modelHints?: Parameters<typeof createAgenticAdapter>[1] extends infer Opts
    ? Opts extends { modelHints?: infer H }
      ? H
      : never
    : never;
}

const SYSTEM_PROMPT = `You are an expert competitive programmer working through a coding problem.

You have three tools:
  - read_problem(): get the problem statement, public sample I/O, and (when present) starter code
  - write_solution(code): set your current Python 3 solution
  - run_tests(): exercise the current solution against the public tests

Strategy:
  1. read_problem() to see what's asked.
  2. write_solution(<your Python>) to set an initial attempt.
  3. run_tests() and read stderr / stdout when failures happen.
  4. Iterate write_solution + run_tests until all tests pass.
  5. When all tests pass, stop emitting tool calls — say "done".

Rules:
  - Use only the Python 3 standard library — no third-party imports.
  - For LeetCode-style problems (starter code declares \`class Solution\`),
    fill in the class. For AtCoder/Codeforces-style, your code reads from
    stdin and writes to stdout.
  - Do not invent tools beyond the three above.
`;

const TOOLS = [
  {
    name: 'read_problem',
    description:
      'Fetch the problem statement, public test cases, and (optional) starter code. Returns a structured text dump.',
    inputSchema: { type: 'object' },
  },
  {
    name: 'write_solution',
    description:
      'Set your current Python 3 solution. Replaces any prior write_solution. Required before run_tests will work.',
    inputSchema: {
      type: 'object',
      properties: {
        code: { type: 'string', description: 'Full Python 3 source' },
      },
      required: ['code'],
    },
  },
  {
    name: 'run_tests',
    description:
      'Run the current solution against the public tests. Returns pass/fail + truncated stderr.',
    inputSchema: { type: 'object' },
  },
];

export async function runAgenticFlow(
  instance: LiveCodeBenchInstance,
  modelAdapter: IModelAdapter,
  options: RunAgenticFlowOptions = {}
): Promise<AgenticFlowResult> {
  const startedAt = Date.now();
  const state: FlowState = { code: '', lastTestResult: null };

  const agentic = createAgenticAdapter(modelAdapter, {
    ...(options.modelHints !== undefined && { modelHints: options.modelHints }),
  });

  const userPrompt = composeAgentPrompt(instance);
  const onToolCall = (call: ToolCall): Promise<ToolResult> =>
    handleToolCall(call, instance, state, options);

  const result = await agentic.runAgent({
    systemPrompt: SYSTEM_PROMPT,
    userPrompt,
    tools: TOOLS,
    ...(options.turnBudget !== undefined && { turnBudget: options.turnBudget }),
    onToolCall,
    ...(options.signal !== undefined && { signal: options.signal }),
  });

  if (!result.ok) {
    throw new Error(`AgenticAdapter failed: ${result.error.message}`);
  }
  const agentRun = result.value;

  return {
    prediction: {
      instanceId: instance.instanceId,
      code: state.code,
      modelLabel: modelAdapter.modelId,
      durationMs: Date.now() - startedAt,
    },
    testResult: state.lastTestResult,
    agentRun,
  };
}

interface FlowState {
  code: string;
  lastTestResult: PythonRunResult | null;
}

function composeAgentPrompt(instance: LiveCodeBenchInstance): string {
  return [
    `Problem: ${instance.instanceId}`,
    `Platform: ${instance.platform} (${instance.difficulty})`,
    '',
    'Use the tools to read the problem, write a Python solution, and iterate until tests pass.',
  ].join('\n');
}

async function handleToolCall(
  call: ToolCall,
  instance: LiveCodeBenchInstance,
  state: FlowState,
  options: RunAgenticFlowOptions
): Promise<ToolResult> {
  switch (call.name) {
    case 'read_problem':
      return handleReadProblem(instance);
    case 'write_solution':
      return handleWriteSolution(call.arguments, state);
    case 'run_tests':
      return handleRunTests(instance, state, options);
    default:
      return {
        content: `Unknown tool: ${call.name}. Use read_problem, write_solution, or run_tests.`,
        isError: true,
      };
  }
}

function handleReadProblem(instance: LiveCodeBenchInstance): ToolResult {
  const lines: string[] = [
    `Statement:`,
    instance.problemStatement,
    '',
    'Public tests:',
  ];
  instance.publicTests.forEach((t, i) => {
    lines.push(
      '',
      `Test ${String(i + 1)}:`,
      `  Input: ${JSON.stringify(t.input)}`,
      `  Expected output: ${JSON.stringify(t.expectedOutput)}`
    );
  });
  if (instance.starterCode !== undefined) {
    lines.push('', 'Starter code (LeetCode-style — fill in the class):', '```python', instance.starterCode, '```');
  }
  return { content: lines.join('\n') };
}

function handleWriteSolution(args: Record<string, unknown>, state: FlowState): ToolResult {
  const code = typeof args['code'] === 'string' ? args['code'] : '';
  if (code === '') return { content: 'write_solution: missing `code` argument', isError: true };
  state.code = code;
  return { content: `wrote ${String(code.length)} bytes; call run_tests() next` };
}

async function handleRunTests(
  instance: LiveCodeBenchInstance,
  state: FlowState,
  options: RunAgenticFlowOptions
): Promise<ToolResult> {
  if (state.code === '') {
    return { content: 'run_tests: no solution written yet — call write_solution first', isError: true };
  }
  const synthetic: LiveCodeBenchPrediction = {
    instanceId: instance.instanceId,
    code: state.code,
    modelLabel: 'agentic',
    durationMs: 0,
  };
  const result = await runPython(instance, synthetic, {
    ...(options.perTestTimeoutMs !== undefined && { perTestTimeoutMs: options.perTestTimeoutMs }),
    ...(options.spawnImpl !== undefined && { spawnImpl: options.spawnImpl }),
    ...(options.python !== undefined && { python: options.python }),
  });
  state.lastTestResult = result;
  if (result.passed) {
    return { content: `All ${String(result.testsRun)} public tests passed. Stop emitting tool calls.` };
  }
  return {
    content:
      `Tests failed: ${String(result.testsPassed)}/${String(result.testsRun)} passed.` +
      (result.timedOut ? ' (timed out)' : '') +
      (result.toolchainMissing ? ' (python3 not found in PATH)' : '') +
      `\n\nSTDERR:\n${result.stderr || '(empty)'}`,
    isError: true,
  };
}
