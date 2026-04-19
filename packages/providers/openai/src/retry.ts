/**
 * Retry helper for the OpenAI provider.
 *
 * Retry strategy:
 *   - Retries on HTTP 408, 425, 429, 500, 502, 503, 504 and on Node network
 *     errors (ECONNRESET, ETIMEDOUT, ECONNREFUSED, EAI_AGAIN).
 *   - Does NOT retry on deterministic 4xx errors (400, 401, 403, 404, 413,
 *     422, etc.) — those indicate a request-level mistake that retrying cannot
 *     fix.
 *   - Mid-stream errors (i.e. errors thrown after the stream iterator has
 *     already yielded events) are NOT retried — we cannot replay already-
 *     yielded events without duplicating them. Callers must restart entirely.
 *
 * Error detection logic:
 *   - `error.status`     — OpenAI SDK sets this to the HTTP status code on
 *                          APIStatusError subclasses.
 *   - `error.code`       — Node network errors (ECONNRESET, ETIMEDOUT, etc.)
 *                          set this on the native Error object.
 *   - Any Error whose message matches a known transient pattern is also
 *     considered retriable as a fallback.
 */

export interface RetryOptions {
  /** Total attempts including the first. Minimum 1. */
  readonly maxAttempts: number;
  /** Initial backoff delay in milliseconds. */
  readonly initialDelayMs: number;
  /** Maximum backoff delay cap in milliseconds. */
  readonly maxDelayMs: number;
  /** Whether to apply ±20% jitter to the delay. */
  readonly jitter: boolean;
}

export const DEFAULT_RETRY_OPTIONS: RetryOptions = {
  maxAttempts: 3,
  initialDelayMs: 500,
  maxDelayMs: 10_000,
  jitter: true,
};

/** HTTP status codes that warrant a retry. */
const RETRIABLE_STATUS_CODES = new Set([408, 425, 429, 500, 502, 503, 504]);

/** Node network error codes that warrant a retry. */
const RETRIABLE_NODE_CODES = new Set([
  "ECONNRESET",
  "ETIMEDOUT",
  "ECONNREFUSED",
  "EAI_AGAIN",
  "ENOTFOUND",
]);

/** Returns true if this error is transient and can be retried. */
export function isRetriable(err: unknown): boolean {
  if (!(err instanceof Error)) return false;

  // OpenAI SDK exposes HTTP status on .status
  const status = (err as { status?: unknown }).status;
  if (typeof status === "number" && RETRIABLE_STATUS_CODES.has(status)) return true;

  // Anthropic SDK exposes HTTP status on .statusCode
  const statusCode = (err as { statusCode?: unknown }).statusCode;
  if (typeof statusCode === "number" && RETRIABLE_STATUS_CODES.has(statusCode)) return true;

  // Node network error codes
  const code = (err as { code?: unknown }).code;
  if (typeof code === "string" && RETRIABLE_NODE_CODES.has(code)) return true;

  // Fallback: message heuristics for gateways that return plain errors
  const msg = err.message.toLowerCase();
  if (msg.includes("502") || msg.includes("503") || msg.includes("504")) return true;
  if (msg.includes("econnreset") || msg.includes("etimedout") || msg.includes("econnrefused")) {
    return true;
  }

  return false;
}

/**
 * Sleep for `ms` milliseconds. Injected via parameter so tests can replace it
 * with a fake (e.g. vi.useFakeTimers() or a no-op).
 */
export type SleepFn = (ms: number) => Promise<void>;

export const defaultSleep: SleepFn = (ms: number) =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Compute the next backoff delay with optional jitter.
 *
 * Formula: clamp(initialDelayMs * 2^(attempt-1), 0, maxDelayMs) * jitter_factor
 * where jitter_factor is uniform in [0.8, 1.2] when jitter=true, else 1.0.
 */
export function computeDelay(opts: RetryOptions, attempt: number): number {
  const base = Math.min(opts.initialDelayMs * 2 ** (attempt - 1), opts.maxDelayMs);
  if (!opts.jitter) return base;
  // ±20% jitter: multiply by a value in [0.8, 1.2]
  const jitterFactor = 0.8 + Math.random() * 0.4;
  return Math.round(base * jitterFactor);
}

/**
 * Execute `fn` with exponential backoff retry on transient errors.
 *
 * @param fn     The async operation to execute. Must be idempotent (safe to call multiple times).
 * @param opts   Retry configuration. Pass RetryOptions or `false` to disable.
 * @param kind   Label used in retry log messages.
 * @param sleep  Injectable sleep function (default: real setTimeout).
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: RetryOptions | false,
  kind: "openai" | "anthropic",
  sleep: SleepFn = defaultSleep,
): Promise<T> {
  if (opts === false) {
    return fn();
  }

  const maxAttempts = Math.max(1, opts.maxAttempts);

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err: unknown) {
      const isLast = attempt >= maxAttempts;

      if (isLast || !isRetriable(err)) {
        throw err;
      }

      const delayMs = computeDelay(opts, attempt);
      const status =
        (err as { status?: unknown }).status ??
        (err as { statusCode?: unknown }).statusCode ??
        (err as { code?: unknown }).code ??
        "unknown";
      const message = err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200);

      console.error(
        `[${kind}] retry ${attempt}/${maxAttempts - 1} after ${delayMs}ms status=${String(status)} err=${message}`,
      );

      await sleep(delayMs);
    }
  }

  // TypeScript exhaustiveness — unreachable but needed for the type system
  throw new Error(`[${kind}] retry loop exhausted without result or error`);
}
