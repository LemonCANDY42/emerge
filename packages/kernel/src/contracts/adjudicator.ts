/**
 * Compliance Adjudicator — kernel-aware role.
 *
 * Reads the `Contract` from the Custodian, evaluates outputs against
 * acceptance criteria, and issues `verdict` envelopes. Unless the session is
 * configured with `trustMode: "implicit"`, only an `aligned` verdict allows
 * the kernel to mark the session `completed`.
 */

import type { ArtifactHandle } from "./common.js";
import type { AcceptanceCriterion, Contract } from "./contract.js";

export interface Adjudicator {
  contract(): Contract;
  evaluate(input: EvaluationInput): Promise<Verdict>;
}

export interface EvaluationInput {
  readonly outputs: Readonly<Record<string, unknown>>;
  readonly artifacts: readonly ArtifactHandle[];
  /** Optional rationale from the producing agent. */
  readonly rationale?: string;
}

export type Verdict =
  | {
      readonly kind: "aligned";
      readonly rationale: string;
      readonly evidence: readonly ArtifactHandle[];
    }
  | {
      readonly kind: "partial";
      readonly missing: readonly AcceptanceCriterion[];
      readonly suggestion: string;
    }
  | { readonly kind: "off-track"; readonly reason: string; readonly suggestion: string }
  | { readonly kind: "failed"; readonly reason: string };
