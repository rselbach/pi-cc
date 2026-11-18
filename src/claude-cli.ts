import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import type { ChildProcess } from "node:child_process";
import { registerSessionResourceCleanup } from "@earendil-works/pi-ai";
import {
  childExit,
  configuredCommand,
  envValue,
  killProcessTree,
  POWERSHELL_ENV,
  resolveClaudeExecutable,
  spawnCommand,
} from "./launch.ts";
import { deriveInitialSystemMessages, rewriteInitialRequest } from "./request-rewrite.ts";
import { TurnRelay } from "./turn-relay.ts";
import { UsageCreditsChargeError, usageCreditsAllowed, type RateLimitInfo } from "./billing.ts";
import { envFlagEnabled } from "./env.ts";
import type { DiscoveredClaudeModel } from "./model-catalog.ts";
import type {
  AnthropicStreamEvent,
  NativeFrame,
  NativeMessage,
  NativeOutputEvent,
  NativeResult,
  NativeUsage,
} from "./native-types.ts";
import type { NativeSystemInjection, ToolManifestEntry } from "./transcript.ts";

export const INSTALL_HINT =
  "Claude Code is not installed. Install it with `npm install -g @anthropic-ai/claude-code` " +
  "or set PI_CLAUDE_CODE_COMMAND to the executable.";
export const LOGIN_HINT = "Claude Code is installed but not logged in. Run `claude auth login` and try again.";

export interface ClaudeStatus {
  available: boolean;
  loggedIn: boolean;
  /** True when Claude Code reports a Claude Pro/Max-style subscription login. */
  subscription: boolean;
  plan?: string;
  detail?: string;
  command?: string;
  /**
   * Set when `claude auth status` could not be spawned, exited without a JSON
   * payload, or returned unparsable JSON. A genuine logout leaves this unset.
   */
  diagnostic?: boolean;
}

export interface RunClaudeInput {
  model: string;
  /** Working directory exposed to Claude and used for Pi tool paths. */
  cwd?: string;
  frames: NativeFrame[];
  systemPrompt: string;
  manifest: ToolManifestEntry[];
  extraBody: Record<string, unknown>;
  signal?: AbortSignal;
  timeoutMs?: number;
  env?: Record<string, string | undefined>;
  upstreamUrl?: string;
  /** Native system messages Claude Code injected immediately after that user message. */
  initialSystemMessages?: unknown[];
  /** Pi system/tool deltas to restore at their historical assistant boundaries. */
  nativeSystemInjections?: NativeSystemInjection[];
  /** Beta features appended to Claude Code's own request header by the turn relay. */
  betas?: string[];
  onEvent?: (event: AnthropicStreamEvent) => void;
  /** Pi session whose linear continuation may reuse a warm Claude process. */
  sessionId?: string;
}

export interface RunClaudeOutput {
  message: NativeMessage;
  usage: NativeUsage;
  relay: {
    upstreamRequests: number;
    blockedRequests: number;
    requestId?: string;
  };
  initialSystemMessages?: unknown[];
  /** Latest plan-limit status Claude Code reported for this turn. */
  rateLimit?: RateLimitInfo;
}

function claudeEnvironment(env: Record<string, string | undefined>): Record<string, string> {
  const output: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    // Windows environment names are case-insensitive, so strip every spelling.
    const apiKey = process.platform === "win32" ? key.toUpperCase() === "ANTHROPIC_API_KEY" : key === "ANTHROPIC_API_KEY";
    if (!apiKey) output[key] = value;
  }
  const configDir = envValue(output, "PI_CLAUDE_CODE_CONFIG_DIR");
  if (configDir) output.CLAUDE_CONFIG_DIR = configDir;
  return output;
}

/** Run a Claude Code command to completion and capture its output. Exported for tests. */
export async function captureProcess(
  command: string,
  args: string[],
  env: Record<string, string>,
  signal?: AbortSignal,
  timeoutMs = 20_000,
): Promise<{ code: number; stdout: string; stderr: string }> {
  signal?.throwIfAborted();
  const child = spawnCommand(command, args, { env, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => (stdout = (stdout + chunk).slice(-1_000_000)));
  child.stderr?.on("data", (chunk: string) => (stderr = (stderr + chunk).slice(-65_536)));

  const abort = () => killProcessTree(child);
  signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(abort, timeoutMs);
  try {
    const code = await childExit(child);
    signal?.throwIfAborted();
    return { code, stdout, stderr };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
  }
}

function outputTail(text: string, limit = 500): string {
  const trimmed = text.trim();
  return trimmed.length > limit ? `...${trimmed.slice(-limit)}` : trimmed;
}

/** Parse the `claude auth status` payload, tolerating leading non-JSON noise. */
function statusPayload(stdout: string): Record<string, unknown> | undefined {
  const text = stdout.trim();
  if (!text) return undefined;
  const candidates = [text];
  const brace = text.indexOf("{");
  if (brace > 0) candidates.push(text.slice(brace));
  for (const candidate of candidates) {
    try {
      const parsed: unknown = JSON.parse(candidate);
      if (parsed && typeof parsed === "object") return parsed as Record<string, unknown>;
    } catch {
      // Try the next candidate; a parse failure is reported by the caller.
    }
  }
  return undefined;
}

export async function getClaudeStatus(
  envInput: Record<string, string | undefined> = process.env,
  signal?: AbortSignal,
): Promise<ClaudeStatus> {
  const env = claudeEnvironment(envInput);
  const command = await resolveClaudeExecutable(env);
  if (!command) return { available: false, loggedIn: false, subscription: false, detail: INSTALL_HINT };

  let result: { code: number; stdout: string; stderr: string };
  try {
    result = await captureProcess(command, ["auth", "status"], env, signal);
  } catch (error) {
    if (signal?.aborted) throw error;
    const message = error instanceof Error ? error.message : String(error);
    return {
      available: true,
      loggedIn: false,
      subscription: false,
      command,
      diagnostic: true,
      detail: `Claude Code status check failed: ${message}`,
    };
  }

  const payload = statusPayload(result.stdout);
  if (!payload) {
    // A launch or CLI failure must not masquerade as a logged-out account.
    const output = outputTail(result.stdout) || outputTail(result.stderr) || "(no output)";
    return {
      available: true,
      loggedIn: false,
      subscription: false,
      command,
      diagnostic: true,
      detail: `Claude Code status check failed (exit ${result.code}): unexpected auth status output: ${output}`,
    };
  }

  // Claude Code reports a logout as JSON with `loggedIn: false`, sometimes with
  // a non-zero exit code. Only a JSON payload is authoritative for login state.
  const loggedIn = payload.loggedIn === true;
  const plan = typeof payload.subscriptionType === "string" ? payload.subscriptionType : undefined;
  return {
    available: true,
    loggedIn,
    subscription: loggedIn && !!plan,
    command,
    plan,
    detail: loggedIn ? undefined : LOGIN_HINT,
  };
}

const READY_STATUS_TTL_MS = 60_000;
const readyStatusCache = new Map<string, { command: string; expires: number }>();

/**
 * Resolve a logged-in Claude Code executable. Successful checks are cached
 * briefly because a fresh worker is spawned after every tool call, and an
 * extra `claude auth status` process on each of those turns adds latency.
 */
async function readyClaudeCommand(
  envInput: Record<string, string | undefined>,
  signal?: AbortSignal,
): Promise<string> {
  const env = claudeEnvironment(envInput);
  const key = JSON.stringify([
    configuredCommand(env),
    envValue(env, "PATH"),
    envValue(env, "HOME") ?? envValue(env, "USERPROFILE"),
    env.CLAUDE_CONFIG_DIR,
    envValue(env, POWERSHELL_ENV),
  ]);
  const cached = readyStatusCache.get(key);
  if (cached && cached.expires > Date.now()) return cached.command;

  const status = await getClaudeStatus(env, signal);
  if (!status.available || !status.command) throw new Error(INSTALL_HINT);
  if (!status.loggedIn) {
    readyStatusCache.delete(key);
    throw new Error(status.detail ?? LOGIN_HINT);
  }
  readyStatusCache.set(key, { command: status.command, expires: Date.now() + READY_STATUS_TTL_MS });
  return status.command;
}

function isDiscoveredModel(value: unknown): value is DiscoveredClaudeModel {
  if (!value || typeof value !== "object") return false;
  const model = value as Partial<DiscoveredClaudeModel>;
  return (
    typeof model.value === "string" &&
    typeof model.displayName === "string" &&
    typeof model.description === "string" &&
    (model.resolvedModel === undefined || typeof model.resolvedModel === "string")
  );
}

/** Ask the installed Claude Code process for the account's selectable model catalog. */
export async function discoverClaudeModels(
  envInput: Record<string, string | undefined> = process.env,
  signal?: AbortSignal,
  timeoutMs = 20_000,
): Promise<DiscoveredClaudeModel[]> {
  signal?.throwIfAborted();
  const env = processEnvironment(envInput, {}, "discovery");
  const command = await resolveClaudeExecutable(env);
  if (!command) throw new Error(INSTALL_HINT);

  const args = [
    "-p",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--verbose",
    "--model",
    "default",
    "--tools",
    "",
    "--setting-sources",
    "",
    "--strict-mcp-config",
    "--disable-slash-commands",
    "--permission-mode",
    "dontAsk",
    "--permission-prompts",
    "none",
    "--no-session-persistence",
    "--mcp-config",
    JSON.stringify({ mcpServers: {} }),
  ];
  const child = spawnCommand(command, args, {
    cwd: process.cwd(),
    env,
    detached: process.platform !== "win32",
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const exitOutcome = childExit(child).then(
    (code) => ({ code, error: undefined }),
    (error: unknown) => ({ code: undefined, error: error instanceof Error ? error : new Error(String(error)) }),
  );
  let stderr = "";
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => (stderr = (stderr + chunk).slice(-65_536)));

  const abort = () => killProcessTree(child);
  signal?.addEventListener("abort", abort, { once: true });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    killProcessTree(child);
  }, timeoutMs);

  const requestId = `pi-models-${Date.now()}`;
  child.stdin?.write(
    `${JSON.stringify({ type: "control_request", request_id: requestId, request: { subtype: "initialize" } })}\n`,
  );
  child.stdin?.end(
    `${JSON.stringify({
      type: "user",
      message: { role: "user", content: [{ type: "text", text: "model-catalog-probe" }] },
      shouldQuery: false,
    })}\n`,
  );

  let models: DiscoveredClaudeModel[] | undefined;
  try {
    const reader = createInterface({ input: child.stdout!, crlfDelay: Infinity });
    for await (const line of reader) {
      if (!line.trim()) continue;
      let event: Record<string, unknown>;
      try {
        event = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }
      if (event.type !== "control_response") continue;
      const envelope = event.response as Record<string, unknown> | undefined;
      if (envelope?.request_id !== requestId || envelope.subtype !== "success") continue;
      const response = envelope.response as Record<string, unknown> | undefined;
      if (Array.isArray(response?.models)) models = response.models.filter(isDiscoveredModel);
    }
    const { code: exitCode, error: spawnError } = await exitOutcome;
    signal?.throwIfAborted();
    if (spawnError) throw spawnError;
    if (timedOut) throw new Error("Claude Code model discovery timed out");
    if (exitCode !== 0) throw new Error(`Claude Code model discovery failed${stderr ? `: ${stderr.trim().slice(-500)}` : ""}`);
    if (!models?.length) throw new Error("Claude Code returned no selectable models");
    return models;
  } catch (error) {
    if (timedOut) throw new Error("Claude Code model discovery timed out", { cause: error });
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
    if (child.exitCode === null) killProcessTree(child);
  }
}

class AsyncQueue<T> {
  private readonly values: T[] = [];
  private readonly waiters: Array<(value: IteratorResult<T>) => void> = [];
  private ended = false;
  private failure?: Error;

  push(value: T): void {
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value, done: false });
    else this.values.push(value);
  }

  end(error?: Error): void {
    this.ended = true;
    this.failure = error;
    for (const waiter of this.waiters.splice(0)) waiter({ value: undefined, done: true });
  }

  async next(signal: AbortSignal | undefined, timeoutMs: number): Promise<T | undefined> {
    if (this.values.length) return this.values.shift();
    if (this.ended) {
      if (this.failure) throw this.failure;
      return undefined;
    }
    signal?.throwIfAborted();

    return new Promise<T | undefined>((resolve, reject) => {
      let settled = false;
      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
        fn();
      };
      const waiter = (item: IteratorResult<T>) =>
        finish(() => {
          if (item.done && this.failure) reject(this.failure);
          else resolve(item.done ? undefined : item.value);
        });
      const onAbort = () => finish(() => reject(signal?.reason ?? new Error("Claude Code request aborted")));
      const timer = setTimeout(() => finish(() => reject(new Error("Claude Code stream timed out"))), timeoutMs);
      this.waiters.push(waiter);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }
}

function conflictingEnvironment(env: Record<string, string>): string[] {
  const conflicts = ["ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "ANTHROPIC_FOUNDRY_API_KEY"].filter(
    (key) => !!env[key],
  );
  for (const key of ["CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY"]) {
    if (envFlagEnabled(env[key])) conflicts.push(key);
  }
  return conflicts;
}

function processEnvironment(
  input: Record<string, string | undefined> | undefined,
  extraBody: Record<string, unknown>,
  purpose: "request" | "discovery" = "request",
): Record<string, string> {
  const env = claudeEnvironment({ ...process.env, ...input });
  const conflicts = conflictingEnvironment(env);
  if (conflicts.length) {
    throw new Error(`Claude Code subscription provider refuses conflicting auth/backend overrides: ${conflicts.join(", ")}`);
  }
  delete env.CLAUDE_CODE_EXTRA_BODY;
  Object.assign(env, {
    CLAUDE_CODE_ENTRYPOINT: "pi-agent",
    ENABLE_TOOL_SEARCH: "false",
    DISABLE_AUTOUPDATER: "1",
    DISABLE_FEEDBACK_COMMAND: "1",
    CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL: "1",
    CLAUDE_CODE_DISABLE_FILE_MENTIONS: "1",
    // Claude Code would add these as reminders to user messages and tool
    // results. The relay also strips anything else it adds there.
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
    CLAUDE_CODE_DISABLE_CLAUDE_MDS: "1",
    CLAUDE_CODE_MAX_RETRIES: "0",
    DISABLE_AUTO_COMPACT: "1",
    DISABLE_COMPACT: "1",
    CLAUDE_CODE_TOTAL_TOKENS_REMINDER: "off",
    DISABLE_ERROR_REPORTING: "1",
  });
  // These flags also disable the feature flags that unlock Claude Code's served
  // model catalog. Discovery inherits the user's choices instead of forcing them;
  // conversation workers remain isolated from nonessential traffic.
  if (purpose === "request") {
    env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1";
    env.DISABLE_TELEMETRY = "1";
  }
  if (typeof extraBody.max_tokens === "number") env.CLAUDE_CODE_MAX_OUTPUT_TOKENS = String(extraBody.max_tokens);
  return env;
}

/** Writes a frame stamped with a fresh uuid, which Claude Code echoes back on that frame's result. */
async function writeFrame(child: ChildProcess, frame: NativeFrame): Promise<string> {
  if (!child.stdin?.writable) throw new Error("Claude Code stdin closed during history replay");
  const uuid = randomUUID();
  if (!child.stdin.write(`${JSON.stringify({ ...frame, uuid })}\n`)) {
    await new Promise<void>((resolve, reject) => {
      child.stdin!.once("drain", resolve);
      child.stdin!.once("error", reject);
    });
  }
  return uuid;
}

function resultIsForAnotherMessage(result: NativeResult, uuid: string): boolean {
  const ids = result.user_message_uuids;
  return Array.isArray(ids) && ids.length > 0 && !ids.includes(uuid);
}

function nativeErrorText(event: Extract<NativeOutputEvent, { type: "assistant" }>): string | undefined {
  const messageError = (event.message as Record<string, unknown>).error;
  if (!event.error && !messageError) return undefined;
  return event.message.content
    .filter((block): block is Extract<(typeof event.message.content)[number], { type: "text" }> => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

const CLAUDE_PROCESS_MAX_AGE_MS = 5 * 60 * 1_000;
const MAX_CACHED_CLAUDE_PROCESSES = 2;

interface ClaudeLaunchPlan {
  env: Record<string, string>;
  fingerprint: string;
  timeoutMs: number;
}

function canonicalJson(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .filter(([, child]) => child !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
    .join(",")}}`;
}

function digest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function frameHistoryHash(frames: NativeFrame[]): string {
  return digest(
    frames.map((frame) => ({
      type: frame.type,
      message: frame.message,
    })),
  );
}

function launchPlan(input: RunClaudeInput): ClaudeLaunchPlan {
  const timeoutMs = input.timeoutMs ?? 180_000;
  const env = processEnvironment(input.env, input.extraBody);
  return {
    env,
    timeoutMs,
    fingerprint: digest({
      command: configuredCommand(env),
      cwd: resolve(input.cwd ?? process.cwd()),
      env,
      extraBody: input.extraBody,
      manifest: input.manifest,
      model: input.model,
      systemPrompt: input.systemPrompt,
      timeoutMs,
      upstreamUrl: input.upstreamUrl ?? "https://api.anthropic.com",
    }),
  };
}

class ClaudeProcess {
  busy = false;
  readonly createdAt = Date.now();
  lastUsed = this.createdAt;

  private tipHash?: string;
  private expiryTimer?: NodeJS.Timeout;
  private closed = false;
  private delivered = false;
  private stderr = "";

  readonly fingerprint: string;
  private readonly root: string;
  private readonly child: ChildProcess;
  private readonly relay: TurnRelay;
  private readonly queue: AsyncQueue<NativeOutputEvent>;
  private readonly readTask: Promise<void>;
  private readonly exitOutcome: Promise<{ code?: number; error?: Error }>;
  private readonly timeoutMs: number;

  private constructor(
    fingerprint: string,
    root: string,
    child: ChildProcess,
    relay: TurnRelay,
    queue: AsyncQueue<NativeOutputEvent>,
    readTask: Promise<void>,
    exitOutcome: Promise<{ code?: number; error?: Error }>,
    timeoutMs: number,
  ) {
    this.fingerprint = fingerprint;
    this.root = root;
    this.child = child;
    this.relay = relay;
    this.queue = queue;
    this.readTask = readTask;
    this.exitOutcome = exitOutcome;
    this.timeoutMs = timeoutMs;
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => (this.stderr = (this.stderr + chunk).slice(-65_536)));
  }

  static async create(input: RunClaudeInput, plan: ClaudeLaunchPlan, command: string): Promise<ClaudeProcess> {
    input.signal?.throwIfAborted();

    const root = await mkdtemp(join(tmpdir(), "pi-claude-code-"));
    const toolsPath = join(root, "tools.json");
    const settingsPath = join(root, "settings.json");
    const systemPath = join(root, "system.md");
    const inertMcpPath = fileURLToPath(new URL("./inert-mcp.mjs", import.meta.url));
    let child: ChildProcess | undefined;
    let relay: TurnRelay | undefined;

    try {
      await Promise.all([
        writeFile(toolsPath, JSON.stringify(input.manifest), "utf8"),
        writeFile(settingsPath, JSON.stringify({ env: { CLAUDE_CODE_EXTRA_BODY: JSON.stringify(input.extraBody) } }), "utf8"),
        writeFile(systemPath, input.systemPrompt, "utf8"),
      ]);

      relay = new TurnRelay(input.upstreamUrl ?? "https://api.anthropic.com", plan.timeoutMs);
      const env = { ...plan.env, ANTHROPIC_BASE_URL: await relay.start() };
      const mcp = {
        mcpServers: {
          // Standalone Pi is a Bun-compiled binary, so process.execPath is `pi`
          // itself rather than a JS runtime. BUN_BE_BUN makes it run the script
          // as Bun; Node ignores it.
          pi: { command: process.execPath, args: [inertMcpPath, toolsPath], env: { BUN_BE_BUN: "1" } },
        },
      };
      const args = [
        "-p",
        "--model",
        input.model,
        "--input-format",
        "stream-json",
        "--output-format",
        "stream-json",
        "--verbose",
        "--include-partial-messages",
        "--tools",
        "",
        "--system-prompt-file",
        systemPath,
        "--settings",
        settingsPath,
        "--setting-sources",
        "",
        "--strict-mcp-config",
        "--disable-slash-commands",
        "--max-turns",
        "1",
        "--permission-mode",
        "dontAsk",
        "--no-session-persistence",
        "--mcp-config",
        JSON.stringify(mcp),
      ];

      child = spawnCommand(command, args, {
        // Claude Code tells the model its process cwd. Keep transport files
        // private while exposing Pi's real working directory to the model.
        cwd: input.cwd ?? process.cwd(),
        env,
        detached: process.platform !== "win32",
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
      const queue = new AsyncQueue<NativeOutputEvent>();
      const reader = createInterface({ input: child.stdout!, crlfDelay: Infinity });
      const readTask = (async () => {
        try {
          for await (const line of reader) {
            if (!line.trim()) continue;
            try {
              queue.push(JSON.parse(line) as NativeOutputEvent);
            } catch (error) {
              throw new Error(`Invalid Claude Code stream-json output: ${line.slice(0, 300)}`, { cause: error });
            }
          }
          queue.end();
        } catch (error) {
          queue.end(error instanceof Error ? error : new Error(String(error)));
        }
      })();
      const exitOutcome = childExit(child).then(
        (code) => ({ code }),
        (error: unknown) => ({ error: error instanceof Error ? error : new Error(String(error)) }),
      );
      return new ClaudeProcess(plan.fingerprint, root, child, relay, queue, readTask, exitOutcome, plan.timeoutMs);
    } catch (error) {
      if (child && child.exitCode === null) killProcessTree(child);
      await relay?.close();
      await rm(root, { recursive: true, force: true });
      throw error;
    }
  }

  isAlive(): boolean {
    return !this.closed && this.child.exitCode === null && !!this.child.stdin?.writable;
  }

  isExpired(now = Date.now()): boolean {
    return now - this.createdAt >= CLAUDE_PROCESS_MAX_AGE_MS;
  }

  canContinue(input: RunClaudeInput): boolean {
    if (!this.tipHash || input.frames.length === 0) return false;
    return frameHistoryHash(input.frames.slice(0, -1)) === this.tipHash;
  }

  clearExpiryTimer(): void {
    if (this.expiryTimer) clearTimeout(this.expiryTimer);
    this.expiryTimer = undefined;
  }

  /** Mark the worker idle and schedule its close for the end of its lifetime. */
  armExpiryTimer(expire: () => void): void {
    this.clearExpiryTimer();
    this.lastUsed = Date.now();
    const remainingLifetime = CLAUDE_PROCESS_MAX_AGE_MS - (this.lastUsed - this.createdAt);
    this.expiryTimer = setTimeout(expire, Math.max(0, remainingLifetime));
    this.expiryTimer.unref?.();
  }

  commit(input: RunClaudeInput, message: NativeMessage): boolean {
    // Claude Code executes MCP calls internally before emitting its max-turns
    // result. Our inert MCP response is therefore part of its hidden history,
    // while Pi will append the real tool result. That state is not a faithful
    // continuation and must be discarded; the next request replays from Pi.
    if (message.content.some((block) => block.type === "tool_use")) {
      this.tipHash = undefined;
      return false;
    }
    this.tipHash = frameHistoryHash([
      ...input.frames,
      { type: "assistant", message: { role: "assistant", content: message.content } },
    ]);
    return true;
  }

  get startedOutput(): boolean {
    return this.delivered || this.relay.used;
  }

  async run(input: RunClaudeInput, continuation: boolean): Promise<RunClaudeOutput> {
    if (!this.isAlive()) throw new Error("Claude Code process is no longer available");
    input.signal?.throwIfAborted();

    let sawMessageStop = false;
    this.delivered = false;
    const deliver = (event: AnthropicStreamEvent) => {
      this.delivered = true;
      if (event.type === "message_stop") sawMessageStop = true;
      input.onEvent?.(event);
    };
    this.relay.beginTurn(
      deliver,
      (body) => rewriteInitialRequest(body, input.frames, input.initialSystemMessages, input.nativeSystemInjections),
      input.betas,
    );

    const abort = () => this.closeNow();
    input.signal?.addEventListener("abort", abort, { once: true });

    try {
      const turnUuid = await this.writeFrames(continuation ? input.frames.slice(-1) : input.frames, input.signal);
      const { assistants, result, nativeError, rateLimit } = await this.collectTurn(input.signal, turnUuid, deliver);
      await this.relay.settled();
      input.signal?.throwIfAborted();

      let message: NativeMessage | undefined;
      if (this.relay.used) {
        const failure = this.relay.responseError();
        if (failure) throw failure;
        message = this.relay.capture.message;
        sawMessageStop = true;
      } else {
        message = assistants.at(-1);
      }

      // Native error assistants are not collected; report their text instead of "Incomplete".
      if (!message && nativeError) throw new Error(`Claude Code API error: ${nativeError}`);
      if (!message || !sawMessageStop) {
        throw new Error(
          `Incomplete Claude Code response: assistant, message_stop and one result required${this.stderr ? ` (${this.stderr.trim().slice(-500)})` : ""}`,
        );
      }

      const nativeFailureHandled = this.relay.denied > 0 || message.stop_reason === "refusal";
      if (nativeError && !nativeFailureHandled) throw new Error(`Claude Code API error: ${nativeError}`);
      const hasTools = message.content.some((block) => block.type === "tool_use");
      const maxTurnsBoundary = hasTools && result.subtype === "error_max_turns";
      if (!maxTurnsBoundary && !nativeFailureHandled && (result.is_error || result.subtype !== "success")) {
        throw new Error(`Claude Code request failed: ${result.subtype ?? "unknown result"}`);
      }

      const usage = message.usage ?? result.usage;
      if (!usage || typeof usage.input_tokens !== "number" || typeof usage.output_tokens !== "number") {
        throw new Error("Claude Code response did not include complete token usage");
      }

      // The response is already charged at this point, but stopping here keeps
      // Pi's agent loop from issuing more requests against usage credits.
      if (rateLimit?.isUsingOverage === true && !usageCreditsAllowed({ ...process.env, ...input.env })) {
        throw new UsageCreditsChargeError(rateLimit);
      }

      return {
        message,
        usage,
        relay: {
          upstreamRequests: Number(this.relay.used),
          blockedRequests: this.relay.denied,
          requestId: this.relay.requestId,
        },
        initialSystemMessages:
          input.initialSystemMessages ?? deriveInitialSystemMessages(this.relay.originalRequestBody),
        rateLimit,
      };
    } finally {
      input.signal?.removeEventListener("abort", abort);
      this.relay.finishTurn();
    }
  }

  /** Writes the turn's frames, waiting out each zero-turn history replay, and returns the queried frame's uuid. */
  private async writeFrames(frames: NativeFrame[], signal?: AbortSignal): Promise<string | undefined> {
    let turnUuid: string | undefined;
    for (const frame of frames) {
      const uuid = await writeFrame(this.child, frame);
      if (frame.shouldQuery !== false) {
        turnUuid = uuid;
        continue;
      }
      for (;;) {
        const event = await this.queue.next(signal, this.timeoutMs);
        if (!event) throw await this.exitError("Claude Code exited before acknowledging history replay");
        if (event.type !== "result") continue;
        if (event.num_turns !== 0 || event.is_error) throw new Error("Claude Code rejected zero-turn history replay");
        break;
      }
    }
    return turnUuid;
  }

  private async collectTurn(
    signal: AbortSignal | undefined,
    turnUuid: string | undefined,
    deliver: (event: AnthropicStreamEvent) => void,
  ) {
    const assistants: NativeMessage[] = [];
    let nativeError: string | undefined;
    let rateLimit: RateLimitInfo | undefined;
    for (;;) {
      const event = await this.queue.next(signal, this.timeoutMs);
      if (!event) throw await this.exitError("Claude Code exited before completing its response");
      if (event.type === "assistant") {
        const error = nativeErrorText(event);
        if (error !== undefined) nativeError = error;
        else assistants.push(event.message);
      } else if (event.type === "result") {
        // A late result from an earlier turn may still sit in the queue.
        if (turnUuid && resultIsForAnotherMessage(event, turnUuid)) continue;
        return { assistants, result: event, nativeError, rateLimit };
      } else if (event.type === "rate_limit_event") {
        if (event.rate_limit_info && typeof event.rate_limit_info === "object") rateLimit = event.rate_limit_info;
      } else if (event.type === "stream_event" && !this.relay.used) {
        deliver(event.event);
      }
    }
  }

  async close(): Promise<void> {
    this.closeNow();
    await Promise.allSettled([this.readTask, this.exitOutcome, this.relay.close()]);
    await rm(this.root, { recursive: true, force: true });
  }

  private closeNow(): void {
    if (this.closed) return;
    this.closed = true;
    this.clearExpiryTimer();
    this.relay.finishTurn();
    if (this.child.exitCode === null) killProcessTree(this.child);
  }

  private async exitError(fallback: string): Promise<Error> {
    const outcome = await this.exitOutcome;
    if (outcome.error) return outcome.error;
    const detail = this.stderr.trim().slice(-500);
    return new Error(`${fallback} (exit ${outcome.code ?? "unknown"}${detail ? `: ${detail}` : ""})`);
  }
}

interface AcquiredProcess {
  worker: ClaudeProcess;
  retained: boolean;
  continuation: boolean;
  sessionId?: string;
}

const processCache = new Map<string, ClaudeProcess>();
let managerTail: Promise<void> = Promise.resolve();

async function withManagerLock<T>(operation: () => Promise<T> | T): Promise<T> {
  const previous = managerTail;
  let release!: () => void;
  managerTail = new Promise<void>((resolve) => (release = resolve));
  await previous;
  try {
    return await operation();
  } finally {
    release();
  }
}

async function expireProcess(sessionId: string, worker: ClaudeProcess): Promise<void> {
  const expired = await withManagerLock(() => {
    if (processCache.get(sessionId) !== worker || worker.busy || !worker.isExpired()) return false;
    processCache.delete(sessionId);
    return true;
  });
  if (expired) await worker.close();
}

async function discardProcess(acquired: AcquiredProcess): Promise<void> {
  const { sessionId, worker } = acquired;
  if (sessionId && processCache.get(sessionId) === worker) {
    await withManagerLock(() => {
      if (processCache.get(sessionId) === worker) processCache.delete(sessionId);
    });
  }
  await worker.close();
}

async function acquireProcess(input: RunClaudeInput, plan: ClaudeLaunchPlan, command: string): Promise<AcquiredProcess> {
  return withManagerLock(async () => {
    const sessionId = input.sessionId;
    const cached = sessionId ? processCache.get(sessionId) : undefined;
    if (cached && !cached.busy) {
      cached.clearExpiryTimer();
      if (
        cached.isAlive() &&
        !cached.isExpired() &&
        cached.fingerprint === plan.fingerprint &&
        cached.canContinue(input)
      ) {
        cached.busy = true;
        return { worker: cached, retained: true, continuation: true, sessionId };
      }
      processCache.delete(sessionId!);
      await cached.close();
    }

    // A concurrent request must not mutate the cached conversation. It gets a
    // one-shot process, as does a request without Pi's stable session ID.
    const retain = !!sessionId && !cached?.busy;
    if (retain) {
      while (processCache.size >= MAX_CACHED_CLAUDE_PROCESSES) {
        const victim = [...processCache.entries()]
          .filter(([, worker]) => !worker.busy)
          .sort((left, right) => left[1].lastUsed - right[1].lastUsed)[0];
        if (!victim) break;
        processCache.delete(victim[0]);
        await victim[1].close();
      }
    }

    const worker = await ClaudeProcess.create(input, plan, command);
    worker.busy = true;
    const retained = retain && processCache.size < MAX_CACHED_CLAUDE_PROCESSES;
    if (retained) processCache.set(sessionId!, worker);
    return { worker, retained, continuation: false, sessionId };
  });
}

/** Close warm Claude processes for one Pi session, or all sessions. */
export async function closeClaudeProcesses(sessionId?: string): Promise<void> {
  const workers = await withManagerLock(() => {
    if (sessionId) {
      const worker = processCache.get(sessionId);
      processCache.delete(sessionId);
      return worker ? [worker] : [];
    }
    const all = [...processCache.values()];
    processCache.clear();
    return all;
  });
  await Promise.allSettled(workers.map((worker) => worker.close()));
}

/** Test/debug visibility without exposing child processes themselves. */
export function cachedClaudeProcessCount(): number {
  return processCache.size;
}

registerSessionResourceCleanup((sessionId) => {
  void closeClaudeProcesses(sessionId);
});

export async function runClaudeRequest(input: RunClaudeInput): Promise<RunClaudeOutput> {
  input.signal?.throwIfAborted();
  const plan = launchPlan(input);
  // Resolved outside the manager lock: a slow `claude auth status` must not stall other sessions.
  const command = await readyClaudeCommand({ ...process.env, ...input.env }, input.signal);
  const acquired = await acquireProcess(input, plan, command);
  try {
    const output = await acquired.worker.run(input, acquired.continuation);
    const stable = acquired.worker.commit(input, output.message);
    if (
      stable &&
      acquired.retained &&
      acquired.sessionId &&
      processCache.get(acquired.sessionId) === acquired.worker
    ) {
      acquired.worker.busy = false;
      acquired.worker.armExpiryTimer(() => {
        void expireProcess(acquired.sessionId!, acquired.worker);
      });
    } else {
      await discardProcess(acquired);
    }
    return output;
  } catch (error) {
    await discardProcess(acquired);
    // A warm process can hold stale hidden state. If it failed before streaming
    // or reaching the API, nothing was shown or charged, so replay once on a fresh process.
    if (acquired.continuation && !acquired.worker.startedOutput && !input.signal?.aborted) {
      return runClaudeRequest(input);
    }
    throw error;
  }
}
