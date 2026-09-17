import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyLlmException,
  classifyLlmHttpError,
  isLlmRequestError,
  shouldPausePipeline,
} from './llmErrors.js';

describe('classifyLlmHttpError', () => {
  it('treats OpenAI insufficient_quota 429 as quota, not retryable', () => {
    const body = JSON.stringify({
      error: {
        message: 'You exceeded your current quota, please check your plan and billing details.',
        type: 'insufficient_quota',
        param: null,
        code: 'insufficient_quota',
      },
    });
    const err = classifyLlmHttpError(429, body);
    assert.equal(err.kind, 'quota');
    assert.equal(err.retryable, false);
    assert.equal(shouldPausePipeline(err.kind), true);
    assert.match(err.userMessage, /credits or quota/i);
  });

  it('treats HTTP 402 as quota', () => {
    const err = classifyLlmHttpError(402, '{"error":{"message":"Payment required"}}');
    assert.equal(err.kind, 'quota');
    assert.equal(err.retryable, false);
  });

  it('treats rate_limit_exceeded 429 as retryable rate limit', () => {
    const body = JSON.stringify({
      error: {
        message: 'Rate limit reached for tokens per min (TPM)',
        type: 'tokens',
        code: 'rate_limit_exceeded',
      },
    });
    const err = classifyLlmHttpError(429, body);
    assert.equal(err.kind, 'rate_limit');
    assert.equal(err.retryable, true);
    assert.equal(shouldPausePipeline(err.kind), false);
  });

  it('treats bare 429 without quota wording as rate limit', () => {
    const err = classifyLlmHttpError(429, 'Too Many Requests');
    assert.equal(err.kind, 'rate_limit');
    assert.equal(err.retryable, true);
  });

  it('classifies 401 as auth and not retryable', () => {
    const err = classifyLlmHttpError(401, '{"error":{"message":"Incorrect API key provided"}}');
    assert.equal(err.kind, 'auth');
    assert.equal(err.retryable, false);
    assert.equal(shouldPausePipeline(err.kind), true);
  });

  it('classifies 503 as transient and retryable', () => {
    const err = classifyLlmHttpError(503, 'Service Unavailable');
    assert.equal(err.kind, 'transient');
    assert.equal(err.retryable, true);
  });

  it('detects quota wording even when the code field is missing', () => {
    const err = classifyLlmHttpError(429, 'You exceeded your current quota. Please add credits.');
    assert.equal(err.kind, 'quota');
    assert.equal(err.retryable, false);
  });
});

describe('classifyLlmException', () => {
  it('passes through LlmRequestError', () => {
    const original = classifyLlmHttpError(429, '{"error":{"code":"insufficient_quota"}}');
    const again = classifyLlmException(original);
    assert.equal(again, original);
    assert.equal(isLlmRequestError(again), true);
  });

  it('classifies AbortError as timeout', () => {
    const abort = new Error('The operation was aborted');
    abort.name = 'AbortError';
    const err = classifyLlmException(abort);
    assert.equal(err.kind, 'timeout');
    assert.equal(err.retryable, true);
  });

  it('classifies fetch/network failures as retryable transient errors', () => {
    const err = classifyLlmException(new Error('fetch failed'));
    assert.equal(err.kind, 'transient');
    assert.equal(err.retryable, true);
  });

  it('parses thrown OpenAI API error strings from the adapter', () => {
    const wrapped = new Error('OpenAI API error 429: {"error":{"code":"insufficient_quota","message":"quota"}}');
    const err = classifyLlmException(wrapped);
    assert.equal(err.kind, 'quota');
    assert.equal(err.retryable, false);
  });
});
