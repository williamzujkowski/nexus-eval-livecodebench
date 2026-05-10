/**
 * Library entry point — public exports of the LiveCodeBench harness.
 *
 * @module index
 */

export { LiveCodeBenchAdapter } from './adapter.js';
export type {
  LiveCodeBenchAdapterConfig,
  LiveCodeBenchEvalResult,
  LiveCodeBenchInstance,
  LiveCodeBenchPrediction,
  LiveCodeBenchTask,
} from './types.js';

// Lower-level building blocks for piecemeal consumption.
export { loadLiveCodeBenchInstances } from './runner/instance-loader.js';
export { generatePrediction } from './runner/agent-invoker.js';
export type { GeneratePredictionOptions } from './runner/agent-invoker.js';
export { extractPythonCode } from './runner/code-extractor.js';
export { composeUserPrompt, getSystemPrompt } from './runner/prompt-template.js';
export {
  loadFromHuggingFace,
  DEFAULT_HF_DATASET,
  DEFAULT_HF_CONFIG,
  DEFAULT_HF_SPLIT,
} from './runner/hf-loader.js';
export type { LoadFromHuggingFaceOptions } from './runner/hf-loader.js';
export { runPython } from './runner/python-runner.js';
export type { RunPythonOptions, PythonRunResult, SpawnImpl } from './runner/python-runner.js';
