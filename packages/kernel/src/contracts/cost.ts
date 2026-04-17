/**
 * Cost as a first-class observable + budget dimension.
 *
 * Providers report per-call USD via `BudgetUsage.usd`. The kernel's cost
 * meter rolls these up per agent / topology / contract; pre-flight forecasts
 * surface estimates BEFORE expensive calls; cost-overshoot is one of the
 * signals `Surveillance.observe()` consumes (and may trigger decompose /
 * escalate recommendations).
 */

import type { AgentId, ContractId } from "./common.js";

export interface CostLedgerEntry {
  readonly at: number;
  readonly agent: AgentId;
  readonly contract?: ContractId;
  readonly category: "provider" | "tool" | "infra";
  readonly usd: number;
  readonly note?: string;
}

export interface CostLedger {
  readonly entries: readonly CostLedgerEntry[];
  readonly totals: {
    readonly byAgent: Readonly<Record<AgentId, number>>;
    readonly byContract: Readonly<Record<ContractId, number>>;
    readonly grand: number;
  };
}

export interface CostForecast {
  readonly p50: number;
  readonly p95: number;
  readonly basis: "experience" | "heuristic" | "provider-quote";
}

export interface CostMeter {
  record(entry: Omit<CostLedgerEntry, "at"> & { readonly at?: number }): void;
  ledger(): CostLedger;
  forecast(input: CostForecastInput): CostForecast;
}

export interface CostForecastInput {
  readonly agent: AgentId;
  readonly description: string;
  readonly tokenEstimateIn?: number;
  readonly tokenEstimateOut?: number;
}
