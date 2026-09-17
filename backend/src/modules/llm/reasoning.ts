/**
 * Reasoning effort (reasoning level) for OpenAI-compatible chat completions.
 *
 * Reasoning models (GPT-5 / GPT-6 / o-series) spend hidden thinking tokens
 * before answering. Higher effort usually improves quality and increases
 * latency and cost. Chat models such as gpt-4o reject the parameter, so it
 * is omitted unless the model identifier looks like a reasoning model.
 */

export const REASONING_EFFORT_VALUES = [
  'auto',
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
] as const;

export type ReasoningEffortSetting = (typeof REASONING_EFFORT_VALUES)[number];

export const DEFAULT_REASONING_EFFORT: ReasoningEffortSetting = 'auto';

/** Operator-facing labels for Settings and API docs. */
export const REASONING_EFFORT_OPTIONS: Array<{
  value: ReasoningEffortSetting;
  label: string;
  hint: string;
}> = [
  { value: 'auto', label: 'Provider default', hint: 'Omit the parameter; the model uses its own default.' },
  { value: 'none', label: 'None', hint: 'No extra reasoning. Fastest. GPT-5.1 and newer.' },
  { value: 'minimal', label: 'Minimal', hint: 'Very little reasoning. Original GPT-5 family.' },
  { value: 'low', label: 'Low', hint: 'Light reasoning. Lower cost and latency.' },
  { value: 'medium', label: 'Medium', hint: 'Balanced quality and cost. Typical default on reasoning models.' },
  { value: 'high', label: 'High', hint: 'Deeper reasoning. Higher token use and latency.' },
  { value: 'xhigh', label: 'Extra high', hint: 'Very deep reasoning. Not supported on every model.' },
  { value: 'max', label: 'Maximum', hint: 'Highest effort the provider allows for the model.' },
];

export function isReasoningEffortSetting(value: unknown): value is ReasoningEffortSetting {
  return typeof value === 'string'
    && (REASONING_EFFORT_VALUES as readonly string[]).includes(value);
}

/**
 * Parse a stored or requested reasoning level.
 * Unknown values become auto so a stale config cannot break scoring.
 */
export function parseReasoningEffort(raw: unknown): ReasoningEffortSetting {
  if (typeof raw !== 'string') return DEFAULT_REASONING_EFFORT;
  const value = raw.trim().toLowerCase();
  if (value === '' || value === 'default') return DEFAULT_REASONING_EFFORT;
  if (isReasoningEffortSetting(value)) return value;
  return DEFAULT_REASONING_EFFORT;
}

/**
 * True when the model id is expected to accept reasoning_effort.
 * Strips OpenRouter-style prefixes (openai/o3 → o3).
 */
export function isReasoningModel(model: string): boolean {
  const name = model.trim().toLowerCase().replace(/^.*\//, '');
  if (!name) return false;
  // Non-reasoning chat variants in the GPT-5 family reject the parameter.
  if (/(^|[-.])chat($|[-.])/.test(name) && name.startsWith('gpt-5')) return false;
  if (name.startsWith('gpt-5') || name.startsWith('gpt-6')) return true;
  if (/^o[1-4]($|[-.])/.test(name)) return true;
  return false;
}

export function shouldApplyReasoningEffort(
  model: string,
  setting: ReasoningEffortSetting,
): boolean {
  return setting !== 'auto' && isReasoningModel(model);
}

/**
 * Per-task override: empty / inherit / global means "use the Settings default".
 * A concrete value (including auto) applies only to that task.
 */
export function parseTaskReasoningOverride(raw: unknown): '' | ReasoningEffortSetting {
  if (typeof raw !== 'string') return '';
  const value = raw.trim().toLowerCase();
  if (value === '' || value === 'inherit' || value === 'global') return '';
  if (isReasoningEffortSetting(value)) return value;
  return '';
}

export function effectiveReasoningEffort(
  global: ReasoningEffortSetting,
  taskOverride?: string | null,
): ReasoningEffortSetting {
  const override = parseTaskReasoningOverride(taskOverride);
  return override === '' ? global : override;
}

export interface ChatCompletionBodyOpts {
  model: string;
  messages: Array<{ role: string; content: string }>;
  reasoningEffort: ReasoningEffortSetting;
  /** Used only for non-reasoning models. Reasoning models reject sampling params. */
  temperature?: number;
  maxTokens?: number;
  responseFormat?: { type: 'json_object' };
}

/**
 * Build a chat/completions JSON body that is safe for both chat and reasoning models.
 */
export function buildChatCompletionBody(opts: ChatCompletionBodyOpts): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: opts.model,
    messages: opts.messages,
  };
  const reasoning = isReasoningModel(opts.model);

  if (shouldApplyReasoningEffort(opts.model, opts.reasoningEffort)) {
    body.reasoning_effort = opts.reasoningEffort;
  }

  if (!reasoning && typeof opts.temperature === 'number') {
    body.temperature = opts.temperature;
  }

  if (typeof opts.maxTokens === 'number' && opts.maxTokens > 0) {
    if (reasoning) body.max_completion_tokens = opts.maxTokens;
    else body.max_tokens = opts.maxTokens;
  }

  if (opts.responseFormat) {
    body.response_format = opts.responseFormat;
  }

  return body;
}

/** True when a 400 is caused by an unsupported reasoning_effort value or model. */
export function shouldRetryWithoutReasoningEffort(
  status: number,
  errorText: string,
  body: Record<string, unknown>,
): boolean {
  if (status !== 400) return false;
  if (!Object.prototype.hasOwnProperty.call(body, 'reasoning_effort')) return false;
  return /reasoning[_ ]effort/i.test(errorText);
}
