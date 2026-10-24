// Shared contracts. Every lib module, hook and script imports its types from here and never redefines them.
// Field names follow the files on disk and Claude Code's hook JSON exactly (snake_case where the harness uses it).

// ---------------------------------------------------------------------------
// Project manifest: `.claude/workflow.json` (committed)
// ---------------------------------------------------------------------------

/** Where `/setup` stands for this project. `declined`: the user opted out; hooks stay quiet. */
export type SetupStatus = "pending" | "running" | "done" | "declined";

/** How much review a diff needs: none (skip), low (cheap model), high (strong model). */
export type RiskLevel = "none" | "low" | "high";

/** When a model reviews the diff or the plan. Default (no `review`): never; the deterministic gates still run (D-015). */
export interface ReviewPolicy {
  /** Repo-relative paths or prefixes (ending in `/`) whose changes always count as risky. */
  paths?: string[];
  /** Review every task, whatever the risk. Wins over `never`. */
  always?: boolean;
  /** Never pay for a diff review. */
  never?: boolean;
  /** Model check of the plan before the user approves it. Default: off. `true` turns it on (risky plans get the strong model, big ones the cheap one); `review.always` or a `minLevel` of `low`/`high` check risky plans; `false` never. */
  plan?: boolean;
  /** Lowest risk level that requests a model review: `off` (default, none), `high` or `low`. The level is recorded either way. */
  minLevel?: "off" | "low" | "high";
  /** Diff size above which a (cheap-model) review is requested. Defaults: 200 lines, 6 files. */
  maxLines?: number;
  maxFiles?: number;
  /** Diff size above which the strong-model review is requested. Defaults: 600 lines, 15 files. */
  highLines?: number;
  highFiles?: number;
  /** A plan with more files / interface entries / decisions than this is not small (no fast route) and, with `plan: true`, gets the plan check. Defaults: 8, 6, 2. Risky paths always do. */
  planFiles?: number;
  planInterface?: number;
  planDecisions?: number;
}

/** A read-only ticket or docs source enabled by `/setup`. Its MCP server lives in the project's `.mcp.json`. */
export interface Connector {
  /** Catalog id, e.g. "github", "jira", "linear". */
  id: string;
  /** Server key in `.mcp.json`; its tools arrive as `mcp__<server>__<tool>`. Absent when the user configures it by hand. */
  server?: string;
}

/** Runtime a project verification tool declares: a python 3 stdlib script, or a script whose nix env pins its dependencies. */
export type ToolRuntime = "python" | "nix";

/**
 * A verification tool `/setup` wrote inside the project. The plugin ships none: each one is generated for the repo.
 * `wf-setup-finish` checks it exists, is executable and answers `--help`; `/wf-doctor` checks its runtime is installed.
 */
export interface VerifyTool {
  /** Repo-relative executable script. */
  path: string;
  runtime: ToolRuntime;
  /** nix only: repo-relative `shell.nix` or `flake.nix` next to the script that pins its dependencies. */
  env?: string;
}

/** How the project works by default: `direct` (cheap model with what /setup left; gates only with an open /task) or `flow` (/task recommended). */
export type WorkflowMode = "direct" | "flow";

/** Project state committed to the repo at `.claude/workflow.json`. */
export interface Manifest {
  version: 1;
  setup: SetupStatus;
  /** Default way of working; optional and additive, absent means `direct`. Gates only ever run with an open /task. */
  mode?: WorkflowMode;
  /** Main language as `/setup` recorded it; informative only, nothing branches on it. */
  language?: string;
  /** ISO 8601 timestamps of the setup run. */
  startedAt?: string;
  completedAt?: string;
  /** Shell commands run in order from the project root; all must exit 0. The only source of verification commands. */
  verify: string[];
  /** Verification tools generated for this project and referenced by `.claude/skills/verify-app/SKILL.md`. */
  tools?: VerifyTool[];
  review?: ReviewPolicy;
  connectors: Connector[];
  /** agentlint command prefix when the project enforces agentlint rules, e.g. "pnpm agentlint". */
  agentlint?: string;
}

// ---------------------------------------------------------------------------
// Plan: the ```wf-plan block inside the plan-mode file (schema: lib/plan.schema.json)
// ---------------------------------------------------------------------------

/** Names the implementation must expose in one file, pinned before any code is written. */
export interface InterfaceEntry {
  /** Repo-relative file path. */
  file: string;
  /** Exported names; each must appear literally (as a word) in `file` once implemented. */
  exports: string[];
  /** Optional signatures, in the project's own language, as plain text. */
  signatures?: string[];
  /** Where the names come from: ticket key, spec path or existing file. Names are checked against this evidence. */
  source?: string;
}

/** Where a test attaches and what it does and does not cover. */
export interface Seam {
  name: string;
  /** Repo-relative test file. */
  testFile: string;
  /** What this test catches. */
  catches: string;
  /** What it leaves uncovered. */
  misses?: string;
}

/** A design decision the plan depends on. Without a `source` the plan is denied: ask the user and write an ADR. */
export interface Decision {
  question: string;
  /** Options considered; may be empty when only one was viable. */
  options: string[];
  /** The chosen option or the user's answer. Absent when `source` already settles it. */
  answer?: string;
  /** Where it is settled: an ADR path (`docs/adr/...`), a spec, the ticket, or an existing file. */
  source: string;
}

/** Structured part of a plan, parsed from the ```wf-plan fenced block. */
export interface Plan {
  title: string;
  /** Ticket key such as "PAY-142"; absent when the task has no ticket. */
  ticket?: string;
  /** Repo-relative spec files whose text counts as evidence for interface names. */
  spec: string[];
  /** Repo-relative files the task may create or change. An entry ending in `/` covers a directory. */
  files: string[];
  interface: InterfaceEntry[];
  seams: Seam[];
  decisions: Decision[];
}

// ---------------------------------------------------------------------------
// Active task: `.claude/workflow/task.json` (local, gitignored)
// ---------------------------------------------------------------------------

/** planning: plan accepted by the hook, waiting for approval; implementing: approved; done: closed by `/done`. */
export type TaskStatus = "planning" | "implementing" | "done";

/** The active task of this working copy. */
export interface Task {
  id: string;
  title: string;
  ticket?: string;
  status: TaskStatus;
  plan?: Plan;
  /** Absolute path of the plan-mode file the plan was parsed from. */
  planFilePath?: string;
  /** Repo-relative files outside the plan the user allowed during implementation. */
  allowedExtra: string[];
  /** ISO 8601 timestamps. */
  startedAt: string;
  completedAt?: string;
  /**
   * `session_id` of the session that last wrote `task.json`. Hooks of any other session skip their handlers, since
   * hooks fire in every session open on the project. Stamped by the dispatcher's `saveTask`; absent means "any session".
   */
  sessionId?: string;
  /** HEAD when the task entered planning; diffs are measured against it. Absent (no git, older task): against HEAD. */
  baseCommit?: string;
}

// ---------------------------------------------------------------------------
// Session state: `${CLAUDE_PLUGIN_DATA}/sessions/<session_id>.json`
// ---------------------------------------------------------------------------

/**
 * Per-session gate counters. Hooks fire in every session open on the project, so each one reads and writes only
 * the file of its own `session_id`. A missing file means all counters are zero.
 */
export interface SessionState {
  sessionId: string;
  /** Gate continuations (`decision: "block"`) spent since the last user prompt; bounded to avoid loops. */
  retries: number;
  /** Diff reviews spent (or skipped as low risk) on the current task; one round only. */
  reviews: number;
  /** Consecutive verify failures since the last pass: the 2nd escalates to the fixer (D-009). */
  failures: number;
  /** Strong-model plan checks spent on the current task. */
  planChecks: number;
  /** ISO 8601 time of the last write. */
  updatedAt: string;
  // Optional, written by the Stop/SubagentStop gates (lib/hooks/gate.ts). Absent means "not yet".
  /** `prompt_id` the per-prompt counters (`retries`, `failures`, `setupNudges`, `lastBlock`) belong to; a new prompt resets them. */
  promptId?: string | undefined;
  /** Pushes back to work while `setup` is `running`, since the last user prompt (at most 2). */
  setupNudges?: number | undefined;
  /** Task id the per-task fields belong to; another task resets them. */
  taskId?: string | undefined;
  /** Gate counters per subagent, keyed by `agent_id`: `stop_hook_active` cannot count retries (spike 0.3). */
  agents?: Record<string, AgentGateState> | undefined;
  /** Last `VERDICT:` of plan-check on the current task. */
  planVerdict?: Verdict | undefined;
  /** Last `VERDICT:` of the diff reviewer on the current task. */
  reviewVerdict?: Verdict | undefined;
  /** What the gate last decided about the diff review on the current task (level, reasons, whether it was requested). */
  review?: ReviewRecord | undefined;
  /** What the orchestrator's last Stop block asked for, so the same request is not repeated in a loop. */
  lastBlock?: string | undefined;
  /** Fingerprint of the working copy when verify last passed in the orchestrator's Stop; unchanged means no rerun. */
  verifiedFingerprint?: string | undefined;
}

/** The gate's last review decision, recorded in the session state. */
export interface ReviewRecord {
  level: RiskLevel;
  reasons: string[];
  requested: boolean;
}

/** Verdict line a strong-model checker ends with: `VERDICT: OK` or `VERDICT: FIX`. */
export type Verdict = "OK" | "FIX";

/** Gate state of one implementer or fixer run (one `agent_id`). */
export interface AgentGateState {
  /** Role without plugin prefix or model suffix: "implementer", "fixer", "reviewer", "plan-check". */
  role: string;
  /** Blocks spent on a missing interface contract. */
  contractBlocks: number;
  /** Consecutive verify failures: 1 fix (with the diagnosis method), 2 released with FAILED (D-009). */
  failures: number;
  /** Blocks spent on agentlint (policy) failures; the second one goes to the person, not to a smarter model. */
  policyBlocks: number;
  /** Set when the gate last let the agent out: passed, or failed (escalate). */
  outcome?: "passed" | "failed" | undefined;
}

// ---------------------------------------------------------------------------
// Hook input: the JSON Claude Code writes to a command hook's stdin (fixtures: test/fixtures/hooks/)
// ---------------------------------------------------------------------------

/** Known permission modes; other strings may appear in newer Claude Code versions. */
export type PermissionMode = "default" | "plan" | "acceptEdits" | "bypassPermissions" | "dontAsk" | "auto" | (string & {});

/** Fields present in every hook event. */
export interface HookInputBase {
  session_id: string;
  /** Main session transcript (JSONL), also inside a subagent. */
  transcript_path: string;
  cwd: string;
}

/** Present only when the event fires inside a subagent: hooks tell the orchestrator from a child by these. */
export interface SubagentContext {
  agent_id?: string;
  /** Agent name, e.g. "implementer"; plugin agents may carry the plugin prefix. */
  agent_type?: string;
}

/** Fields of events that belong to a turn. */
export interface TurnFields {
  /** Id of the user prompt that started the turn. */
  prompt_id: string;
  permission_mode: PermissionMode;
}

export interface Effort {
  level: string;
}

/** A background task listed at Stop time (e.g. a subagent launched asynchronously). */
export interface BackgroundTask {
  id: string;
  type: "subagent" | (string & {});
  status: string;
  description: string;
  agent_type?: string;
}

export interface SessionStartInput extends HookInputBase {
  hook_event_name: "SessionStart";
  source: "startup" | "resume" | "clear" | "compact" | (string & {});
}

export interface UserPromptSubmitInput extends HookInputBase, TurnFields {
  hook_event_name: "UserPromptSubmit";
  prompt: string;
}

export interface PreToolUseInput extends HookInputBase, TurnFields, SubagentContext {
  hook_event_name: "PreToolUse";
  effort?: Effort;
  tool_name: string;
  /** Narrow with the `*ToolInput` types below after checking `tool_name`. */
  tool_input: Record<string, unknown>;
  tool_use_id: string;
}

export interface PostToolUseInput extends HookInputBase, TurnFields, SubagentContext {
  hook_event_name: "PostToolUse";
  effort?: Effort;
  tool_name: string;
  tool_input: Record<string, unknown>;
  /** Tool-specific result; its shape varies by tool and version. */
  tool_response: unknown;
  tool_use_id: string;
  duration_ms?: number;
}

export interface SubagentStartInput extends HookInputBase {
  hook_event_name: "SubagentStart";
  prompt_id?: string;
  agent_id: string;
  agent_type: string;
}

/** Fields shared by Stop and SubagentStop. */
export interface StopFields extends TurnFields {
  effort?: Effort;
  /** True when this stop follows a `decision: "block"` from a Stop hook; use it to avoid loops. */
  stop_hook_active: boolean;
  last_assistant_message: string;
  background_tasks?: BackgroundTask[];
  session_crons?: unknown[];
}

export interface StopInput extends HookInputBase, StopFields {
  hook_event_name: "Stop";
}

export interface SubagentStopInput extends HookInputBase, StopFields {
  hook_event_name: "SubagentStop";
  agent_id: string;
  agent_type: string;
  /** The subagent's own transcript (JSONL). */
  agent_transcript_path: string;
}

export interface SessionEndInput extends HookInputBase {
  hook_event_name: "SessionEnd";
  prompt_id?: string;
  reason: "clear" | "logout" | "prompt_input_exit" | "other" | (string & {});
}

/** Every hook event the plugin handles, discriminated by `hook_event_name`. */
export type HookInput =
  | SessionStartInput
  | UserPromptSubmitInput
  | PreToolUseInput
  | PostToolUseInput
  | SubagentStartInput
  | SubagentStopInput
  | StopInput
  | SessionEndInput;

export type HookEventName = HookInput["hook_event_name"];

/** The input type of one event: `HookInputOf<"Stop">` is `StopInput`. */
export type HookInputOf<E extends HookEventName> = Extract<HookInput, { hook_event_name: E }>;

// Tool inputs the hooks inspect (from `tool_input`).

export interface BashToolInput {
  command: string;
  description?: string;
  timeout?: number;
  run_in_background?: boolean;
}

export interface ReadToolInput {
  file_path: string;
  offset?: number;
  limit?: number;
}

export interface WriteToolInput {
  file_path: string;
  content: string;
}

export interface EditToolInput {
  file_path: string;
  old_string: string;
  new_string: string;
  replace_all?: boolean;
}

export interface AgentToolInput {
  description: string;
  prompt: string;
  subagent_type?: string;
  model?: string;
  run_in_background?: boolean;
}

/** ExitPlanMode `tool_input` in PreToolUse and PermissionRequest: the plan Markdown and its file (seen in spike 0.1). In PostToolUse it is `{}`; see `ExitPlanModeToolResponse`. */
export interface ExitPlanModeToolInput {
  plan?: string;
  planFilePath?: string;
}

/** ExitPlanMode `tool_response` in PostToolUse once the plan is approved (seen in spike 0.1). */
export interface ExitPlanModeToolResponse {
  plan?: string;
  filePath?: string;
  isAgent?: boolean;
}

// ---------------------------------------------------------------------------
// Hook output: the JSON a command hook prints to stdout (empty output + exit 0 = no opinion)
// ---------------------------------------------------------------------------

/** Fields every event accepts. */
export interface HookOutputBase {
  /** false stops Claude entirely; `stopReason` is shown to the user. */
  continue?: boolean;
  stopReason?: string;
  suppressOutput?: boolean;
  /** Message shown to the user, not to the model. */
  systemMessage?: string;
}

export type PermissionDecision = "allow" | "deny" | "ask";

export interface PreToolUseOutput extends HookOutputBase {
  hookSpecificOutput: {
    hookEventName: "PreToolUse";
    permissionDecision?: PermissionDecision;
    /** Shown to the model on deny; to the user on allow/ask. Write it so the model knows what to do next. */
    permissionDecisionReason?: string;
    /** Replaces the tool input before it runs. */
    updatedInput?: Record<string, unknown>;
    additionalContext?: string;
  };
}

export interface PostToolUseOutput extends HookOutputBase {
  decision?: "block";
  reason?: string;
  hookSpecificOutput?: { hookEventName: "PostToolUse"; additionalContext?: string };
}

/** Stop and SubagentStop: `block` keeps the agent working and `reason` is what the model reads. */
export interface StopOutput extends HookOutputBase {
  decision?: "block";
  reason?: string;
}

/** Events that can only add context for the model. */
export interface ContextOutput extends HookOutputBase {
  hookSpecificOutput?: { hookEventName: "SessionStart" | "UserPromptSubmit" | "SubagentStart"; additionalContext?: string };
}

/** What each event's handler may print. */
export interface HookOutputMap {
  SessionStart: ContextOutput;
  UserPromptSubmit: ContextOutput;
  PreToolUse: PreToolUseOutput;
  PostToolUse: PostToolUseOutput;
  SubagentStart: ContextOutput;
  SubagentStop: StopOutput;
  Stop: StopOutput;
  SessionEnd: HookOutputBase;
}

export type HookOutput = HookOutputMap[HookEventName];
