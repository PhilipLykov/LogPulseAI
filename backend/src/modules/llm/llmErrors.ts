/**
 * Classify OpenAI-compatible provider errors so the pipeline can distinguish
 * billing/quota exhaustion from transient rate limits.
 *
 * Quota errors must not be retried immediately and must not be treated as
 * successful zero scores — otherwise events are marked scored and stay silent
 * after the operator refills the provider balance.
 */

export type LlmErrorKind =
  | 'quota'
  | 'rate_limit'
  | 'auth'
  | 'timeout'
  | 'transient'
  | 'unknown';

export class LlmRequestError extends Error {
  readonly kind: LlmErrorKind;
  readonly status?: number;
  readonly retryable: boolean;
  readonly userMessage: string;
  readonly providerMessage: string;

  constructor(opts: {
    kind: LlmErrorKind;
    message: string;
    userMessage: string;
    providerMessage?: string;
    status?: number;
    retryable: boolean;
  }) {
    super(opts.message);
    this.name = 'LlmRequestError';
    this.kind = opts.kind;
    this.status = opts.status;
    this.retryable = opts.retryable;
    this.userMessage = opts.userMessage;
    this.providerMessage = (opts.providerMessage ?? '').slice(0, 300);
  }
}

export function isLlmRequestError(err: unknown): err is LlmRequestError {
  return err instanceof LlmRequestError;
}

const QUOTA_CODE_RE = /\b(insufficient_quota|quota_exceeded|billing_not_active|billing_hard_limit|credit_balance|payment_required)\b/i;
const QUOTA_MSG_RE = /insufficient[_\s-]?quota|exceeded your current quota|quota.{0,40}(exceeded|exhausted)|insufficient funds|credit balance is too low|out of credits|billing.{0,20}(limit|quota)|please.{0,20}(add|top.?up|upgrade).{0,40}(credit|billing|plan)/i;
const RATE_CODE_RE = /\b(rate_limit_exceeded|rate_limit|too_many_requests)\b/i;
const RATE_MSG_RE = /rate limit|too many requests|tokens per min|requests per min|tpm|rpm/i;

const USER_MESSAGES: Record<LlmErrorKind, string> = {
  quota:
    'The AI provider reports that the account has no remaining credits or quota. Analysis is paused and will retry automatically after the balance is restored.',
  rate_limit:
    'The AI provider is rate-limiting requests. Analysis will retry shortly.',
  auth:
    'The AI provider rejected the API key. Update the key under Settings → AI Configuration.',
  timeout:
    'The AI provider did not respond in time. Analysis will retry on the next pipeline run.',
  transient:
    'The AI provider is temporarily unavailable. Analysis will retry on the next pipeline run.',
  unknown:
    'The AI provider returned an error. Check the backend logs and AI configuration.',
};

function extractProviderFields(body: string): { code: string; type: string; message: string } {
  const raw = (body ?? '').trim();
  let code = '';
  let type = '';
  let message = raw.slice(0, 400);
  if (!raw) return { code, type, message };
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const errObj = (parsed.error && typeof parsed.error === 'object')
      ? parsed.error as Record<string, unknown>
      : parsed;
    if (typeof errObj.code === 'string') code = errObj.code;
    if (typeof errObj.type === 'string') type = errObj.type;
    if (typeof errObj.message === 'string') message = errObj.message;
    else if (typeof parsed.detail === 'string') message = parsed.detail;
  } catch {
    /* plain-text body */
  }
  return { code, type, message };
}

/**
 * Map an HTTP status + provider body to a classified LLM error.
 * 429 is used both for rate limits and for quota exhaustion — the body decides.
 */
export function classifyLlmHttpError(status: number, body: string): LlmRequestError {
  const fields = extractProviderFields(body);
  const haystack = `${fields.code} ${fields.type} ${fields.message} ${body}`.slice(0, 2000);

  let kind: LlmErrorKind = 'unknown';
  let retryable = false;

  if (status === 401 || status === 403) {
    kind = 'auth';
  } else if (status === 402 || QUOTA_CODE_RE.test(haystack) || QUOTA_MSG_RE.test(haystack)) {
    kind = 'quota';
  } else if (status === 429) {
    if (RATE_CODE_RE.test(haystack) || RATE_MSG_RE.test(haystack)) {
      kind = 'rate_limit';
      retryable = true;
    } else {
      // Bare 429 with no quota markers: treat as rate limit (retry once).
      kind = 'rate_limit';
      retryable = true;
    }
  } else if (status === 408 || status === 425) {
    kind = 'timeout';
    retryable = true;
  } else if (status === 502 || status === 503 || status === 504) {
    kind = 'transient';
    retryable = true;
  }

  const userMessage = USER_MESSAGES[kind];
  const logMessage = `OpenAI API error ${status} (${kind}): ${fields.message || body}`.slice(0, 500);

  return new LlmRequestError({
    kind,
    message: logMessage,
    userMessage,
    providerMessage: fields.message || body,
    status,
    retryable,
  });
}

export function classifyLlmException(err: unknown): LlmRequestError {
  if (isLlmRequestError(err)) return err;
  const name = (err as { name?: string })?.name ?? '';
  const message = err instanceof Error ? err.message : String(err);
  if (name === 'AbortError' || /timed out/i.test(message)) {
    return new LlmRequestError({
      kind: 'timeout',
      message,
      userMessage: USER_MESSAGES.timeout,
      providerMessage: message,
      retryable: true,
    });
  }
  if (/fetch failed|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|network/i.test(message)) {
    return new LlmRequestError({
      kind: 'transient',
      message,
      userMessage: USER_MESSAGES.transient,
      providerMessage: message,
      retryable: true,
    });
  }
  const statusMatch = message.match(/OpenAI API error (\d{3})/i);
  if (statusMatch) {
    const status = Number(statusMatch[1]);
    const body = message.slice(message.indexOf(':') + 1).trim();
    return classifyLlmHttpError(status, body);
  }
  return new LlmRequestError({
    kind: 'unknown',
    message,
    userMessage: USER_MESSAGES.unknown,
    providerMessage: message,
    retryable: false,
  });
}

/** Quota and auth failures should pause the pipeline; rate limits should not. */
export function shouldPausePipeline(kind: LlmErrorKind): boolean {
  return kind === 'quota' || kind === 'auth';
}
