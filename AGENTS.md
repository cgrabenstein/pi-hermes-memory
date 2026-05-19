# Pi Hermes Memory Extension — Repository Map

Pi extension bringing Hermes-style persistent memory, session search, and procedural skills to Pi. 368 tests.

- **Runtime**: Pi extension API (`@earendil-works/pi-coding-agent`), jiti-loaded
- **Storage**: Markdown (`MEMORY.md`, `USER.md`, `failures.md`) + SQLite FTS5 (`sessions.db`)
- **Entry**: `src/index.ts`
- **Config**: `~/.pi/agent/hermes-memory-config.json` (optional)

```
src/
├── index.ts                          Entry point — wires all components
├── types.ts                          Shared interfaces, enums, getMessageText()
├── constants.ts                      Prompts, defaults, regex patterns, delimiters
├── config.ts                         Loads hermes-memory-config.json, merges defaults
├── project.ts                        Project detection from cwd
├── prompt-context.ts                 Builds policy or legacy prompt blocks
├── project-memory-migration.ts       Migrates ~/.pi/agent/<project>/ → projects-memory/
│
├── store/                            Data layer
│   ├── memory-store.ts               MemoryStore — CRUD for MEMORY.md, USER.md, failures.md
│   ├── skill-store.ts                SkillStore — CRUD for Pi-native skills
│   ├── skill-utils.ts                Slugify, frontmatter, Jaccard similarity
│   ├── db.ts                         DatabaseManager — better-sqlite3 with Bun fallback
│   ├── schema.ts                     SQL DDL (sessions, messages, memories, FTS5)
│   ├── session-parser.ts             Parse Pi JSONL sessions
│   ├── session-indexer.ts            Bulk-import sessions into SQLite
│   ├── session-search.ts             FTS5 search across indexed sessions
│   ├── sqlite-memory-store.ts        SQLite mirror of Markdown memory + FTS5 search
│   ├── fts5-query.ts                 FTS5 query builder (stop words, OR folding)
│   └── content-scanner.ts            Blocks injection/exfiltration/secrets
│
├── tools/                            LLM-callable tools
│   ├── memory-tool.ts                memory — add/replace/remove with SQLite sync
│   ├── skill-tool.ts                 skill — create/view/patch/edit/delete
│   ├── session-search-tool.ts        session_search — FTS5 over past sessions
│   └── memory-search-tool.ts         memory_search — FTS5 over extended store
│
├── handlers/                         Event handlers + commands
│   ├── background-review.ts          Learning loop — auto-saves every N turns/tool calls
│   ├── session-flush.ts              Flush on compact/shutdown
│   ├── auto-consolidate.ts           Auto-consolidation on overflow + /memory-consolidate
│   ├── correction-detector.ts        Two-pass correction detection + immediate save
│   ├── skill-auto-trigger.ts         Auto-extract skills after complex tasks
│   ├── insights.ts                   /memory-insights
│   ├── skills-command.ts             /memory-skills
│   ├── interview.ts                  /memory-interview (onboarding Q&A)
│   ├── switch-project.ts             /memory-switch-project
│   ├── index-sessions.ts             /memory-index-sessions
│   ├── learn-memory.ts               /learn-memory-tool
│   ├── sync-markdown-memories.ts     /memory-sync-markdown (Markdown → SQLite)
│   ├── preview-context.ts            /memory-preview-context
│   └── message-parts.ts              Shared: extract text from session branches
│
└── skills/
    └── procedural-skill-creator/     Bundled skill for skill-auto-trigger
        └── SKILL.md
```

## Architecture

### Startup sequence

`index.ts` runs in this order:

1. **Config** → `loadConfig()` from `~/.pi/agent/hermes-memory-config.json`
2. **Init stores** → `MemoryStore` (global), `MemoryStore` (project-scoped, if in a project), `SkillStore`, `DatabaseManager`
3. **Migrate legacy** → move old `~/.pi/agent/<project>/MEMORY.md` → `projects-memory/<project>/`
4. **Sync Markdown → SQLite** → backfill existing `.md` entries into `sessions.db` (best-effort)
5. **Register hooks** → `session_start` (load from disk), `before_agent_start` (inject memory context), `session_shutdown` (auto-index session)
6. **Register tools** → `memory`, `skill`, `session_search`, `memory_search`
7. **Setup background handlers** → review loop, flush, correction detector, skill auto-trigger
8. **Register commands** → all `/memory-*` commands
9. **Inject consolidation** → `store.setConsolidator(triggerConsolidation)` (breaks circular import)

### Two-tier storage

| Tier | Store | Purpose | Capacity |
|---|---|---|---|
| **Prompt** | Injected at `before_agent_start` | Policy-only memory context by default (or full legacy blocks for `memoryMode: "legacy-inject"`) | ~1-3KB |
| **Hot** | `MEMORY.md`, `USER.md`, `failures.md` | §-delimited entries, loaded on start, searched via `memory_search` when needed | 5K memory/user, 10K failures |
| **Cold** | `sessions.db` → `memories` table | Unlimited SQLite mirror with FTS5; `memory_search` queries here | Unlimited |
| **Archive** | `sessions.db` → `sessions`/`messages` tables | FTS5-indexed past conversations; `session_search` queries here | Unlimited |

Key rule: **Markdown is the source of truth.** SQLite is a search mirror. Writes go to Markdown first, then best-effort synced to SQLite.

### Event lifecycle

| Pi event | Handler | Behavior |
|---|---|---|
| `session_start` | index.ts | Load memory from disk, discover skills, migrate legacy |
| `before_agent_start` | `prompt-context.ts` | Injects `<memory-context>` policy or legacy blocks |
| `message_end` (user) | `correction-detector.ts` | Sets pending-correction flag |
| `turn_end` | `background-review.ts` | Every N turns/tool calls → `pi.exec()` review subprocess |
| `turn_end` | `correction-detector.ts` | On pending correction → `pi.exec()` save, rate-limited |
| `turn_end` | `skill-auto-trigger.ts` | After 8+ tool calls + 2+ types → `pi.exec()` skill extract |
| `session_before_compact` | `session-flush.ts` | `pi.exec()` flush (awaited, generous timeout) |
| `session_shutdown` | `session-flush.ts` | Fire-and-forget flush (10s timeout, don't block shutdown) |
| `session_shutdown` | index.ts | Parse current session JSONL → `indexSession()` into SQLite |

All `pi.exec()` calls use `["-p", "--no-session", ...]` — isolated one-shot subprocesses that stay within Pi's extension API.

### Memory targets

| Target | File | What goes there |
|---|---|---|
| `memory` | `MEMORY.md` | Environment facts, tool quirks, project conventions |
| `user` | `USER.md` | User preferences, communication style, standing instructions |
| `failure` | `failures.md` | Categorized lessons: `[correction]`, `[insight]`, `[tool-quirk]`, etc. |
| `project` | `projects-memory/<name>/MEMORY.md` | Repo-specific notes, auto-detected from cwd |

Overflow strategies: `auto-consolidate` (default — spawns LLM to merge entries), `reject`, `fifo-evict`.

---

## Tests

368 tests across `tests/`. Run with `npm test` (calls `tests/run-all.sh`).

| Directory | Tests |
|---|---|
| `tests/store/` | memory-store, skill-store, db, session-parser, session-indexer, content-scanner, session-search, sqlite-memory-store |
| `tests/tools/` | memory-tool, skill-tool |
| `tests/handlers/` | all 14 handlers |
| `tests/` root | config, project, project-memory-migration |
| `tests/integration/` | flow |

## Development

```bash
npm run check   # tsc --noEmit
pi -e ./src/index.ts  # test locally
```

## Installation

```bash
pi install github:chandra447/pi-hermes-memory
```
