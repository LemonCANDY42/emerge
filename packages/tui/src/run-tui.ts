/**
 * runTui — in-process TUI entry point.
 *
 * The host kernel passes its bus (and optionally a recorder). This function
 * subscribes to the bus using the `self` subscription target (which receives
 * all envelopes routed to the subscriber). Since the bus doesn't have a
 * "subscribe to everything" wildcard, we subscribe as a named agent
 * "tui-observer" using the `from` pattern — but since we can't enumerate
 * all senders, we instead use a different approach:
 *
 * Per the bus contract (bus.ts), SubscriptionTarget has three shapes:
 *   { kind: "from"; sender: AgentId }   — envelopes from a specific sender
 *   { kind: "topic"; topic: TopicId }   — envelopes on a topic
 *   { kind: "self" }                    — envelopes addressed to self
 *
 * There is NO "all" subscription in the contract. The correct approach is
 * to subscribe to the bus with `{ kind: "self" }` as "tui-observer" and
 * have senders address the observer, OR to wrap the bus send() method.
 *
 * For M3d Phase 1, we wrap the recorder's record() method to intercept
 * events — the recorder is the single path all events flow through.
 * When only a bus is available (no recorder), we emit a warning.
 *
 * In practice, callers should pass a recorder created via makeRecorder()
 * from @lwrf42/emerge-replay so events flow through to the TUI.
 */

import type { JsonlEvent } from "@lwrf42/emerge-kernel/contracts";
import type { Bus } from "@lwrf42/emerge-kernel/contracts";
import { render } from "ink";
import React from "react";
import { LiveApp } from "./components/LiveApp.js";
import { applyEvent } from "./state/reducer.js";
import { EMPTY_STATE, type TuiState } from "./state/types.js";

export interface RunTuiOptions {
  /** The kernel's bus. Used for future direct subscription (M3d Phase 2). */
  readonly bus?: Bus;
  /**
   * A SessionRecorder-compatible shim. When provided, the TUI intercepts
   * record() calls to receive events. Wrap makeRecorder() output with
   * makeTuiRecorder() from this module before passing to the kernel.
   */
  readonly eventSource?: TuiEventSource;
}

/**
 * A live event source the TUI subscribes to.
 * Implement this to bridge any event source to the TUI.
 */
export interface TuiEventSource {
  subscribe(listener: (event: JsonlEvent) => void): { unsubscribe(): void };
}

/**
 * Create a TuiEventSource backed by a push channel.
 * Returns the source and a `push` function to send events into it.
 */
export function makeTuiEventSource(): {
  source: TuiEventSource;
  push: (event: JsonlEvent) => void;
} {
  const listeners = new Set<(event: JsonlEvent) => void>();

  function push(event: JsonlEvent): void {
    for (const listener of listeners) {
      listener(event);
    }
  }

  const source: TuiEventSource = {
    subscribe(listener) {
      listeners.add(listener);
      return {
        unsubscribe() {
          listeners.delete(listener);
        },
      };
    },
  };

  return { source, push };
}

/**
 * Run the TUI in-process. Returns a promise that resolves when the user
 * quits (presses `q`) or when `stop()` is called on the returned handle.
 */
export function runTui(opts: RunTuiOptions = {}): {
  waitUntilExit: Promise<void>;
  stop: () => void;
} {
  let currentState: TuiState = EMPTY_STATE;
  let rerender: ((state: TuiState) => void) | undefined;

  function onEvent(event: JsonlEvent): void {
    currentState = applyEvent(currentState, event);
    rerender?.(currentState);
  }

  // Subscribe to event source if provided
  let unsub: (() => void) | undefined;
  if (opts.eventSource) {
    const sub = opts.eventSource.subscribe(onEvent);
    unsub = () => sub.unsubscribe();
  } else {
    process.stderr.write(
      "[tui] runTui: no eventSource provided; TUI will show static empty state.\n" +
        "      Pass a TuiEventSource (see makeTuiEventSource) to receive live events.\n",
    );
  }

  // We use a controlled state approach: the component is re-rendered via
  // a ref to a state setter. Ink's render() returns a { rerender, unmount } handle.
  const stateSnapshot = currentState;
  const StateWrapper = (): React.ReactElement => {
    const [state, setState] = React.useState<TuiState>(stateSnapshot);

    // Register the rerender callback on first mount
    React.useEffect(() => {
      rerender = (s: TuiState) => setState(s);
      return () => {
        rerender = undefined;
      };
    }, []);

    return React.createElement(LiveApp, { state });
  };

  const instance = render(React.createElement(StateWrapper));

  return {
    waitUntilExit: instance.waitUntilExit(),
    stop() {
      unsub?.();
      instance.unmount();
    },
  };
}
