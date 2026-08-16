import { describe, expect, it } from 'vitest';
import {
  BENCH_NUM_CTX,
  BENCH_PROMPTS,
  BENCH_SEED,
  BENCH_TEMPERATURE,
  deriveMetrics,
  detectBackend,
} from './ollama.js';

const NS = 1e9;

describe('deriveMetrics', () => {
  it('derives throughput from Ollama nanosecond timings', () => {
    const m = deriveMetrics({
      eval_count: 128,
      eval_duration: 2 * NS,
      prompt_eval_count: 1000,
      prompt_eval_duration: 0.5 * NS,
      load_duration: 0.1 * NS,
      total_duration: 2.7 * NS,
    });
    expect(m.evalTps).toBe(64); // 128 / 2s
    expect(m.promptTps).toBe(2000); // 1000 / 0.5s
    expect(m.ttftMs).toBe(600); // (0.1 + 0.5) * 1000
    expect(m.loadMs).toBe(100);
    expect(m.totalMs).toBe(2700);
    expect(m.promptCached).toBe(false);
  });

  /**
   * Regression: the real fleet produced 78,633 tok/s prompt throughput on a
   * GTX 1080 because the benchmark sends identical prompts three times and
   * Ollama served runs 2 and 3 from its KV cache — reporting the full token
   * count against a near-zero duration.
   */
  it('discards a cached prompt instead of reporting impossible throughput', () => {
    const m = deriveMetrics({
      eval_count: 128,
      eval_duration: 2 * NS,
      prompt_eval_count: 1443,
      prompt_eval_duration: 0.0000184 * NS, // ~18µs — a cache lookup
      load_duration: 0.55 * NS,
      total_duration: 2.7 * NS,
    });
    expect(m.promptCached).toBe(true);
    expect(m.promptTps).toBeUndefined();
    // TTFT measures a lookup here, not work a user would wait through.
    expect(m.ttftMs).toBeUndefined();
    // Generation throughput is unaffected by prompt caching and still counts.
    expect(m.evalTps).toBe(64);
    expect(m.promptTokens).toBe(1443);
  });

  it('keeps a genuinely fast host under the ceiling', () => {
    // ~20k tok/s prompt eval is plausible on high-end hardware and must survive.
    const m = deriveMetrics({
      prompt_eval_count: 20_000,
      prompt_eval_duration: 1 * NS,
      eval_count: 10,
      eval_duration: 1 * NS,
    });
    expect(m.promptCached).toBe(false);
    expect(m.promptTps).toBe(20_000);
  });

  it('is safe on a response with no timings', () => {
    const m = deriveMetrics({});
    expect(m.evalTps).toBeUndefined();
    expect(m.promptTps).toBeUndefined();
  });
});

describe('benchmark suite comparability (R-19)', () => {
  it('pins the parameters that make hosts comparable', () => {
    expect(BENCH_NUM_CTX).toBe(8192);
    expect(BENCH_TEMPERATURE).toBe(0);
    expect(typeof BENCH_SEED).toBe('number');
  });

  it('ships three fixed prompts spanning short to long context', () => {
    expect(BENCH_PROMPTS.map((p) => p.id)).toEqual(['short', 'medium', 'long']);
    const long = BENCH_PROMPTS.find((p) => p.id === 'long')!;
    // Long enough to actually exercise prompt ingestion — it measured 1443
    // tokens on the real fleet.
    expect(long.prompt.length).toBeGreaterThan(2000);
  });

  it('uses deterministic prompt content so runs are comparable across hosts', () => {
    // Regenerating the module must produce byte-identical prompts; anything
    // time- or random-derived would make the leaderboard meaningless.
    const long = BENCH_PROMPTS.find((p) => p.id === 'long')!;
    expect(long.prompt).toContain('host-0:');
    expect(long.prompt).toContain('host-59:');
    expect(long.prompt).not.toMatch(/\d{13}/); // no epoch timestamps
  });
});

describe('detectBackend', () => {
  it('does not treat missing Metal VRAM as CPU', async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ models: [{ size_vram: 0 }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })) as typeof fetch;
    try {
      await expect(
        detectBackend('http://127.0.0.1:11434', [{ model: 'Apple M4', backend: 'metal' }]),
      ).resolves.toBe('metal');
      await expect(
        detectBackend('http://127.0.0.1:11434', [{ model: 'RTX 3080', backend: 'cuda' }]),
      ).resolves.toBe('cpu');
    } finally {
      globalThis.fetch = original;
    }
  });
});
