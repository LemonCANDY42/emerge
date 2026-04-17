/**
 * Common identifier and budget primitives shared across contracts.
 *
 * Branded types prevent accidental cross-domain mixing (e.g. AgentId vs TaskId).
 */

declare const brand: unique symbol;
type Brand<T, B> = T & { readonly [brand]: B };

export type AgentId = Brand<string, "AgentId">;
export type TaskId = Brand<string, "TaskId">;
export type SessionId = Brand<string, "SessionId">;
export type SpanId = Brand<string, "SpanId">;
export type ToolCallId = Brand<string, "ToolCallId">;
export type ContractId = Brand<string, "ContractId">;
export type BlueprintId = Brand<string, "BlueprintId">;
export type WorkspaceId = Brand<string, "WorkspaceId">;
export type ArtifactHandle = Brand<string, "ArtifactHandle">;
export type ExperienceId = Brand<string, "ExperienceId">;
export type BranchId = Brand<string, "BranchId">;
export type CorrelationId = Brand<string, "CorrelationId">;
export type TopicId = Brand<string, "TopicId">;

/**
 * Standard Schema-compatible reference. Lets users plug in Zod / Valibot /
 * ArkType / etc. without converting. Structurally compatible with
 * https://standardschema.dev v1.
 */
export interface StandardSchemaV1<Input = unknown, Output = Input> {
  readonly "~standard": {
    readonly version: 1;
    readonly vendor: string;
    readonly validate: (
      value: unknown,
    ) => StandardSchemaResult<Output> | Promise<StandardSchemaResult<Output>>;
    readonly types?: { readonly input: Input; readonly output: Output };
  };
}

export type StandardSchemaResult<T> =
  | { readonly value: T; readonly issues?: undefined }
  | {
      readonly issues: readonly {
        readonly message: string;
        readonly path?: readonly (string | number)[];
      }[];
    };

/** Contract boundaries accept any Standard-Schema-compatible spec. */
export type SchemaRef<I = unknown, O = I> = StandardSchemaV1<I, O>;

/**
 * W3C Trace Context (https://www.w3.org/TR/trace-context/) for OTel-compatible
 * cross-agent observability. Carried on bus envelopes and telemetry spans.
 */
export interface TraceContext {
  readonly traceparent: string;
  readonly tracestate?: string;
}

/**
 * A budget the kernel enforces. Negative or zero remaining values stop work.
 * All fields are optional; unset means unbounded for that dimension.
 */
export interface Budget {
  readonly tokensIn?: number;
  readonly tokensOut?: number;
  readonly wallMs?: number;
  readonly toolCalls?: number;
  /** Estimated USD cap. Providers report deltas. */
  readonly usd?: number;
}

export interface BudgetUsage {
  readonly tokensIn: number;
  readonly tokensOut: number;
  readonly wallMs: number;
  readonly toolCalls: number;
  readonly usd: number;
}

/**
 * Confidence is reported on [0, 1]. Surveillance and providers use the same scale.
 */
export type Confidence = number;

export interface Timestamped {
  readonly createdAt: number;
}

/**
 * A Result discriminated union. Used everywhere a contract method may fail
 * for reasons callers should distinguish from runtime errors.
 */
export type Result<T, E = ContractError> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E };

export interface ContractError {
  readonly code: string;
  readonly message: string;
  readonly cause?: unknown;
  readonly retriable?: boolean;
}
