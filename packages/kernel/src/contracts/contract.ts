/**
 * Contract — the unit of work the Custodian preserves verbatim and the
 * Adjudicator evaluates against. Immutable after acceptance.
 */

import type { Budget, ContractId, SchemaRef } from "./common.js";
import type { ToolName } from "./tool.js";

export interface Contract {
  readonly id: ContractId;
  readonly goal: string;
  readonly acceptanceCriteria: readonly AcceptanceCriterion[];
  readonly inputs: readonly ContractInput[];
  readonly outputs: readonly ContractOutput[];
  readonly constraints: readonly Constraint[];
  /** Content hash of the canonical serialization. */
  readonly hash: string;
}

export type AcceptanceCriterion =
  | { readonly kind: "predicate"; readonly description: string; readonly testRef?: string }
  | { readonly kind: "schema"; readonly schema: SchemaRef }
  | { readonly kind: "human-checkpoint"; readonly description: string };

export interface ContractInput {
  readonly name: string;
  readonly schema: SchemaRef;
  readonly description?: string;
}

export interface ContractOutput {
  readonly name: string;
  readonly schema: SchemaRef;
  readonly description?: string;
}

export type Constraint =
  | { readonly kind: "budget"; readonly budget: Budget }
  | { readonly kind: "deadline"; readonly notAfter: number }
  | { readonly kind: "tools-allowed"; readonly tools: readonly ToolName[] }
  | { readonly kind: "tools-forbidden"; readonly tools: readonly ToolName[] }
  | { readonly kind: "policy"; readonly policyRef: string };
