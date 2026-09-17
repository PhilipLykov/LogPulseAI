import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeModelId,
  resolveModelPricing,
  estimateCost,
  parseTokenUsage,
} from './pricing.js';

describe('normalizeModelId', () => {
  it('strips OpenRouter prefixes and snapshot dates', () => {
    assert.equal(normalizeModelId('openai/gpt-5-mini-2025-08-07'), 'gpt-5-mini');
    assert.equal(normalizeModelId('GPT-5.4-mini'), 'gpt-5.4-mini');
  });
});

describe('resolveModelPricing', () => {
  it('prices exact catalog ids', () => {
    const mini = resolveModelPricing('gpt-5-mini');
    assert.equal(mini?.input, 0.25);
    assert.equal(mini?.output, 2.00);
  });

  it('prices prefixed and dated ids that previously stored null cost', () => {
    const dated = resolveModelPricing('openai/gpt-5-mini-2025-08-07');
    assert.equal(dated?.input, 0.25);
    const four = resolveModelPricing('gpt-5.4-mini');
    assert.equal(four?.input, 0.75);
    assert.equal(four?.output, 4.50);
  });

  it('prices gpt-5.6 as Sol and does not price Luna as Sol', () => {
    const alias = resolveModelPricing('gpt-5.6');
    const sol = resolveModelPricing('gpt-5.6-sol');
    const luna = resolveModelPricing('gpt-5.6-luna');
    const terra = resolveModelPricing('gpt-5.6-terra');
    assert.equal(alias?.input, 4.00);
    assert.equal(alias?.output, 20.00);
    assert.equal(sol?.input, 4.00);
    assert.equal(luna?.input, 0.20);
    assert.equal(terra?.input, 2.00);
    assert.notEqual(luna?.input, sol?.input);
  });

  it('does not price gpt-5.4 at gpt-5 rates', () => {
    const p54 = resolveModelPricing('gpt-5.4');
    const p5 = resolveModelPricing('gpt-5');
    assert.equal(p54?.input, 2.50);
    assert.equal(p5?.input, 1.25);
    assert.notEqual(p54?.input, p5?.input);
  });

  it('returns null for unknown ids', () => {
    assert.equal(resolveModelPricing('llama3.1:8b'), null);
    assert.equal(resolveModelPricing(''), null);
  });
});

describe('estimateCost', () => {
  it('uses USD per million tokens', () => {
    const cost = estimateCost(1_000_000, 1_000_000, 'gpt-5-mini');
    assert.equal(cost, 0.25 + 2.00);
  });

  it('applies cached input at the catalog cached rate', () => {
    const full = estimateCost(1_000_000, 0, 'gpt-5-mini', 0);
    const cached = estimateCost(1_000_000, 0, 'gpt-5-mini', 1_000_000);
    assert.equal(full, 0.25);
    assert.equal(cached, 0.025);
  });

  it('returns null when the model is not in the catalog', () => {
    assert.equal(estimateCost(100, 100, 'local-ollama'), null);
  });
});

describe('parseTokenUsage', () => {
  it('reads Chat Completions prompt_tokens and completion_tokens', () => {
    const u = parseTokenUsage({ prompt_tokens: 10, completion_tokens: 20 });
    assert.deepEqual(u, { tokenInput: 10, tokenOutput: 20, tokenCached: 0 });
  });

  it('reads Responses API input_tokens and output_tokens', () => {
    const u = parseTokenUsage({ input_tokens: 3, output_tokens: 4 });
    assert.equal(u.tokenInput, 3);
    assert.equal(u.tokenOutput, 4);
  });

  it('adds reasoning tokens when they exceed completion_tokens', () => {
    const u = parseTokenUsage({
      prompt_tokens: 8,
      completion_tokens: 2,
      completion_tokens_details: { reasoning_tokens: 40 },
    });
    assert.equal(u.tokenOutput, 42);
  });

  it('does not double-count OpenAI reasoning already inside completion_tokens', () => {
    const u = parseTokenUsage({
      prompt_tokens: 8,
      completion_tokens: 50,
      completion_tokens_details: { reasoning_tokens: 40 },
    });
    assert.equal(u.tokenOutput, 50);
  });

  it('reads cached input tokens', () => {
    const u = parseTokenUsage({
      prompt_tokens: 100,
      completion_tokens: 1,
      prompt_tokens_details: { cached_tokens: 80 },
    });
    assert.equal(u.tokenCached, 80);
  });
});
