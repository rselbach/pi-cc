import type { Model } from "@earendil-works/pi-ai";
import { getBuiltinModels } from "@earendil-works/pi-ai/providers/all";

export const PROVIDER_ID = "pi-cc";
export const API_ID = "claude-code-stream-json";

export type ClaudeCodeModel = Model<typeof API_ID>;

export interface DiscoveredClaudeModel {
  value: string;
  resolvedModel?: string;
  displayName: string;
  description: string;
  supportsEffort?: boolean;
  supportedEffortLevels?: Array<"low" | "medium" | "high" | "xhigh" | "max">;
  supportsAdaptiveThinking?: boolean;
  supportsFastMode?: boolean;
  supportsAutoMode?: boolean;
  supportsThinkingOff?: boolean;
}

// Pi exposes providers/all to extensions, but not individual generated model files.
const BUILTIN_ANTHROPIC_MODELS: Record<string, Model<"anthropic-messages">> = Object.fromEntries(
  getBuiltinModels("anthropic").map((model) => [model.id, model]),
);
const NATIVE_ROUTE_BY_ID = new Map<string, string>();
const NATIVE_TOOL_CHANGES_BY_ID = new Map<string, boolean>();
const ADAPTIVE_THINKING_BY_ID = new Map<string, boolean>();
const DISABLED_THINKING_BY_ID = new Map<string, boolean>();

const FALLBACK_DISCOVERY: DiscoveredClaudeModel[] = [
  {
    value: "default",
    resolvedModel: "claude-opus-5-5",
    displayName: "Default (recommended)",
    description: "Opus 5.5 · Best for everyday, complex tasks",
    supportsEffort: true,
    supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"],
    supportsAdaptiveThinking: true,
    supportsFastMode: true,
    supportsAutoMode: true,
    supportsThinkingOff: false,
  },
  {
    value: "opus",
    resolvedModel: "claude-opus-5-5",
    displayName: "Opus 5.5",
    description: "For complex work and everyday tasks",
    supportsEffort: true,
    supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"],
    supportsAdaptiveThinking: true,
    supportsFastMode: true,
    supportsAutoMode: true,
    supportsThinkingOff: false,
  },
  {
    value: "fable",
    resolvedModel: "claude-fable-5-2",
    displayName: "Fable 5.2",
    description: "For your toughest challenges",
    supportsEffort: true,
    supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"],
    supportsAdaptiveThinking: true,
    supportsFastMode: true,
    supportsAutoMode: true,
    supportsThinkingOff: false,
  },
  {
    value: "sonnet",
    resolvedModel: "claude-sonnet-5-5",
    displayName: "Sonnet 5.5",
    description: "Most efficient for simpler tasks",
    supportsEffort: true,
    supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"],
    supportsAdaptiveThinking: true,
    supportsAutoMode: true,
    supportsThinkingOff: false,
  },
  {
    value: "haiku",
    resolvedModel: "claude-haiku-5-5",
    displayName: "Haiku 5.5",
    description: "Fastest for quick answers",
    supportsEffort: true,
    supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"],
    supportsAdaptiveThinking: true,
    supportsAutoMode: true,
    supportsThinkingOff: false,
  },
];

const ALIASES: Record<string, string> = {
  sonnet: "claude-sonnet-5-5",
  haiku: "claude-haiku-5-5",
  "claude-haiku-4-5": "claude-haiku-4-5-20251001",
  opus: "claude-opus-5-5",
  fable: "claude-fable-5-2",
};

function withoutContextSuffix(model: string): string {
  return model.replace(/\[1m\]$/u, "");
}

function canonicalModelId(info: DiscoveredClaudeModel): string {
  if (info.value === "default") return "default";
  return withoutContextSuffix(info.resolvedModel || ALIASES[withoutContextSuffix(info.value)] || info.value);
}

function fallbackModel(info: DiscoveredClaudeModel, id: string): ClaudeCodeModel {
  const supported = info.supportedEffortLevels;
  const thinkingLevelMap = supported?.length
    ? (Object.fromEntries(supported.map((level) => [level, level])) as ClaudeCodeModel["thinkingLevelMap"])
    : undefined;
  return {
    id,
    name: `${info.displayName} (Claude Code)`,
    api: API_ID,
    provider: PROVIDER_ID,
    baseUrl: "process://claude-code",
    reasoning: info.supportsAdaptiveThinking === true || info.supportsEffort === true,
    ...(thinkingLevelMap ? { thinkingLevelMap } : {}),
    input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: /\b1M context\b/iu.test(info.description) ? 1_000_000 : 200_000,
    maxTokens: 64_000,
  };
}

function fromBuiltin(id: string, builtin: Model<"anthropic-messages">): ClaudeCodeModel {
  const {
    api: _api,
    provider: _provider,
    baseUrl: _baseUrl,
    compat: _compat,
    ...metadata
  } = builtin;
  return {
    ...metadata,
    id,
    name: id === "default" ? `Default (${builtin.name})` : builtin.name,
    api: API_ID,
    provider: PROVIDER_ID,
    baseUrl: "process://claude-code",
  };
}

/** Convert a Claude Code catalog row into Pi's built-in Anthropic naming and pricing. */
export function modelFromDiscovery(info: DiscoveredClaudeModel): ClaudeCodeModel {
  const id = canonicalModelId(info);
  const builtinId = id === "default" ? withoutContextSuffix(info.resolvedModel || "") : id;
  const builtin = BUILTIN_ANTHROPIC_MODELS[builtinId];
  NATIVE_ROUTE_BY_ID.set(id, info.value);
  NATIVE_TOOL_CHANGES_BY_ID.set(id, builtin?.compat?.supportsMidConvoToolChanges === true);
  ADAPTIVE_THINKING_BY_ID.set(id, info.supportsAdaptiveThinking === true);
  DISABLED_THINKING_BY_ID.set(
    id,
    // Claude Code reports whether the model accepts `thinking.type: disabled`. Without that,
    // Pi marks models that reject it with `off: null`, and unknown adaptive models are
    // assumed to be newer and therefore unable to disable thinking.
    typeof info.supportsThinkingOff === "boolean"
      ? info.supportsThinkingOff
      : builtin
        ? builtin.thinkingLevelMap?.off !== null
        : info.supportsAdaptiveThinking !== true,
  );
  return builtin ? fromBuiltin(id, builtin) : fallbackModel(info, id);
}

export const CLAUDE_CODE_MODELS: ClaudeCodeModel[] = FALLBACK_DISCOVERY.map(modelFromDiscovery);

export function nativeModel(model: string): string {
  const direct = NATIVE_ROUTE_BY_ID.get(model);
  if (direct) return direct;
  if (model === "default") return model;
  const canonical = canonicalRoute(model);
  return model.endsWith("[1m]") ? `${canonical}[1m]` : canonical;
}

function canonicalRoute(model: string): string {
  const withoutSuffix = withoutContextSuffix(model);
  return ALIASES[withoutSuffix] ?? withoutSuffix;
}

/**
 * Whether Claude Code reports adaptive thinking for this model, falling back to Pi's catalog.
 * Models unknown to both are assumed to support it.
 */
export function supportsAdaptiveThinking(model: string): boolean {
  const canonical = canonicalRoute(model);
  const known = ADAPTIVE_THINKING_BY_ID.get(model) ?? ADAPTIVE_THINKING_BY_ID.get(canonical);
  if (known !== undefined) return known;
  const builtin = BUILTIN_ANTHROPIC_MODELS[canonical];
  return builtin ? builtin.compat?.forceAdaptiveThinking === true : true;
}

/** Whether the API accepts `thinking: { type: "disabled" }` for this model. */
export function supportsDisabledThinking(model: string): boolean {
  const canonical = canonicalRoute(model);
  const known = DISABLED_THINKING_BY_ID.get(model) ?? DISABLED_THINKING_BY_ID.get(canonical);
  if (known !== undefined) return known;
  const builtin = BUILTIN_ANTHROPIC_MODELS[canonical];
  return builtin ? builtin.thinkingLevelMap?.off !== null : !supportsAdaptiveThinking(model);
}

/** Whether Anthropic currently accepts native mid-conversation tool blocks for this route. */
export function supportsNativeToolChanges(model: string): boolean {
  const canonical = canonicalRoute(model);
  return (
    NATIVE_TOOL_CHANGES_BY_ID.get(model) ??
    NATIVE_TOOL_CHANGES_BY_ID.get(canonical) ??
    BUILTIN_ANTHROPIC_MODELS[canonical]?.compat?.supportsMidConvoToolChanges === true
  );
}
