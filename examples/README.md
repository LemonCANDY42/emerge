# emerge examples

This directory contains runnable examples for the emerge agent harness.

## hello-agent

Demonstrates a mock-provider agent that reads a README file and writes a summary to NOTES.md.

## replay-smoke

Demonstrates session recording and record-replay reproducibility. Phase 1 records a session
with MockProvider; phase 2 replays it via RecordedProvider without re-invoking the model.

## types-smoke

Compile-time type safety checks for the emerge contracts.
