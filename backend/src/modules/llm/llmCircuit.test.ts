import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  isLlmPaused,
  ZERO_SCORE_WINDOW_SUMMARY,
  POISON_REPAIR_LOOKBACK_DAYS,
  POISON_REPAIR_BATCH_SIZE,
  type LlmProviderHealth,
} from './llmCircuit.js';

const HEALTH_OK: LlmProviderHealth = {
  state: 'ok',
  reason: null,
  message: '',
  pause_until: null,
  last_error_at: null,
  consecutive_failures: 0,
  recovered_at: null,
};

describe('isLlmPaused', () => {
  it('is not paused when health is ok', () => {
    assert.equal(isLlmPaused(HEALTH_OK, Date.parse('2026-09-17T12:00:00Z')), false);
  });

  it('is paused while pause_until is in the future', () => {
    const health: LlmProviderHealth = {
      ...HEALTH_OK,
      state: 'paused',
      reason: 'quota',
      pause_until: '2026-09-17T12:10:00Z',
    };
    assert.equal(isLlmPaused(health, Date.parse('2026-09-17T12:00:00Z')), true);
  });

  it('is not paused after pause_until', () => {
    const health: LlmProviderHealth = {
      ...HEALTH_OK,
      state: 'paused',
      reason: 'quota',
      pause_until: '2026-09-17T11:00:00Z',
    };
    assert.equal(isLlmPaused(health, Date.parse('2026-09-17T12:00:00Z')), false);
  });
});

describe('quota poison recovery v2 constants', () => {
  it('uses the skip_zero_score_meta routine summary so poisoned windows can be found', () => {
    assert.match(ZERO_SCORE_WINDOW_SUMMARY, /scored as routine/);
  });

  it('repairs a 7-day lookback matching the dashboard score window', () => {
    assert.equal(POISON_REPAIR_LOOKBACK_DAYS, 7);
  });

  it('updates events in small batches so startup can bind HTTP first', () => {
    assert.equal(POISON_REPAIR_BATCH_SIZE, 2000);
    assert.ok(POISON_REPAIR_BATCH_SIZE < 50_000);
  });
});
