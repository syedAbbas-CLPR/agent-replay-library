/**
 * Codex CLI format parser.
 *
 * Supports two format variants:
 * - Legacy: event_msg with task_started/task_complete boundaries + response_item payloads
 * - New: thread.started/item.completed with nested item objects
 *
 * Both use apply_patch for file edits and exec_command for shell commands.
 */

import { filterEmptyTurns } from "./shared.mjs";

export const name = "codex";

/**
 * Detect if JSONL lines contain Codex format entries.
 */
export function detect(firstObj) {
  if (firstObj.type === "session_meta") return true;
  if (firstObj.type === "thread.started") return true;
  if (firstObj.type === "item.completed" && firstObj.item) return true;
  return false;
}

/**
 * Extract the actual user request from Codex user messages.
 * Codex prepends IDE context; the real text follows "## My request for Codex:".
 */
function extractCodexUserText(text) {
  const marker = "## My request for Codex:";
  const idx = text.indexOf(marker);
  if (idx !== -1) return text.slice(idx + marker.length).trim();
  const marker2 = "## My request for Codex";
  const idx2 = text.indexOf(marker2);
  if (idx2 !== -1) {
    const after = text.slice(idx2 + marker2.length);
    return after.replace(/^:?\s*/, "").trim();
  }
  return text.trim();
}

function normalizeToolOutput(output) {
  if (typeof output === "string") return output;
  if (Array.isArray(output)) {
    return output.map((block) => {
      if (typeof block === "string") return block;
      if (typeof block?.text === "string") return block.text;
      if (typeof block?.output === "string") return block.output;
      return block == null ? "" : JSON.stringify(block);
    }).join("");
  }
  if (output && typeof output === "object" && "output" in output) {
    return normalizeToolOutput(output.output);
  }
  return output == null ? "" : JSON.stringify(output, null, 2);
}

function extractPatchFromExecInput(input) {
  if (typeof input !== "string" || !input.includes("*** Begin Patch")) return null;
  const assignment = input.match(/const\s+patch\s*=\s*("(?:\\.|[^"\\])*")\s*;/s);
  if (assignment) {
    try { return JSON.parse(assignment[1]); } catch { /* fall through */ }
  }
  const start = input.indexOf("*** Begin Patch");
  const endMarker = "*** End Patch";
  const end = input.indexOf(endMarker, start);
  if (end === -1) return null;
  return input.slice(start, end + endMarker.length);
}

function decodeJsStringLiteral(literal) {
  if (!literal) return "";
  if (literal.startsWith('"')) {
    try { return JSON.parse(literal); } catch { /* fall through */ }
  }
  const quote = literal[0];
  let body = literal.slice(1, -1);
  body = body.replace(/\\\r\\\n/g, "\n").replace(/\\\n/g, "\n").replace(/\\\r/g, "\n").replace(/\\\t/g, "\t");
  body = body.replace(/\\([\\'"`])/g, "$1");
  if (quote === "`") body = body.replace(/\\\$\{/g, "${");
  return body;
}

function extractExecCommands(input) {
  if (typeof input !== "string") return [];
  const commands = [];
  const re = /["']?cmd["']?\s*:\s*("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`)/gs;
  for (const match of input.matchAll(re)) {
    const command = decodeJsStringLiteral(match[1]).trim();
    if (command) commands.push(command);
  }
  return commands;
}

/**
 * Parse a Codex apply_patch string into Edit/Write-compatible input.
 */
function parseCodexPatch(patchStr) {
  const lines = patchStr.split("\n");
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  let filePath = "";
  const filePaths = [];
  let isNew = false;
  const oldLines = [];
  const newLines = [];

  for (const line of lines) {
    if (line.startsWith("*** Begin Patch") || line.startsWith("*** End Patch")) continue;
    if (line.startsWith("*** Add File:")) {
      filePath = line.replace("*** Add File:", "").trim();
      if (!filePaths.includes(filePath)) filePaths.push(filePath);
      isNew = true;
      continue;
    }
    if (line.startsWith("*** Update File:")) {
      filePath = line.replace("*** Update File:", "").trim();
      if (!filePaths.includes(filePath)) filePaths.push(filePath);
      isNew = false;
      continue;
    }
    if (line.startsWith("@@")) continue;
    if (line.startsWith("+")) {
      newLines.push(line.slice(1));
    } else if (line.startsWith("-")) {
      oldLines.push(line.slice(1));
    } else {
      oldLines.push(line);
      newLines.push(line);
    }
  }

  if (isNew) {
    return { file_path: filePaths[0] ?? filePath, file_paths: filePaths, content: newLines.join("\n"), isNew: true };
  }
  return { file_path: filePaths[0] ?? filePath, file_paths: filePaths, old_string: oldLines.join("\n"), new_string: newLines.join("\n"), isNew: false };
}

/**
 * Parse newer Codex format with item.completed events.
 */
function parseNewFormat(events) {
  const blocks = [];
  let userText = "";
  let timestamp = "";

  for (const evt of events) {
    if (evt.type !== "item.completed") continue;
    const item = evt.item;
    if (!item || typeof item !== "object") continue;

    const itemType = item.type ?? "";
    const ts = evt.timestamp ?? null;

    if (itemType === "command_execution") {
      const cmd = typeof item.command === "string" ? item.command : String(item.command ?? "");
      const cleanCmd = cmd.replace(/^\/bin\/bash\s+-lc\s+/, "").replace(/^'(.*)'$/, "$1").replace(/^"(.*)"$/, "$1");
      blocks.push({
        kind: "tool_use", text: "",
        tool_call: {
          tool_use_id: item.id ?? "", name: "Bash",
          input: { command: cleanCmd },
          result: (item.aggregated_output ?? "").trim(),
          resultTimestamp: ts,
          is_error: item.exit_code != null && item.exit_code !== 0,
        },
        timestamp: ts,
      });
    } else if (itemType === "reasoning") {
      const text = item.text ?? "";
      if (text.trim()) blocks.push({ kind: "thinking", text, tool_call: null, timestamp: ts });
    } else if (itemType === "agent_message") {
      const text = item.text ?? "";
      if (text.trim()) blocks.push({ kind: "text", text, tool_call: null, timestamp: ts });
    } else if (itemType === "function_call") {
      const name = item.name ?? "unknown";
      let input = {};
      try { input = JSON.parse(item.arguments ?? "{}"); } catch { input = { raw: item.arguments }; }
      if (name === "exec_command" && input.cmd) {
        const cmd = input.workdir ? `cd ${input.workdir} && ${input.cmd}` : input.cmd;
        input = { command: cmd };
      }
      let mappedName = name;
      if (name === "exec_command") mappedName = "Bash";
      if (name === "apply_patch") {
        const parsed = parseCodexPatch(item.arguments ?? input.raw ?? "");
        mappedName = parsed.isNew ? "Write" : "Edit";
        input = parsed;
      } else if (name === "exec" || name === "functions.exec") {
        const raw = typeof input.raw === "string" ? input.raw : item.arguments ?? "";
        const execPatch = extractPatchFromExecInput(raw);
        if (execPatch) {
          const parsed = parseCodexPatch(execPatch);
          mappedName = parsed.isNew ? "Write" : "Edit";
          input = parsed;
        } else {
          const commands = extractExecCommands(raw);
          if (commands.length) { mappedName = "Bash"; input = { command: commands.join("\n\n"), commands }; }
          else if (/tools\.write_stdin\s*\(/.test(raw)) { mappedName = "Process"; input = { action: "Continue running process" }; }
          else if (/tools\.wait\s*\(/.test(raw)) { mappedName = "Wait"; input = { action: "Wait for running task" }; }
          else { mappedName = "Command"; input = { action: raw.replace(/\s+/g, " ").trim() }; }
        }
      } else if (name === "wait") {
        mappedName = "Wait"; input = { action: "Wait for running task" };
      } else if (name === "write_stdin") {
        mappedName = "Process"; input = { action: "Continue running process" };
      }
      blocks.push({
        kind: "tool_use", text: "",
        tool_call: {
          tool_use_id: item.id ?? "", name: mappedName, input,
          result: (item.output ?? "").trim() || null,
          resultTimestamp: ts, is_error: item.status === "failed",
        },
        timestamp: ts,
      });
    } else if (itemType === "message" && (item.role === "user")) {
      const content = item.content ?? [];
      if (Array.isArray(content)) {
        const textParts = content.filter((b) => b.type === "input_text").map((b) => b.text ?? "");
        userText = extractCodexUserText(textParts.join("\n"));
      }
    }
  }

  if (!blocks.length) return [];
  return [{ index: 1, user_text: userText || "Task", blocks, timestamp: timestamp || "" }];
}

/**
 * Parse Codex CLI JSONL text into Turn[].
 */
export function parse(text) {
  const events = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try { events.push(JSON.parse(trimmed)); } catch { continue; }
  }

  // Detect newer item-based format
  const isNewFormat = events.some((e) => e.type === "thread.started" || e.type === "item.completed");
  if (isNewFormat) return filterEmptyTurns(parseNewFormat(events));

  const turns = [];
  let turnIndex = 0;
  let currentUserText = "";
  let currentTimestamp = "";
  let currentBlocks = [];
  let pendingCalls = new Map();
  let inTurn = false;

  for (const evt of events) {
    const type = evt.type;
    const payload = evt.payload ?? {};
    const ts = evt.timestamp ?? null;

    if (type === "event_msg" && payload.type === "task_started") {
      inTurn = true;
      currentUserText = "";
      currentTimestamp = ts ?? "";
      currentBlocks = [];
      pendingCalls = new Map();
      continue;
    }

    if (type === "event_msg" && payload.type === "task_complete") {
      if (inTurn) {
        turnIndex++;
        turns.push({ index: turnIndex, user_text: currentUserText, blocks: currentBlocks, timestamp: currentTimestamp });
      }
      inTurn = false;
      continue;
    }

    if (!inTurn) continue;

    if (type === "event_msg" && payload.type === "user_message") {
      const msg = payload.message ?? "";
      currentUserText = extractCodexUserText(msg);
      if (ts) currentTimestamp = ts;
      continue;
    }

    if (type === "response_item") {
      const ptype = payload.type;
      const role = payload.role ?? "";
      const phase = payload.phase ?? "";

      if (ptype === "message" && role === "user") {
        const content = payload.content ?? [];
        if (Array.isArray(content)) {
          const textParts = content.filter((b) => b.type === "input_text").map((b) => b.text ?? "");
          const raw = textParts.join("\n");
          const extracted = extractCodexUserText(raw);
          if (extracted && !currentUserText) currentUserText = extracted;
        }
        continue;
      }

      if (ptype === "message" && role === "developer") continue;

      if (ptype === "message" && role === "assistant") {
        const content = payload.content ?? [];
        const textParts = [];
        if (Array.isArray(content)) {
          for (const b of content) {
            if (b.type === "output_text") textParts.push(b.text ?? "");
          }
        }
        const blockText = textParts.join("\n").trim();
        if (!blockText) continue;
        const kind = phase === "commentary" ? "thinking" : "text";
        currentBlocks.push({ kind, text: blockText, tool_call: null, timestamp: ts });
        continue;
      }

      if (ptype === "reasoning") continue;

      if (ptype === "function_call") {
        const callId = payload.call_id ?? "";
        const fnName = payload.name ?? "unknown";
        let input = {};
        try { input = JSON.parse(payload.arguments ?? "{}"); } catch { input = { raw: payload.arguments }; }
        if (fnName === "exec_command" && input.cmd) {
          const cmd = input.workdir ? `cd ${input.workdir} && ${input.cmd}` : input.cmd;
          input = { command: cmd };
        }
        let mappedName = fnName === "exec_command" ? "Bash" : fnName;
        if (fnName === "exec" || fnName === "functions.exec") {
          const raw = typeof input.raw === "string" ? input.raw : payload.arguments ?? "";
          const execPatch = extractPatchFromExecInput(raw);
          if (execPatch) {
            const parsed = parseCodexPatch(execPatch);
            mappedName = parsed.isNew ? "Write" : "Edit";
            input = parsed;
          } else {
            const commands = extractExecCommands(raw);
            if (commands.length) { mappedName = "Bash"; input = { command: commands.join("\n\n"), commands }; }
            else if (/tools\.write_stdin\s*\(/.test(raw)) { mappedName = "Process"; input = { action: "Continue running process" }; }
            else if (/tools\.wait\s*\(/.test(raw)) { mappedName = "Wait"; input = { action: "Wait for running task" }; }
            else { mappedName = "Command"; input = { action: raw.replace(/\s+/g, " ").trim() }; }
          }
        } else if (fnName === "wait") {
          mappedName = "Wait"; input = { action: "Wait for running task" };
        } else if (fnName === "write_stdin") {
          mappedName = "Process"; input = { action: "Continue running process" };
        }
        const toolCall = {
          tool_use_id: callId,
          name: mappedName,
          input, result: null, resultTimestamp: null, is_error: false,
        };
        currentBlocks.push({ kind: "tool_use", text: "", tool_call: toolCall, timestamp: ts });
        pendingCalls.set(callId, toolCall);
        continue;
      }

      if (ptype === "function_call_output") {
        const callId = payload.call_id ?? "";
        const output = normalizeToolOutput(payload.output);
        const cleaned = output.replace(/^Chunk ID:.*\n?/m, "")
          .replace(/^Wall time:.*\n?/m, "")
          .replace(/^Process exited with code \d+\n?/m, "")
          .replace(/^Original token count:.*\n?/m, "")
          .replace(/^Output:\n?/m, "")
          .trim();
        if (pendingCalls.has(callId)) {
          const tc = pendingCalls.get(callId);
          tc.result = cleaned;
          tc.resultTimestamp = ts;
          tc.is_error = output.includes("Process exited with code") && !output.includes("code 0");
          pendingCalls.delete(callId);
        }
        continue;
      }

      if (ptype === "custom_tool_call") {
        const callId = payload.call_id ?? "";
        const toolName = payload.name ?? "unknown";
        let mappedName = toolName;
        let input;
        const execPatch = extractPatchFromExecInput(payload.input);
        if (toolName === "apply_patch" || execPatch) {
          const parsed = parseCodexPatch(execPatch ?? payload.input ?? "");
          mappedName = parsed.isNew ? "Write" : "Edit";
          input = parsed;
        } else if (toolName === "exec" || toolName === "functions.exec") {
          const raw = payload.input ?? "";
          const commands = extractExecCommands(raw);
          if (commands.length) {
            mappedName = "Bash";
            input = { command: commands.join("\n\n"), commands };
          } else if (/tools\.write_stdin\s*\(/.test(raw)) {
            mappedName = "Process";
            input = { action: "Continue running process" };
          } else if (/tools\.wait\s*\(/.test(raw)) {
            mappedName = "Wait";
            input = { action: "Wait for running task" };
          } else {
            mappedName = "Command";
            input = { action: raw.replace(/\s+/g, " ").trim() };
          }
        } else if (toolName === "wait") {
          mappedName = "Wait";
          input = { action: "Wait for running task" };
        } else if (toolName === "write_stdin") {
          mappedName = "Process";
          input = { action: "Continue running process" };
        } else {
          input = { raw: payload.input ?? "" };
        }
        const toolCall = {
          tool_use_id: callId, name: mappedName, input,
          result: null, resultTimestamp: null, is_error: false,
        };
        currentBlocks.push({ kind: "tool_use", text: "", tool_call: toolCall, timestamp: ts });
        pendingCalls.set(callId, toolCall);
        continue;
      }

      if (ptype === "custom_tool_call_output") {
        const callId = payload.call_id ?? "";
        const output = normalizeToolOutput(payload.output);
        if (pendingCalls.has(callId)) {
          const tc = pendingCalls.get(callId);
          tc.result = output.trim();
          tc.resultTimestamp = ts;
          tc.is_error = typeof payload.output === "object" && payload.output?.metadata?.exit_code !== 0;
          pendingCalls.delete(callId);
        }
        continue;
      }
    }
  }

  // Handle session ending without task_complete
  if (inTurn && (currentUserText || currentBlocks.length)) {
    turnIndex++;
    turns.push({ index: turnIndex, user_text: currentUserText, blocks: currentBlocks, timestamp: currentTimestamp });
  }

  return filterEmptyTurns(turns);
}
