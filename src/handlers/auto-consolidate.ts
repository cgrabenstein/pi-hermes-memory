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
 * Build a target-specific consolidation prompt.
 * Each target (memory/user/failure) has different rules reflecting a different philosophy.
 * The LLM outputs a JSON plan — no tool calls.
 */
function buildConsolidationPrompt(target: "memory" | "user" | "failure"): string {
  const philosophy = `## Goal of memory management
Memory exists to prevent the agent from repeating mistakes and to align its behavior to the user's preferences without being told every session. Every entry should answer: "Will this save the user from having to repeat themselves?"

The threshold for keeping: "Would a good agent rediscover this on their own?" If yes → drop. If no → keep.

Memory is context, not instruction — it informs behavior but doesn't override the user's current request or the project's current state.

Failures and corrections are the most valuable because they represent actual friction. Tool quirks are valuable if genuinely non-obvious — behavior that would waste time again.

The goal is a curated set that fits the token budget while covering the high-signal knowledge.`;

  const targetRules: Record<string, string> = {
    memory: `## Target: MEMORY (MEMORY.md) — "Know your terrain"
Purpose: Help the agent navigate the user's environment without bumping into walls.

### Keep
- Non-obvious tool behavior with concrete commands, flags, and error messages
- Environment-specific setup facts (OS, package manager quirks, paths)
- Verified facts about how things work in this specific setup
- Actionable gotchas — "X behaves this way, fix with Y flag"

### Merge
- Related entries about the same topic into one dense paragraph
- Preserve separate technical points as separate sentences — don't collapse distinct gotchas into one vague sentence
- Example of good merge: three entries about pi subprocess issues → one entry with "Key gotchas: (1) thinking inheritance, (2) approval dialog blocking, (3) --no-session doesn't suppress lifecycle events"

### Drop
- Derivable facts: file paths, architecture decisions, dependency choices (agent can read the repo)
- Session outcomes: "we fixed X today" — ephemeral
- Low-confidence observations: things you weren't sure about when saved
- Version-specific numbers that will date — the agent can check the current version

### What "stale" means here
Entries the agent could rediscover by reading the project, running a command, or checking git history. Time alone is not the criterion — a timeless tool quirk about pi-core behavior stays forever. A session outcome from yesterday goes.`,

    user: `## Target: USER (USER.md) — "Know the person"
Purpose: Align the agent to the user's expectations without being told every session.

### Keep — EVERYTHING
All preferences, all standing instructions, all behavior corrections. Nothing gets dropped from USER.md under any circumstances.

### Merge
- Related preferences into topic clusters. E.g. bug "Testing: real logic, not mocks. DTOs: immutable with wither methods. Fork: use cgrabenstein."
- Tight prose covering all preferences with minimal redundancy
- Preserve every distinct preference — merging into a paragraph is fine, but don't omit any

### Drop — NOTHING
Nothing qualifies as stale in USER.md. Every preference is permanently relevant.`,

    failure: `## Target: FAILURE (failures.md) — "Don't repeat mistakes"
Purpose: Encode the friction history so the agent genuinely learns.

### Keep
- All unique entries. Preserve category labels: [correction], [insight], [tool-quirk], [failure], [preference], [convention]
- Both the "what went wrong" and "what to do instead" parts of corrections
- A correction stays even if it seems old — corrections about agent behavior are permanently relevant

### Deduplicate (this is the main operation for failures)
- **Exact duplicates**: same text repeated → keep one
- **Near-identical duplicates**: same fact stated 3+ times with different wording → keep the single most complete version, drop the rest
- **Superseded entries**: a later, more complete entry about the same fact makes an earlier attempt redundant

Example of good dedup:
  Entry 1: "The --no-session flag does NOT suppress lifecycle events. session_start still fires."
  Entry 2: "I incorrectly assumed pi --no-session prevents session_start from firing. It doesn't."
  Entry 3: "--no-session doesn't prevent session_start lifecycle event."
  → Keep ONE: the most complete version (Entry 1), drop the other two.

### Drop
- Placeholder/sentinel entries ("placeholder", "check failures", "cleanup sentinel")
- Entries that are just noise with no actionable content

### Do NOT do
- Do NOT merge distinct corrections about different topics into one blob
- Do NOT remove the category label brackets (e.g. [correction], [insight])
- Do NOT preserve multiple versions of the same fact just because they're worded differently — keep the best one

### What "stale" means here
Placeholder/sentinel entries, or a less-complete entry superseded by a better version of the same fact. Age alone does not make a unique correction stale — the 7-day prompt-injection window is separate from the durable record.`
  };

  const formatInstructions = `## Output format
Output a single JSON object with this exact structure:
{
  "entries": [
    "first consolidated entry text",
    "second consolidated entry text"
  ]
}

The "entries" array is the COMPLETE new list of entries to keep — no extra items, no missing items.
- Do NOT include HTML comments, metadata markers, or \u00a7 delimiters in the entry text
- At least one entry must remain
- Output ONLY the JSON object, no markdown fences, no explanation text`;

  return [
    philosophy,
    targetRules[target],
    formatInstructions,
  ].join("\n\n");
}

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
    target === "memory" ? store.getMemoryEntries() :
    target === "failure" ? store.getFailureEntries(365 * 10) :
    store.getUserEntries();

  if (entries.length === 0) {
    return { consolidated: true };
  }

  const currentContent = entries.join("\n\u00a7\n");

  const label = target === "user" ? "User Profile (USER.md)" : target === "failure" ? "Failures (failures.md)" : "Memory (MEMORY.md)";

  const prompt = [
    buildConsolidationPrompt(target),
    "",
    `--- Current ${label} Entries ---`,
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

    // Safety guard: reject suspiciously empty or truncated plans
    const originalTotal = currentContent.length;
    const planTotal = plan.entries.join("\n\u00a7\n").length;

    // Trivially small plan (< 20 chars) is almost certainly an LLM hiccup
    if (planTotal < 20) {
      return {
        consolidated: false,
        error: `Consolidation plan produces only ${planTotal} chars (original was ${originalTotal}). Rejected — too small to be valid.`,
      };
    }

    // User profile should be roughly preserved — reject >50% shrinkage
    if (target === "user" && planTotal < originalTotal * 0.5) {
      return {
        consolidated: false,
        error: `Plan reduces user profile from ${originalTotal} chars to ${planTotal} chars (${Math.round((1 - planTotal / originalTotal) * 100)}% reduction). Rejected — user preferences should be preserved.`,
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

      for (const target of ["memory", "user", "failure"] as const) {
        let entries: string[];
        if (target === "memory") {
          entries = store.getMemoryEntries();
        } else if (target === "failure") {
          entries = store.getFailureEntries(365 * 10); // Get all entries (10 year window)
        } else {
          entries = store.getUserEntries();
        }

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
