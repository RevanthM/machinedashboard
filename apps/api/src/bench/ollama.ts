/**
 * LLM benchmark harness (R-18 … R-22).
 *
 * Hits `/api/generate` with `stream:false` over whichever address is active and
 * derives the metrics from Ollama's own nanosecond timings, which are more
 * accurate than anything we could measure from outside the process.
 *
 * Comparability is the entire point of this module. A leaderboard is
 * meaningless if hosts ran different context sizes or sampled at different
 * temperatures, so `num_ctx`, `temperature` and `seed` are pinned on every call
 * (R-19) and recorded alongside the result. PRD §14 also warns that Ollama's
 * default 4K context silently truncates long prompts — pinning it explicitly is
 * what prevents a long-context run from measuring something other than what it
 * claims to.
 */
import type { GpuInfo } from '../db/schema.js';

/** Pinned so numbers are comparable across hosts (R-19). */
export const BENCH_NUM_CTX = 8192;
export const BENCH_TEMPERATURE = 0;
export const BENCH_SEED = 42;
export const RUNS_PER_PROMPT = 3;

export interface BenchPrompt {
  id: 'short' | 'medium' | 'long';
  prompt: string;
  numPredict: number;
}

/**
 * Three fixed prompts (PRD §F5). The long one exists specifically to exercise
 * prompt-eval throughput, which is what separates a GPU from a CPU far more
 * sharply than generation does.
 */
export const BENCH_PROMPTS: BenchPrompt[] = [
  {
    id: 'short',
    prompt: 'Reply with exactly the word: ready',
    numPredict: 16,
  },
  {
    id: 'medium',
    prompt:
      'Explain what a WireGuard mesh network is and why it removes the need for ' +
      'port forwarding. Answer in one paragraph.',
    numPredict: 192,
  },
  {
    id: 'long',
    // Deterministic filler: same tokens on every host, every run.
    prompt:
      'Summarise the following inventory in one sentence.\n\n' +
      Array.from(
        { length: 60 },
        (_, i) =>
          `host-${i}: cpu=generic-${i % 7} ram=${8 + (i % 5) * 8}GB gpu=${i % 3 === 0 ? 'none' : `accel-${i % 4}`} status=ok`,
      ).join('\n'),
    numPredict: 128,
  },
];

/** Ollama's /api/generate response, limited to the timing fields we use. */
interface GenerateResponse {
  model?: string;
  total_duration?: number;
  load_duration?: number;
  prompt_eval_count?: number;
  prompt_eval_duration?: number;
  eval_count?: number;
  eval_duration?: number;
}

export interface RunMetrics {
  promptTokens?: number;
  evalTokens?: number;
  /** eval_count / eval_duration — generation throughput. */
  evalTps?: number;
  /** prompt_eval_count / prompt_eval_duration — ingestion throughput. */
  promptTps?: number;
  /** load_duration + prompt_eval_duration — time until the first token. */
  ttftMs?: number;
  loadMs?: number;
  totalMs?: number;
  /** True when Ollama served this prompt from its KV cache. */
  promptCached?: boolean;
}

const NS_PER_MS = 1e6;
const NS_PER_S = 1e9;

/**
 * Above this, the "throughput" is not compute — it is a cache hit.
 *
 * Ollama reuses the KV cache when a prompt repeats, and still reports the full
 * `prompt_eval_count` alongside a near-zero `prompt_eval_duration`. Dividing
 * those yields absurdities: this fleet produced 78,633 tok/s on a GTX 1080,
 * which would be roughly 40x an H100. Since the benchmark deliberately sends
 * identical prompts three times (R-19 comparability), runs 2 and 3 hit the
 * cache every time — so a naive mean would be dominated by a fabricated number
 * and the leaderboard would rank hosts by how well they cache.
 *
 * The ceiling is set far above any real hardware so it only ever catches the
 * cache, never a genuinely fast host.
 */
const MAX_PLAUSIBLE_PROMPT_TPS = 50_000;

export function deriveMetrics(res: GenerateResponse): RunMetrics {
  const evalTps =
    res.eval_count && res.eval_duration ? res.eval_count / (res.eval_duration / NS_PER_S) : undefined;

  let promptTps =
    res.prompt_eval_count && res.prompt_eval_duration
      ? res.prompt_eval_count / (res.prompt_eval_duration / NS_PER_S)
      : undefined;

  const promptCached = promptTps !== undefined && promptTps > MAX_PLAUSIBLE_PROMPT_TPS;
  if (promptCached) promptTps = undefined;

  return {
    promptTokens: res.prompt_eval_count,
    evalTokens: res.eval_count,
    evalTps: round(evalTps),
    promptTps: round(promptTps),
    promptCached,
    // TTFT is likewise meaningless on a cached prompt — it measures a lookup,
    // not the work a user would actually wait through.
    ttftMs: promptCached
      ? undefined
      : round(((res.load_duration ?? 0) + (res.prompt_eval_duration ?? 0)) / NS_PER_MS),
    loadMs: round((res.load_duration ?? 0) / NS_PER_MS),
    totalMs: round((res.total_duration ?? 0) / NS_PER_MS),
  };
}

export interface BenchmarkOptions {
  baseUrl: string;
  model: string;
  /** Detected from specs; recorded so the leaderboard can group by it (R-20). */
  backend?: GpuInfo['backend'];
  runsPerPrompt?: number;
  timeoutMs?: number;
  onProgress?: (message: string) => void;
}

export interface BenchmarkResult {
  model: string;
  backend?: GpuInfo['backend'];
  numCtx: number;
  /** Median across runs — resistant to a single slow first-token outlier. */
  evalTps?: number;
  promptTps?: number;
  ttftMs?: number;
  loadMs?: number;
  totalMs?: number;
  promptTokens?: number;
  evalTokens?: number;
  perPrompt: Array<{ id: string; runs: RunMetrics[]; medianEvalTps?: number }>;
}

/**
 * Run the full suite: 3 prompts x N runs, reporting the median (PRD §F5).
 *
 * The first call also loads the model, so `load_duration` is large exactly
 * once. Medians rather than means keep that from dominating the headline
 * figure while still being visible in `loadMs`.
 */
export async function runBenchmark(opts: BenchmarkOptions): Promise<BenchmarkResult> {
  const runs = opts.runsPerPrompt ?? RUNS_PER_PROMPT;
  const perPrompt: BenchmarkResult['perPrompt'] = [];

  for (const prompt of BENCH_PROMPTS) {
    const collected: RunMetrics[] = [];
    for (let i = 0; i < runs; i++) {
      opts.onProgress?.(`${prompt.id} run ${i + 1}/${runs}`);
      collected.push(await generateOnce(opts, prompt));
    }
    perPrompt.push({
      id: prompt.id,
      runs: collected,
      medianEvalTps: median(collected.map((r) => r.evalTps)),
    });
  }

  const all = perPrompt.flatMap((p) => p.runs);
  return {
    model: opts.model,
    backend: opts.backend,
    numCtx: BENCH_NUM_CTX,
    evalTps: median(all.map((r) => r.evalTps)),
    promptTps: median(all.map((r) => r.promptTps)),
    ttftMs: median(all.map((r) => r.ttftMs)),
    loadMs: median(all.map((r) => r.loadMs)),
    totalMs: median(all.map((r) => r.totalMs)),
    promptTokens: median(all.map((r) => r.promptTokens)),
    evalTokens: median(all.map((r) => r.evalTokens)),
    perPrompt,
  };
}

async function generateOnce(
  opts: BenchmarkOptions,
  prompt: BenchPrompt,
): Promise<RunMetrics> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 180_000);

  try {
    const res = await fetch(`${opts.baseUrl}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        model: opts.model,
        prompt: prompt.prompt,
        stream: false,
        options: {
          num_ctx: BENCH_NUM_CTX,
          temperature: BENCH_TEMPERATURE,
          seed: BENCH_SEED,
          num_predict: prompt.numPredict,
        },
      }),
    });

    if (!res.ok) {
      throw new Error(`Ollama returned ${res.status} ${res.statusText}`);
    }
    return deriveMetrics((await res.json()) as GenerateResponse);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Which backend Ollama actually loaded the model onto (R-20).
 *
 * `ollama ps` reports the split — a model that spilled to CPU because VRAM was
 * short reports partial GPU, and reporting it as `cuda` would make a bad result
 * look like bad hardware rather than a too-large model.
 */
export async function detectBackend(
  baseUrl: string,
  gpu: GpuInfo[],
): Promise<GpuInfo['backend']> {
  try {
    const res = await fetch(`${baseUrl}/api/ps`, { signal: AbortSignal.timeout(10_000) });
    if (res.ok) {
      const body = (await res.json()) as { models?: Array<{ size_vram?: number }> };
      const loaded = body.models?.[0];
      if (loaded && (loaded.size_vram ?? 0) === 0) return 'cpu';
    }
  } catch {
    // Fall through to the GPU-based inference below.
  }
  return gpu[0]?.backend ?? 'cpu';
}

export async function isOllamaHealthy(baseUrl: string): Promise<boolean> {
  try {
    const res = await fetch(`${baseUrl}/api/tags`, { signal: AbortSignal.timeout(8_000) });
    return res.ok;
  } catch {
    return false;
  }
}

function median(values: Array<number | undefined>): number | undefined {
  const clean = values.filter((v): v is number => v !== undefined && Number.isFinite(v)).sort((a, b) => a - b);
  if (clean.length === 0) return undefined;
  const mid = Math.floor(clean.length / 2);
  const value = clean.length % 2 === 0 ? (clean[mid - 1]! + clean[mid]!) / 2 : clean[mid]!;
  return round(value);
}

function round(value?: number): number | undefined {
  return value === undefined || !Number.isFinite(value) ? undefined : Number(value.toFixed(2));
}
