/**
 * Static pricing table for common OpenAI-compatible models.
 * Values: USD per 1 million tokens.
 *
 * OpenAI does not provide a public pricing API. If rates change, update
 * this file and redeploy. Historical llm_usage.cost_estimate rows stay
 * as stored; null rows are priced on read with the current table.
 *
 * Last verified: 2026-09-18 against developers.openai.com/api/docs/pricing
 * and the GPT-5.4 / GPT-5.4-mini / GPT-5 / GPT-4o-mini model pages.
 */

export interface ModelPricing {
  /** USD per 1M uncached input tokens. */
  input: number;
  /** USD per 1M output tokens (including billed reasoning tokens). */
  output: number;
  /** USD per 1M cached input tokens. Defaults to 10% of input when omitted. */
  cachedInput?: number;
}

export const MODEL_PRICING: Record<string, ModelPricing> = {
  // GPT-4o family
  'gpt-4o-mini':        { input: 0.15,  output: 0.60,  cachedInput: 0.075 },
  'gpt-4o':             { input: 2.50,  output: 10.00, cachedInput: 1.25 },
  // GPT-4.1 family
  'gpt-4.1-nano':       { input: 0.10,  output: 0.40 },
  'gpt-4.1-mini':       { input: 0.40,  output: 1.60 },
  'gpt-4.1':            { input: 2.00,  output: 8.00 },
  // GPT-5 family
  'gpt-5-nano':         { input: 0.05,  output: 0.40,  cachedInput: 0.005 },
  'gpt-5-mini':         { input: 0.25,  output: 2.00,  cachedInput: 0.025 },
  'gpt-5':              { input: 1.25,  output: 10.00, cachedInput: 0.125 },
  // GPT-5.1 family
  'gpt-5.1-codex-mini': { input: 0.25,  output: 2.00 },
  'gpt-5.1-codex':      { input: 1.25,  output: 10.00 },
  'gpt-5.1':            { input: 1.25,  output: 10.00 },
  // GPT-5.2 / 5.3
  'gpt-5.3-codex':      { input: 1.75,  output: 14.00, cachedInput: 0.175 },
  'gpt-5.3':            { input: 1.75,  output: 14.00, cachedInput: 0.175 },
  'gpt-5.2':            { input: 1.75,  output: 14.00, cachedInput: 0.175 },
  // GPT-5.4 family
  'gpt-5.4-mini':       { input: 0.75,  output: 4.50,  cachedInput: 0.075 },
  'gpt-5.4':            { input: 2.50,  output: 15.00, cachedInput: 0.25 },
  // GPT-5.5 / 5.6 / GPT-6 (standard short-context)
  'gpt-5.5':            { input: 5.00,  output: 30.00, cachedInput: 0.50 },
  'gpt-5.6-luna':       { input: 0.20,  output: 1.20,  cachedInput: 0.02 },
  'gpt-5.6-terra':      { input: 2.00,  output: 12.00, cachedInput: 0.20 },
  'gpt-5.6-sol':        { input: 4.00,  output: 20.00, cachedInput: 0.40 },
  'gpt-5.6-cyber':      { input: 12.50, output: 75.00, cachedInput: 1.25 },
  'gpt-6-astra':        { input: 10.00, output: 50.00, cachedInput: 1.00 },
  // Reasoning models
  'o1':                  { input: 15.00, output: 60.00 },
  'o3-mini':             { input: 1.10,  output: 4.40 },
  'o3-pro':              { input: 20.00, output: 80.00 },
  'o3':                  { input: 2.00,  output: 8.00,  cachedInput: 0.50 },
  'o4-mini':             { input: 1.10,  output: 4.40 },
  // Legacy
  'gpt-4-turbo':         { input: 10.00, output: 30.00 },
  'gpt-4':               { input: 30.00, output: 60.00 },
  'gpt-3.5-turbo':       { input: 0.50,  output: 1.50  },
};

const PRICING_KEYS_LONGEST_FIRST = Object.keys(MODEL_PRICING)
  .sort((a, b) => b.length - a.length);

/** Strip provider prefixes and snapshot dates so gpt-5-mini-2025-08-07 prices as gpt-5-mini. */
export function normalizeModelId(model: string): string {
  let name = model.trim().toLowerCase();
  const slash = name.lastIndexOf('/');
  if (slash >= 0) name = name.slice(slash + 1);
  name = name.replace(/:\w+$/, '');
  name = name.replace(/-\d{4}-\d{2}-\d{2}$/, '');
  name = name.replace(/-latest$/, '');
  return name;
}

/**
 * Resolve published rates for a model id. Exact match after normalization,
 * then the longest catalog key that is a hyphen-suffix parent
 * (gpt-5-mini-foo → gpt-5-mini, never gpt-5.4 → gpt-5).
 */
export function resolveModelPricing(model: string): ModelPricing | null {
  if (!model || !model.trim()) return null;
  const name = normalizeModelId(model);
  if (!name) return null;
  const exact = MODEL_PRICING[name];
  if (exact) return exact;
  for (const key of PRICING_KEYS_LONGEST_FIRST) {
    if (name === key || name.startsWith(`${key}-`)) return MODEL_PRICING[key];
  }
  return null;
}

export interface ParsedTokenUsage {
  tokenInput: number;
  tokenOutput: number;
  tokenCached: number;
}

/**
 * Read token counts from Chat Completions or Responses-style usage objects.
 * Output includes reasoning tokens when the provider reports them outside
 * completion_tokens. Cached input is reported separately for pricing.
 */
export function parseTokenUsage(raw: unknown): ParsedTokenUsage {
  if (!raw || typeof raw !== 'object') {
    return { tokenInput: 0, tokenOutput: 0, tokenCached: 0 };
  }
  const u = raw as Record<string, unknown>;
  const details = (key: string): Record<string, unknown> => {
    const v = u[key];
    return v && typeof v === 'object' ? v as Record<string, unknown> : {};
  };
  const promptDetails = details('prompt_tokens_details');
  const inputDetails = details('input_tokens_details');
  const completionDetails = details('completion_tokens_details');
  const outputDetails = details('output_tokens_details');

  const tokenInput = Number(u.prompt_tokens ?? u.input_tokens ?? 0) || 0;
  const completion = Number(u.completion_tokens ?? u.output_tokens ?? 0) || 0;
  const reasoning = Number(
    completionDetails.reasoning_tokens ?? outputDetails.reasoning_tokens ?? 0,
  ) || 0;
  const tokenCached = Number(
    promptDetails.cached_tokens ?? inputDetails.cached_tokens ?? 0,
  ) || 0;
  // OpenAI includes reasoning inside completion_tokens. Some proxies do not.
  const tokenOutput = reasoning > completion ? completion + reasoning : completion;
  return {
    tokenInput: Math.max(0, tokenInput),
    tokenOutput: Math.max(0, tokenOutput),
    tokenCached: Math.min(Math.max(0, tokenCached), Math.max(0, tokenInput)),
  };
}

/**
 * Estimate cost in USD. Returns null if the model id is not in the catalog.
 */
export function estimateCost(
  tokenInput: number | string,
  tokenOutput: number | string,
  model: string,
  tokenCached: number | string = 0,
): number | null {
  const pricing = resolveModelPricing(model);
  if (!pricing) return null;
  const input = Number(tokenInput) || 0;
  const output = Number(tokenOutput) || 0;
  const cached = Math.min(Math.max(0, Number(tokenCached) || 0), Math.max(0, input));
  const fresh = Math.max(0, input - cached);
  const cachedRate = pricing.cachedInput ?? pricing.input * 0.1;
  return (fresh * pricing.input + cached * cachedRate + output * pricing.output) / 1_000_000;
}
