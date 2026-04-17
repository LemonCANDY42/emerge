/**
 * InMemoryCostMeter — rolls up CostLedgerEntries; provides heuristic forecast.
 */

import type {
  AgentId,
  ContractId,
  CostForecast,
  CostForecastInput,
  CostLedger,
  CostLedgerEntry,
  CostMeter,
} from "../contracts/index.js";

export class InMemoryCostMeter implements CostMeter {
  private readonly entries: CostLedgerEntry[] = [];

  record(entry: Omit<CostLedgerEntry, "at"> & { readonly at?: number }): void {
    this.entries.push({ ...entry, at: entry.at ?? Date.now() } as CostLedgerEntry);
  }

  ledger(): CostLedger {
    const byAgent: Record<string, number> = {};
    const byContract: Record<string, number> = {};
    let grand = 0;

    for (const e of this.entries) {
      byAgent[e.agent] = (byAgent[e.agent] ?? 0) + e.usd;
      if (e.contract) {
        byContract[e.contract] = (byContract[e.contract] ?? 0) + e.usd;
      }
      grand += e.usd;
    }

    return {
      entries: [...this.entries],
      totals: {
        byAgent: byAgent as Readonly<Record<AgentId, number>>,
        byContract: byContract as Readonly<Record<ContractId, number>>,
        grand,
      },
    };
  }

  forecast(input: CostForecastInput): CostForecast {
    // Heuristic: use $0.015/Mtok in + $0.075/Mtok out (rough Opus 4 pricing)
    const tokIn = input.tokenEstimateIn ?? 0;
    const tokOut = input.tokenEstimateOut ?? 0;
    const baseUsd = (tokIn * 0.015 + tokOut * 0.075) / 1_000_000;

    // p50 = 1.5x, p95 = 3x
    return {
      p50: baseUsd * 1.5,
      p95: baseUsd * 3,
      basis: "heuristic",
    };
  }
}
