/**
 * LiveApp — renders the dashboard in live mode.
 *
 * Receives TuiState from the parent (which is reading a JSONL file
 * or subscribing to the bus). The component itself is purely presentational.
 */

import { useApp, useInput } from "ink";
import type React from "react";
import type { TuiState } from "../state/types.js";
import { Dashboard } from "./Dashboard.js";

interface LiveAppProps {
  readonly state: TuiState;
  readonly onQuit?: () => void;
}

export function LiveApp({ state, onQuit }: LiveAppProps): React.ReactElement {
  const { exit } = useApp();

  useInput((input) => {
    if (input === "q") {
      onQuit?.();
      exit();
    }
  });

  return <Dashboard state={state} mode="live" />;
}
