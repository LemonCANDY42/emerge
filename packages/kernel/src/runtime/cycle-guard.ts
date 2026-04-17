/**
 * CycleGuard — sliding-window fingerprint detector for tool/provider call loops.
 */

import type { AgentId } from "../contracts/index.js";

interface CallRecord {
  fingerprint: string;
}

export class CycleGuard {
  private readonly windowSize: number;
  private readonly repeatThreshold: number;
  private readonly windows = new Map<AgentId, CallRecord[]>();

  constructor(windowSize: number, repeatThreshold: number) {
    this.windowSize = windowSize;
    this.repeatThreshold = repeatThreshold;
  }

  recordToolCall(
    agent: AgentId,
    toolName: string,
    normalizedArgs: string,
    resultHash: string,
  ): void {
    this.push(agent, `tool:${toolName}:${normalizedArgs}:${resultHash}`);
  }

  recordProviderCall(agent: AgentId, providerId: string, promptHash: string): void {
    this.push(agent, `provider:${providerId}:${promptHash}`);
  }

  shouldInterrupt(agent: AgentId): boolean {
    const window = this.windows.get(agent);
    if (!window || window.length < this.repeatThreshold) return false;

    const counts = new Map<string, number>();
    for (const r of window) {
      counts.set(r.fingerprint, (counts.get(r.fingerprint) ?? 0) + 1);
    }
    for (const count of counts.values()) {
      if (count >= this.repeatThreshold) return true;
    }
    return false;
  }

  reset(agent: AgentId): void {
    this.windows.delete(agent);
  }

  private push(agent: AgentId, fingerprint: string): void {
    let window = this.windows.get(agent);
    if (!window) {
      window = [];
      this.windows.set(agent, window);
    }
    window.push({ fingerprint });
    if (window.length > this.windowSize) {
      window.shift();
    }
  }
}
