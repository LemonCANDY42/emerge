/**
 * Human-in-the-loop — a primitive, not a tool.
 *
 * Bus envelope kinds `human.request` / `human.reply` / `human.timeout` are
 * declared in bus.ts. The host (CLI / web / IDE) maintains an approval
 * queue; modes `plan`, `accept-edit`, and `research` use this primitive.
 */

import type { CorrelationId, Result, SchemaRef } from "./common.js";

export interface HumanRequest {
  readonly correlationId: CorrelationId;
  readonly prompt: string;
  readonly options?: readonly string[];
  readonly schema?: SchemaRef;
  readonly timeoutMs?: number;
}

export type HumanResponse =
  | { readonly kind: "reply"; readonly correlationId: CorrelationId; readonly value: unknown }
  | { readonly kind: "timeout"; readonly correlationId: CorrelationId };

export interface ApprovalQueue {
  enqueue(req: HumanRequest): Promise<Result<HumanResponse>>;
  pending(): readonly HumanRequest[];
}
