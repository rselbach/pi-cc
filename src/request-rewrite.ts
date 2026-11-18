import type { NativeFrame } from "./native-types.ts";
import type { NativeSystemInjection } from "./transcript.ts";

function withoutCacheControl(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutCacheControl);
  if (!value || typeof value !== "object") return value;
  const output: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (key !== "cache_control") output[key] = withoutCacheControl(child);
  }
  return output;
}

interface NativeRequestMessage {
  role?: string;
  content?: unknown;
}

function requestMessages(body: Buffer | undefined): NativeRequestMessage[] | undefined {
  if (!body) return undefined;
  try {
    const payload = JSON.parse(body.toString("utf8")) as { messages?: unknown };
    return Array.isArray(payload.messages) ? (payload.messages as NativeRequestMessage[]) : undefined;
  } catch {
    return undefined;
  }
}

export function deriveInitialSystemMessages(body: Buffer | undefined): unknown[] | undefined {
  const messages = requestMessages(body);
  if (messages?.[0]?.role !== "user") return undefined;
  let end = 1;
  while (messages[end]?.role === "system") end += 1;
  const systems = messages.slice(1, end);

  // A replayed history from an older carrier has the date reminder at the
  // moving tail rather than in the initial environment reminder. Snapshot it
  // beside the environment so the next request has a stable prefix.
  let trailingStart = messages.length;
  while (trailingStart > end && messages[trailingStart - 1]?.role === "system") trailingStart -= 1;
  if (trailingStart < messages.length) systems.push(...messages.slice(trailingStart));
  return systems.length ? structuredClone(systems) : undefined;
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) =>
      block && typeof block === "object" && typeof (block as Record<string, unknown>).text === "string"
        ? ((block as Record<string, unknown>).text as string)
        : "",
    )
    .join("");
}

function setCacheBreakpoint(message: NativeRequestMessage): void {
  if (typeof message.content === "string") {
    message.content = [
      { type: "text", text: message.content, cache_control: { type: "ephemeral", ttl: "1h" } },
    ];
    return;
  }
  if (!Array.isArray(message.content) || message.content.length === 0) return;
  const last = message.content.at(-1);
  if (!last || typeof last !== "object") return;
  // One breakpoint per message: Claude Code may already have marked an earlier
  // block (e.g. a trailing date-reminder system message), and a second marker
  // here would exceed Anthropic's four-breakpoint limit.
  for (const block of message.content) {
    if (block && typeof block === "object") delete (block as Record<string, unknown>).cache_control;
  }
  (last as Record<string, unknown>).cache_control = { type: "ephemeral", ttl: "1h" };
}

function setReplayCacheBreakpoints(messages: NativeRequestMessage[]): void {
  const userIndexes = messages
    .map((message, index) => (message.role === "user" ? index : -1))
    .filter((index) => index >= 0);
  if (userIndexes.length >= 3) {
    // Claude permits four cache breakpoints. Its two system-prompt markers
    // consume half of them, so once a prior queried user exists, move the
    // native environment marker to that exact previous query boundary. This
    // avoids relying on automatic lookback (notably unreliable with images).
    for (const message of messages) {
      if (message.role === "system") message.content = withoutCacheControl(message.content);
    }
    setCacheBreakpoint(messages[userIndexes.at(-2)!]!);
  }
  const final = messages.at(-1);
  if (final) setCacheBreakpoint(final);
}

type ContentBlock = Record<string, unknown>;

function isBlock(value: unknown): value is ContentBlock {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** Claude Code's note after an image it downscaled, mapping coordinates to the original. */
function isImageScaleNote(block: unknown): boolean {
  return (
    isBlock(block) &&
    block.type === "text" &&
    typeof block.text === "string" &&
    /^\[Image: original \d+x\d+/u.test(block.text)
  );
}

/**
 * Rebuild native user content from Pi's canonical blocks. Claude Code adds
 * reminders (auto-memory, account context, attachments) to user messages and
 * appends them to tool-result text; none of that is Pi history. Canonical
 * blocks are matched in order to Claude Code's blocks by type, and anything
 * Claude Code added is dropped. Images are the exception: Claude Code may
 * downscale them and add a coordinate note, so its copies are kept.
 */
function alignCanonicalContent(canonical: unknown[], wire: unknown[], where: string): unknown[] {
  const output: unknown[] = [];
  let cursor = 0;
  for (const block of canonical) {
    if (!isBlock(block)) throw new Error(`Claude Code request has an invalid canonical block in ${where}`);
    const index = wire.findIndex(
      (candidate, position) =>
        position >= cursor &&
        isBlock(candidate) &&
        candidate.type === block.type &&
        (block.type !== "tool_result" || candidate.tool_use_id === block.tool_use_id),
    );
    if (index < 0) throw new Error(`Claude Code request lost a ${String(block.type)} block in ${where}`);
    const native = wire[index] as ContentBlock;
    cursor = index + 1;

    if (block.type === "image") {
      output.push(withoutCacheControl(native));
      if (isImageScaleNote(wire[cursor])) output.push(withoutCacheControl(wire[cursor++]));
    } else if (block.type === "tool_result" && Array.isArray(block.content) && Array.isArray(native.content)) {
      output.push({ ...structuredClone(block), content: alignCanonicalContent(block.content, native.content, where) });
    } else {
      output.push(structuredClone(block));
    }
  }
  return output;
}

function restoreCanonicalUserContent(messages: NativeRequestMessage[], frames: NativeFrame[]): void {
  const canonical = frames.filter((frame) => frame.type === "user");
  const native = messages.filter((message) => message.role === "user");
  if (native.length !== canonical.length) {
    throw new Error(
      `Claude Code request has ${native.length} user messages where Pi's history has ${canonical.length}`,
    );
  }
  native.forEach((message, index) => {
    const wire = Array.isArray(message.content)
      ? message.content
      : typeof message.content === "string"
        ? [{ type: "text", text: message.content }]
        : [];
    // Keep Claude Code's breakpoint on this message even if it marked a dropped block.
    const marker = (wire.findLast((block) => isBlock(block) && block.cache_control) as ContentBlock | undefined)
      ?.cache_control;
    const content = alignCanonicalContent(canonical[index]!.message.content, wire, `user message ${index}`);
    if (marker && content.length) {
      content[content.length - 1] = { ...(content.at(-1) as ContentBlock), cache_control: structuredClone(marker) };
    }
    message.content = content;
  });
}

function injectNativeSystemMessages(
  messages: NativeRequestMessage[],
  injections: NativeSystemInjection[],
): NativeRequestMessage[] {
  const byAssistant = new Map<number, NativeRequestMessage[]>();
  const trailing: NativeRequestMessage[] = [];
  for (const injection of injections) {
    const message = { role: "system", content: structuredClone(injection.content) };
    if (injection.beforeAssistant === null) trailing.push(message);
    else {
      const pending = byAssistant.get(injection.beforeAssistant) ?? [];
      pending.push(message);
      byAssistant.set(injection.beforeAssistant, pending);
    }
  }

  const output: NativeRequestMessage[] = [];
  let assistantOrdinal = 0;
  for (const message of messages) {
    if (message.role === "assistant") {
      output.push(...(byAssistant.get(assistantOrdinal) ?? []));
      byAssistant.delete(assistantOrdinal);
      assistantOrdinal += 1;
    }
    output.push(message);
  }
  if (byAssistant.size > 0) throw new Error("Claude Code request lost an assistant boundary needed by system history");
  output.push(...trailing);
  return output;
}

function normalizeLeadingSystemCache(system: unknown): void {
  if (!Array.isArray(system)) return;
  for (const block of system) {
    if (block && typeof block === "object") delete (block as Record<string, unknown>).cache_control;
  }
  const last = system.at(-1);
  if (last && typeof last === "object") {
    (last as Record<string, unknown>).cache_control = { type: "ephemeral", ttl: "1h" };
  }
}

export function rewriteInitialRequest(
  body: Buffer,
  frames: NativeFrame[],
  initialSystemMessages: unknown[] | undefined,
  nativeSystemInjections?: NativeSystemInjection[],
): Buffer {
  const payload = JSON.parse(body.toString("utf8")) as {
    messages?: NativeRequestMessage[];
    system?: unknown;
  };
  let messages = payload.messages;
  const first = messages?.[0];
  if (first?.role !== "user" || !Array.isArray(first.content)) {
    throw new Error("Claude Code request is missing its initial user message");
  }
  if (messages) restoreCanonicalUserContent(messages, frames);

  if (initialSystemMessages?.length && messages) {
    let systemEnd = 1;
    while (messages[systemEnd]?.role === "system") systemEnd += 1;
    messages.splice(1, systemEnd - 1, ...(structuredClone(initialSystemMessages) as NativeRequestMessage[]));

    const initialText = initialSystemMessages
      .map((message) => contentText((message as NativeRequestMessage).content))
      .join("\n");
    while (messages.at(-1)?.role === "system") {
      const trailingText = contentText(messages.at(-1)?.content);
      if (!trailingText || !initialText.includes(trailingText)) break;
      messages.pop();
    }
  }

  if (nativeSystemInjections) {
    messages = injectNativeSystemMessages(messages!, nativeSystemInjections);
    payload.messages = messages;
    normalizeLeadingSystemCache(payload.system);
  }
  if (initialSystemMessages?.length || nativeSystemInjections) setReplayCacheBreakpoints(messages!);

  return Buffer.from(JSON.stringify(payload));
}
