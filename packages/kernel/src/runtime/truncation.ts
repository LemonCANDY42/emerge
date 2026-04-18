/**
 * Truncation-aware tool result helper.
 *
 * When a tool result's full content exceeds what was returned in `preview`,
 * the model should know there is more. Without an explicit notice, the model
 * may treat the truncated preview as the complete output — a silent data loss.
 *
 * This helper prepends a structured truncation notice to the preview and
 * ensures `sizeBytes` is set to the full size. The caller (agent-runner) applies
 * this before results enter working memory, before projections run.
 *
 * See ADR 0033.
 */

import type { ToolResult } from "../contracts/tool.js";

/**
 * Apply a truncation notice to a ToolResult when `fullSize > previewSize`.
 *
 * The notice is always prepended so it appears first in the model's context,
 * making it impossible to overlook. The format matches what ForgeCode found
 * most effective: explicit byte counts + a clear read-more call-to-action.
 */
export function applyTruncationNotice(
  result: ToolResult,
  fullSize: number,
  previewSize: number,
): ToolResult {
  if (fullSize <= previewSize) return result;

  const handleClause =
    result.handle !== undefined
      ? ` Call read_handle('${result.handle}') to read more.`
      : " A handle may be available — check the tool result metadata.";

  const notice = `[TRUNCATED: showing ${previewSize} of ${fullSize} bytes.${handleClause}]\n`;

  return {
    ...result,
    preview: notice + result.preview,
    sizeBytes: fullSize,
  };
}

/**
 * Infer whether a ToolResult has been truncated and apply the notice if needed.
 *
 * Used by the agent-runner for any result where `sizeBytes > preview.length`.
 * When `sizeBytes` is undefined, no notice is applied (tool did not report size).
 */
export function maybeApplyTruncationNotice(result: ToolResult): ToolResult {
  if (result.sizeBytes === undefined) return result;
  return applyTruncationNotice(result, result.sizeBytes, result.preview.length);
}
