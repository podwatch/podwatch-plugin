/**
 * Budget hard stop hooks — before_prompt_build + before_tool_call.
 *
 * When the server signals a hard stop (budget exceeded + hard stop enabled),
 * these hooks:
 * 1. Prepend context telling the LLM to inform the user about the budget limit
 * 2. Block all tool calls (via before_tool_call in security.ts)
 *
 * No model downgrade — we can't know what providers the user has configured,
 * so forcing a "cheaper" model would break setups with a single provider.
 */

import type { PodwatchConfig } from "../index.js";
import type { PluginApi } from "../types.js";
import { transmitter } from "../transmitter.js";

// ---------------------------------------------------------------------------
// Hook registration
// ---------------------------------------------------------------------------

export function registerBudgetHooks(api: PluginApi, config: PodwatchConfig): void {
  // -----------------------------------------------------------------------
  // before_prompt_build — inject budget warning into prompt
  // -----------------------------------------------------------------------
  api.registerHook(
    "before_prompt_build",
    async (): Promise<{ prependContext?: string } | void> => {
      if (!config.enableBudgetEnforcement) return;

      const budget = transmitter.getCachedBudget();
      if (!budget?.hardStopActive) return;

      return {
        prependContext:
          "BUDGET HARD STOP ACTIVE. Your spending limit has been reached. " +
          "Reply ONLY with a brief message telling the user their budget is exceeded " +
          "and to visit podwatch.app/costs to resume. Do not use any tools. Do not perform any analysis.",
      };
    },
    { name: "podwatch-budget-prompt-build" },
  );

  api.logger.info("[podwatch/budget] Hard stop hooks registered");
}
