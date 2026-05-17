/**
 * Auto-consolidation — when memory hits capacity, trigger automatic
 * consolidation instead of returning an error.
 *
 * Uses pi.exec() to spawn a one-shot consolidation subprocess that
 * outputs a JSON consolidation plan. The parent applies the plan
 * deterministically — no tool round-trips, no approval dialogs,
 * no thinking overhead.
 *
 * Flow:
 *   1. Parent reads current entries and builds a prompt
 *   2. Subprocess (pi -p --no-tools --thinking off) outputs JSON plan
 *   3. Parent parses JSON and applies via store.replaceAll()
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { MemoryStore } from "../store/memory-store.js";
import { ENTRY_DELIMITER } from "../constants.js";
import type { ConsolidationResult } from "../types.js";

/**
 * Consolidation prompt used in the subprocess.
 * Tells the LLM to output a JSON plan — no tool calls.
 */
const CONSOLIDATION_PLAN_PROMPT = `You are consolidating a user profile's persistent memory entries.

All entries below belong to the same user. Entries about the same person's
preferences, tools, and workflows should be merged into a single entry even if they
cover different topics — the user asked for aggressive consolidation to free up space.

Example of aggressive merging (all about one person):
  "Testing philosophy: write real logic tests not mocks"
  "DTO design: use wither methods, keep readonly"
  "Uses cgrabenstein fork not chandra447"

Should become ONE entry:
  "Chris's preferences: tests exercise real logic, not mocks. DTOs: immutable with wither methods, no setters. Use cgrabenstein/pi-hermes-memory fork."

Output a single JSON object with this exact structure:
{
  "entries": [
    "first consolidated entry text",
    "second consolidated entry text"
  ]
}

The "entries" array is the COMPLETE new list of entries to keep.
- Merge related entries into one concise entry — be aggressive
- Remove redundant or superseded entries entirely
- Preserve user preferences and corrections (highest priority)
- Do NOT include HTML comments, metadata markers, or \u00a7 delimiters
- At least one entry must remain
- Output ONLY the JSON object, no markdown fences, no explanation`;

/**
 * Parse JSON from subprocess stdout, handling optional markdown fences.
 */
function parseConsolidationPlan(output: string): { entries: string[] } | null {
  // Strip markdown code fences if present
  let cleaned = output.trim();
  cleaned = cleaned.replace(/^```(?:json)?\s*\n?/i, "");
  cleaned = cleaned.replace(/\n?```\s*$/, "");
  cleaned = cleaned.trim();

  try {
    const parsed = JSON.parse(cleaned);
    if (
      parsed &&
      typeof parsed === "object" &&
      Array.isArray(parsed.entries) &&
      parsed.entries.every((e: unknown) => typeof e === "string")
    ) {
      return { entries: parsed.entries.map((e: string) => e.trim()).filter(Boolean) };
    }
    return null;
  } catch {
    return null;
  }
}

export async function triggerConsolidation(
  pi: ExtensionAPI,
  store: MemoryStore,
  target: "memory" | "user" | "failure",
  signal?: AbortSignal,
  timeoutMs: number = 60000,
): Promise<ConsolidationResult> {
  const entries =
    target === "memory" ? store.getMemoryEntries() : store.getUserEntries();

  if (entries.length === 0) {
    return { consolidated: true };
  }

  const currentContent = entries.join("\n\u00a7\n");

  const prompt = [
    CONSOLIDATION_PLAN_PROMPT,
    "",
    `--- Current ${target === "user" ? "User Profile" : "Memory"} Entries ---`,
    currentContent,
  ].join("\n");

  try {
    // No tools at all — the LLM just outputs JSON. No approval dialogs,
    // no tool round-trips, no thinking overhead.
    const result = await pi.exec("pi", ["-p", "--no-session", "--no-tools", "--thinking", "off", prompt], {
      signal,
      timeout: timeoutMs,
    });

    if (result.code !== 0) {
      return {
        consolidated: false,
        error: `Consolidation process exited with code ${result.code}: ${result.stderr?.slice(0, 200) || "unknown error"}`,
      };
    }

    const stdout = result.stdout || "";
    const plan = parseConsolidationPlan(stdout);

    if (!plan) {
      return {
        consolidated: false,
        error: `Could not parse consolidation plan from subprocess output. Output: ${stdout.slice(0, 300)}`,
      };
    }

    if (plan.entries.length === 0) {
      return {
        consolidated: false,
        error: "Consolidation plan returned empty entries array.",
      };
    }

    // Apply the plan atomically
    await store.replaceAll(target, plan.entries);
    return { consolidated: true };
  } catch (err) {
    return {
      consolidated: false,
      error: `Consolidation failed: ${String(err).slice(0, 200)}`,
    };
  }
}

/**
 * Register the /memory-consolidate command for manual consolidation.
 */
export function registerConsolidateCommand(
  pi: ExtensionAPI,
  store: MemoryStore,
  timeoutMs: number = 60000,
): void {
  pi.registerCommand("memory-consolidate", {
    description: "Manually trigger memory consolidation to free up space",
    handler: async (_args, ctx) => {
      const results: string[] = [];

      for (const target of ["memory", "user"] as const) {
        const entries =
          target === "memory"
            ? store.getMemoryEntries()
            : store.getUserEntries();

        if (entries.length === 0) {
          results.push(`${target}: (empty, nothing to consolidate)\n`);
          continue;
        }

        results.push(`${target}: ⏳ consolidating...`);
        ctx.ui.notify(
          `🔄 Consolidating ${target} entries… (timeout: ${timeoutMs / 1000}s)`,
          "info",
        );

        const result = await triggerConsolidation(pi, store, target, ctx.signal, timeoutMs);

        if (result.consolidated) {
          await store.loadFromDisk();
          results.push(`${target}: ✅ consolidated\n`);
          ctx.ui.notify(`✅ ${target} consolidation complete`, "info");
        } else {
          results.push(`${target}: ❌ ${result.error}\n`);
          ctx.ui.notify(`❌ ${target} consolidation failed: ${result.error}`, "error");
        }
      }

      ctx.ui.notify(
        `\n  🔄 Memory Consolidation\n  ${"─".repeat(30)}\n${results.map((r) => `  ${r}`).join("\n")}`,
        "info",
      );
    },
  });
}
