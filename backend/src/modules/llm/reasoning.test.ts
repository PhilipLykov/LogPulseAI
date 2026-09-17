import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseReasoningEffort,
  isReasoningModel,
  shouldApplyReasoningEffort,
  buildChatCompletionBody,
  shouldRetryWithoutReasoningEffort,
  effectiveReasoningEffort,
} from './reasoning.js';

describe('parseReasoningEffort', () => {
  it('defaults unknown and empty values to auto', () => {
    assert.equal(parseReasoningEffort(undefined), 'auto');
    assert.equal(parseReasoningEffort(''), 'auto');
    assert.equal(parseReasoningEffort('default'), 'auto');
    assert.equal(parseReasoningEffort('bogus'), 'auto');
  });

  it('accepts documented effort values case-insensitively', () => {
    assert.equal(parseReasoningEffort('HIGH'), 'high');
    assert.equal(parseReasoningEffort(' none '), 'none');
    assert.equal(parseReasoningEffort('xhigh'), 'xhigh');
  });
});

describe('isReasoningModel', () => {
  it('detects GPT-5 / GPT-6 and o-series ids, including OpenRouter prefixes', () => {
    assert.equal(isReasoningModel('gpt-5'), true);
    assert.equal(isReasoningModel('gpt-5-mini'), true);
    assert.equal(isReasoningModel('gpt-5.2'), true);
    assert.equal(isReasoningModel('gpt-6-astra'), true);
    assert.equal(isReasoningModel('o3'), true);
    assert.equal(isReasoningModel('o3-mini'), true);
    assert.equal(isReasoningModel('o4-mini'), true);
    assert.equal(isReasoningModel('openai/o3'), true);
    assert.equal(isReasoningModel('openai/gpt-5-mini'), true);
  });

  it('rejects chat models that do not take reasoning_effort', () => {
    assert.equal(isReasoningModel('gpt-4o-mini'), false);
    assert.equal(isReasoningModel('gpt-4o'), false);
    assert.equal(isReasoningModel('gpt-4.1'), false);
    assert.equal(isReasoningModel('gpt-5-chat-latest'), false);
    assert.equal(isReasoningModel('gpt-5.1-chat-latest'), false);
    assert.equal(isReasoningModel(''), false);
  });
});

describe('buildChatCompletionBody', () => {
  const messages = [{ role: 'user', content: 'hi' }];

  it('omits reasoning_effort for auto and for non-reasoning models', () => {
    const autoBody = buildChatCompletionBody({
      model: 'gpt-5-mini',
      messages,
      reasoningEffort: 'auto',
      temperature: 0.1,
    });
    assert.equal(autoBody.reasoning_effort, undefined);
    assert.equal(autoBody.temperature, undefined);

    const chatBody = buildChatCompletionBody({
      model: 'gpt-4o-mini',
      messages,
      reasoningEffort: 'high',
      temperature: 0.1,
    });
    assert.equal(chatBody.reasoning_effort, undefined);
    assert.equal(chatBody.temperature, 0.1);
    assert.equal(shouldApplyReasoningEffort('gpt-4o-mini', 'high'), false);
  });

  it('sends reasoning_effort and uses max_completion_tokens on reasoning models', () => {
    const body = buildChatCompletionBody({
      model: 'o3',
      messages,
      reasoningEffort: 'high',
      temperature: 0.1,
      maxTokens: 500,
      responseFormat: { type: 'json_object' },
    });
    assert.equal(body.reasoning_effort, 'high');
    assert.equal(body.temperature, undefined);
    assert.equal(body.max_completion_tokens, 500);
    assert.equal(body.max_tokens, undefined);
    assert.deepEqual(body.response_format, { type: 'json_object' });
  });

  it('uses max_tokens on chat models', () => {
    const body = buildChatCompletionBody({
      model: 'gpt-4o-mini',
      messages,
      reasoningEffort: 'auto',
      maxTokens: 150,
    });
    assert.equal(body.max_tokens, 150);
    assert.equal(body.max_completion_tokens, undefined);
  });
});

describe('effectiveReasoningEffort', () => {
  it('inherits the global level when the task override is empty', () => {
    assert.equal(effectiveReasoningEffort('high', ''), 'high');
    assert.equal(effectiveReasoningEffort('high', 'inherit'), 'high');
    assert.equal(effectiveReasoningEffort('low', undefined), 'low');
  });

  it('lets a task pin auto even when the global level is high', () => {
    assert.equal(effectiveReasoningEffort('high', 'auto'), 'auto');
    assert.equal(effectiveReasoningEffort('auto', 'low'), 'low');
  });
});

describe('shouldRetryWithoutReasoningEffort', () => {
  it('retries only a 400 that names reasoning_effort while the field is present', () => {
    const body = { reasoning_effort: 'xhigh' };
    assert.equal(
      shouldRetryWithoutReasoningEffort(400, 'Unsupported value: reasoning_effort xhigh', body),
      true,
    );
    assert.equal(shouldRetryWithoutReasoningEffort(400, 'invalid model', body), false);
    assert.equal(shouldRetryWithoutReasoningEffort(401, 'reasoning_effort', body), false);
    assert.equal(
      shouldRetryWithoutReasoningEffort(400, 'reasoning_effort', { model: 'o3' }),
      false,
    );
  });
});
