#!/usr/bin/env node
// Pi RPC broker for cc-pi-team.
// RPC spawn / steer / abort / terminal-event skeleton adapted from
// LarryStanley/pi-delegate src/dispatch.mjs (MIT, see ../vendor/pi-delegate/LICENSE).
//
// Usage: node pi-rpc.mjs <workspace> <sessionId> <taskFile> <claudeSessionId>
//
// Files in <workspace>:
//   .pi-events.jsonl        Pi session events + final delegate_done record
//   .pi-events.stderr.log   Pi stderr
//   .pi-bound               session file path (written once get_state answers)
//   .pi-done                completed | aborted | failed
//   .pi-rpc.sock            control socket: {"command":"steer","message":...} / {"command":"abort"}

import { spawn } from "node:child_process";
import { appendFileSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { createJsonlSplitter } from "../vendor/pi-delegate/jsonl.mjs";

const [WS, SID, TASK_FILE, CLAUDE_SID] = process.argv.slice(2);
if (!WS || !TASK_FILE || !CLAUDE_SID) {
  console.error("usage: pi-rpc.mjs <workspace> <sessionId|''> <taskFile> <claudeSessionId>");
  process.exit(1);
}

const ROOT = process.env.CLAUDE_PLUGIN_ROOT || fileURLToPath(new URL("..", import.meta.url));
const EVENTS = `${WS}/.pi-events.jsonl`;
const STDERR = `${WS}/.pi-events.stderr.log`;
const BOUND = `${WS}/.pi-bound`;
const DONE = `${WS}/.pi-done`;
const SOCK = `${WS}/.pi-rpc.sock`;

const task = readFileSync(`${WS}/${TASK_FILE}`, "utf8");
let aborted = false;
let failure = null;
let done = false;
let server = null;

// `--session <id>` resumes an existing session; omit it and Pi creates a fresh one.
// get_state below reports the real sessionFile either way.
const args = ["--mode", "rpc", "--approve"];
if (SID) args.push("--session", SID);
const child = spawn("pi", args, {
  cwd: WS,
  stdio: ["pipe", "pipe", "pipe"],
});

function send(obj) {
  if (child.stdin.writable) child.stdin.write(`${JSON.stringify(obj)}\n`);
}

function append(obj) {
  appendFileSync(EVENTS, `${JSON.stringify(obj)}\n`);
}

function bind(sessionFile) {
  const mapPath = `${ROOT}/pi-bindings.json`;
  let map = {};
  try { map = JSON.parse(readFileSync(mapPath, "utf8")); } catch { /* first bind */ }
  const listOf = (v) => (Array.isArray(v) ? v : v ? [v] : []);
  for (const [sid, files] of Object.entries(map)) {
    if (sid !== CLAUDE_SID && listOf(files).includes(sessionFile)) throw new Error(`already bound to ${sid}`);
  }
  const mine = listOf(map[CLAUDE_SID]);
  if (!mine.includes(sessionFile)) mine.push(sessionFile);
  map[CLAUDE_SID] = mine;
  const tmp = `${mapPath}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(map, null, 2)}\n`);
  renameSync(tmp, mapPath);
  writeFileSync(BOUND, `${sessionFile}\n`);
}

function cleanup() {
  try { if (server) server.close(); } catch { /* already closed */ }
  try { unlinkSync(SOCK); } catch { /* already gone */ }
}

// Single exit path: append delegate_done, write .pi-done, close the pipe, escalate to SIGKILL.
function finish(status, error) {
  if (done) return;
  done = true;
  try { append({ type: "delegate_done", status, aborted: status === "aborted", error: error || null }); } catch { /* disk gone */ }
  cleanup();
  try { child.stdin.end(); } catch { /* already closed */ }
  const writeDone = () => { try { writeFileSync(DONE, `${status}\n`); } catch { /* disk gone */ } };
  if (child.exitCode !== null || child.signalCode !== null) {
    writeDone();
    process.exit(0);
  }
  const hard = setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* already dead */ } }, 5000);
  child.once("exit", () => { clearTimeout(hard); writeDone(); process.exit(0); });
}

// Control channel.
try { unlinkSync(SOCK); } catch { /* stale socket */ }
server = createServer((sock) => {
  let buf = "";
  sock.setEncoding("utf8");
  sock.on("data", (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      let cmd;
      try { cmd = JSON.parse(line); } catch { continue; }
      if (cmd.command === "steer" && typeof cmd.message === "string") send({ type: "steer", message: cmd.message });
      if (cmd.command === "abort") { aborted = true; send({ type: "abort" }); }
    }
  });
  sock.on("error", () => { /* client vanished */ });
});
server.on("error", () => { /* socket unavailable; dispatch will time out */ });
server.listen(SOCK);

// Event stream. Do not use readline: U+2028/U+2029 are valid inside JSON strings.
const split = createJsonlSplitter();
child.stdout.setEncoding("utf8");
child.stdout.on("data", (chunk) => {
  for (const line of split(chunk)) {
    let ev;
    try { ev = JSON.parse(line); } catch { continue; }
    if (done) continue;
    append(ev);

    if (ev.type === "extension_ui_request") {
      // Dialog methods block Pi until answered; cancel them so the run cannot hang.
      if (ev.id && ["select", "confirm", "input", "editor"].includes(ev.method)) {
        send({ type: "extension_ui_response", id: ev.id, cancelled: true });
      }
      continue;
    }

    if (ev.type === "response" && ev.command === "get_state") {
      if (ev.success && ev.data?.sessionFile) {
        try {
          bind(ev.data.sessionFile);
        } catch (err) {
          failure = `bind failed: ${err.message}`;
          finish("failed", failure);
        }
      } else {
        failure = String(ev.error || "get_state returned no sessionFile");
        finish("failed", failure);
      }
      continue;
    }

    // Command-level failure.
    if (ev.type === "response" && ev.success === false) {
      failure = String(ev.error || `${ev.command} failed`);
      finish("failed", failure);
      continue;
    }

    // Provider/API failure: arrives as an assistant message, then a normal agent_end.
    if (ev.type === "message_end" && ev.message?.role === "assistant" && ev.message.stopReason === "error") {
      failure = ev.message.errorMessage || "pi reported stopReason=error";
      continue;
    }

    if (ev.type === "agent_settled") {
      const wasAborted = aborted || ev.aborted === true;
      finish(wasAborted ? "aborted" : failure ? "failed" : "completed", failure);
      continue;
    }

    // A new run means an error from the previous (retried) run is no longer final.
    if (ev.type === "agent_start") failure = null;
  }
});

child.stderr.setEncoding("utf8");
child.stderr.on("data", (chunk) => { try { appendFileSync(STDERR, chunk); } catch { /* disk gone */ } });
child.stdin.on("error", () => { /* child died mid-write */ });

send({ id: "state", type: "get_state" });
send({ id: "prompt", type: "prompt", message: task });

child.on("exit", () => {
  if (!done) finish(aborted ? "aborted" : "failed", failure || "pi exited before settling");
});
child.on("error", (err) => {
  failure = err.message;
  finish("failed", failure);
});

for (const sig of ["SIGTERM", "SIGINT"]) {
  process.on(sig, () => {
    aborted = true;
    if (done) return;
    send({ type: "abort" });
    try { child.stdin.end(); } catch { /* already closed */ }
    setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* already dead */ } }, 1500);
  });
}

process.on("exit", () => {
  if (!done) {
    try { writeFileSync(DONE, `${aborted ? "aborted" : "failed"}\n`); } catch { /* disk gone */ }
    try { child.kill("SIGKILL"); } catch { /* already dead */ }
  }
  cleanup();
});
