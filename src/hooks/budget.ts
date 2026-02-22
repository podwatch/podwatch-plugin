/**
 * Budget hard stop hooks — before_model_resolve and before_prompt_build.
 *
 * When the server signals a hard stop (budget exceeded + hard stop enabled),
 * these hooks:
 * 1. Try to downgrade to a cheaper model (best-effort)
 * 2. Prepend context telling the LLM to inform the user about the budget limit
 */

import type { PodwatchConfig } from "../index.js";
import type { PluginApi } from "../types.js";
import { transmitter } from "../transmitter.js";

// ---------------------------------------------------------------------------
// Model cost heuristic — cheaper models first
// ---------------------------------------------------------------------------

/** Known cheap model patterns (ordered cheapest first). */
const CHEAP_MODEL_PATTERNS = [
  "haiku",
  "flash",
  "mini",
  "nano",
  "lite",
  "sonnet",
];

/**
 * Score a model name by cost (lower = cheaper).
 * Known cheap patterns get low scores, unknown models get a high default.
 */
function modelCostScore(modelName: string): number {
  const lower = modelName.toLowerCase();
  for (let i = 0; i < CHEAP_MODEL_PATTERNS.length; i++) {
    if (lower.includes(CHEAP_MODEL_PATTERNS[i]!)) return i;
  }
  return 100; // unknown = expensive
}

/**
 * Find the cheapest available model from the gateway config.
 * Returns { model, provider } or null if only one model is configured.
 */
export function findCheapestModel(
  config: Record<string, unknown>,
): { model: string; provider: string } | null {
  const candidates: { model: string; provider: string; score: number }[] = [];

  // Check models.providers for available models
  const providers = (config as any)?.models?.providers;
  if (providers && typeof providers === "object") {
    for (const [providerName, providerCfg] of Object.entries(providers)) {
      const cfg = providerCfg as Record<string, unknown>;
      const models = cfg.models as string[] | undefined;
      if (Array.isArray(models)) {
        for (const m of models) {
          if (typeof m === "string") {
            candidates.push({
              model: `${providerName}/${m}`,
              provider: providerName,
              score: modelCostScore(m),
            });
          }
        }
      }
    }
  }

  // Also check agents.defaults.models for configured model aliases
  const agentModels = (config as any)?.agents?.defaults?.models;
  if (agentModels && typeof agentModels === "object") {
    for (const modelId of Object.keys(agentModels)) {
      if (typeof modelId === "string") {
        const parts = modelId.split("/");
        const modelName = parts[parts.length - 1] ?? modelId;
        const provider = parts.length > 1 ? parts[0]! : "";
        candidates.push({
          model: modelId,
          provider,
          score: modelCostScore(modelName),
        });
      }
    }
  }

  // Deduplicate by model name
  const seen = new Set<string>();
  const unique = candidates.filter((c) => {
    if (seen.has(c.model)) return false;
    seen.add(c.model);
    return true;
  });

  if (unique.length <= 1) return null;

  // Sort by score (cheapest first) and pick the cheapest
  unique.sort((a, b) => a.score - b.score);

  // Get the current primary model to avoid returning the same one
  const primaryModel = (config as any)?.agents?.defaults?.model?.primary;
  const cheapest = unique.find((c) => c.model !== primaryModel) ?? unique[0]!;

  return { model: cheapest.model, provider: cheapest.provider };
}

// ---------------------------------------------------------------------------
// Hook registration
// ---------------------------------------------------------------------------

export function registerBudgetHooks(api: PluginApi, config: PodwatchConfig): void {
  // -----------------------------------------------------------------------
  // before_model_resolve — downgrade to cheaper model on hard stop
  // -----------------------------------------------------------------------
  api.registerHook(
    "before_model_resolve",
    async (): Promise<{ modelOverride?: string; providerOverride?: string } | void> => {
      if (!config.enableBudgetEnforcement) return;

      const budget = transmitter.getCachedBudget();
      if (!budget?.hardStopActive) return;

      const cheaper = findCheapestModel(api.config);
      if (!cheaper) return; // only one model configured, skip

      return {
        modelOverride: cheaper.model,
        providerOverride: cheaper.provider,
      };
    },
    { name: "podwatch-budget-model-resolve" },
  );

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
