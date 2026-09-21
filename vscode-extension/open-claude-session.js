/**
 * @file Opens a dashboard session inside the official Claude Code VS Code
 * extension — in this window, or by switching to the window that owns the
 * session's folder.
 *
 * The dashboard stores `sessions.id` verbatim from the hook payload's
 * `data.session_id` (see server/routes/hooks.js), which is the same UUID the
 * Claude Code extension uses to identify a conversation. That makes a session
 * row directly addressable.
 *
 * IMPORTANT — `claude-vscode.editor.open` is an INTERNAL command of the
 * `anthropic.claude-code` extension, not a documented public API. It was
 * confirmed against extension version 2.1.278, where it is registered as:
 *
 *     registerCommand("claude-vscode.editor.open",
 *       async (sessionId, initialPrompt, viewColumn, _, fullEditor, opts) => ...)
 *
 * Anthropic may rename it or reorder its arguments in any release. Every call
 * is therefore wrapped, and a terminal `claude --resume <id>` fallback keeps
 * the feature working (at lower fidelity) if the command ever disappears.
 *
 * ## Cross-window handoff
 * The Claude Code extension resolves a session against the current window's
 * workspace, and one window cannot run a command in another. So when a
 * session belongs to a different folder we:
 *   1. write a small handoff file into this extension's global storage
 *      (one directory shared by every window), then
 *   2. ask VS Code to open that folder — it focuses the window that already
 *      has it open, or opens a new one.
 * Every window checks the handoff on activation (new window) and whenever it
 * gains focus (existing window). The window whose folders contain the
 * session's cwd claims it with an atomic rename, so exactly one window opens
 * it. Entries expire quickly so a stale click never resurfaces later.
 *
 * @author Son Nguyen <hoangson091104@gmail.com>
 */

const vscode = require("vscode");
const fs = require("fs");
const http = require("http");
const path = require("path");

/** Extension ID of the official Claude Code extension. */
const CLAUDE_EXTENSION_ID = "anthropic.claude-code";

/** Internal command that opens a specific conversation in an editor tab. */
const CLAUDE_OPEN_COMMAND = "claude-vscode.editor.open";

/** Where the rest of this extension already expects the dashboard API. */
const DASHBOARD_PORT = 4820;

const HANDOFF_FILE = "pending-open-session.json";

/**
 * Long enough for a cold VS Code window to start and activate extensions,
 * short enough that focusing a window minutes later never replays a click.
 */
const HANDOFF_TTL_MS = 45000;

/** Set once from `activate()`; null means handoff is unavailable. */
let storageDir = null;

/**
 * @param {{ storageDir: string }} opts `context.globalStorageUri.fsPath`
 */
function configure(opts) {
  storageDir = (opts && opts.storageDir) || null;
}

/**
 * Claude Code session IDs are UUIDs. We validate before use because the id is
 * interpolated into a shell command in the terminal fallback and into a URL
 * path for the dashboard lookup — a non-UUID must never reach either.
 *
 * @param {unknown} id
 * @returns {boolean}
 */
function isSessionId(id) {
  return typeof id === "string" && /^[0-9a-fA-F]{8}(-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$/.test(id);
}

/**
 * True when `cwd` is one of the open workspace folders or lives inside one.
 *
 * @param {string|null|undefined} cwd
 * @returns {boolean}
 */
function isCwdInThisWindow(cwd) {
  if (!cwd) return true; // Unknown cwd — assume current window and let the command try.
  const folders = vscode.workspace.workspaceFolders || [];
  if (folders.length === 0) return false;
  const target = path.resolve(cwd);
  return folders.some((f) => {
    const root = path.resolve(f.uri.fsPath);
    return target === root || target.startsWith(root + path.sep);
  });
}

/**
 * Last-resort path: resume the session in an integrated terminal. Lower
 * fidelity than a native chat tab, but it depends only on the `claude` CLI
 * rather than an internal command signature.
 *
 * @param {string} sessionId Validated UUID.
 * @param {string|null} cwd
 */
function resumeInTerminal(sessionId, cwd) {
  const terminal = vscode.window.createTerminal({
    name: `Claude · ${sessionId.slice(0, 8)}`,
    cwd: cwd || undefined,
  });
  terminal.show();
  terminal.sendText(`claude --resume ${sessionId}`);
}

function handoffPath() {
  return storageDir ? path.join(storageDir, HANDOFF_FILE) : null;
}

/**
 * Atomically publish a handoff for whichever window owns `cwd`. Last click
 * wins — a single slot is all a human clicking buttons needs.
 *
 * @returns {boolean} false when global storage is unavailable.
 */
function writeHandoff(sessionId, cwd) {
  const file = handoffPath();
  if (!file) return false;
  try {
    fs.mkdirSync(storageDir, { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ id: sessionId, cwd, at: Date.now() }));
    fs.renameSync(tmp, file);
    return true;
  } catch (_) {
    return false;
  }
}

/**
 * Read the pending handoff without consuming it. Expired or malformed entries
 * are deleted on sight; anything else is left for its owning window.
 *
 * @returns {{ id: string, cwd: string, at: number } | null}
 */
function peekHandoff(file) {
  let entry;
  try {
    entry = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    if (err && err.code !== "ENOENT") safeUnlink(file); // unreadable junk
    return null;
  }
  const valid =
    entry &&
    isSessionId(entry.id) &&
    typeof entry.cwd === "string" &&
    entry.cwd &&
    typeof entry.at === "number";
  if (!valid || Date.now() - entry.at > HANDOFF_TTL_MS) {
    safeUnlink(file);
    return null;
  }
  return entry;
}

function safeUnlink(file) {
  try {
    fs.unlinkSync(file);
  } catch (_) {}
}

/**
 * Open a pending handoff if it belongs to this window. Safe to call often —
 * it is a single small file read when there is nothing to do.
 *
 * @param {(msg: string) => void} [log]
 * @returns {Promise<boolean>} true when this window claimed and opened it.
 */
async function claimHandoff(log = () => {}) {
  const file = handoffPath();
  if (!file) return false;

  // Peek first so a window that does NOT own the session never consumes it.
  const entry = peekHandoff(file);
  if (!entry || !isCwdInThisWindow(entry.cwd)) return false;

  // Claim with an atomic rename: if two matching windows race (e.g. one has
  // ~/projects open, another ~/projects/app), only one rename succeeds.
  const claimed = `${file}.${process.pid}.claimed`;
  try {
    fs.renameSync(file, claimed);
  } catch (_) {
    return false; // another window won
  }
  safeUnlink(claimed);

  log(`handoff claimed: session ${entry.id} (cwd ${entry.cwd})`);
  await openInThisWindow(entry.id, entry.cwd, log);
  return true;
}

/**
 * Invoke Claude Code's open command here. Assumes the caller has already
 * established that this window owns the session's folder.
 */
async function openInThisWindow(sessionId, cwd, log) {
  const claude = vscode.extensions.getExtension(CLAUDE_EXTENSION_ID);
  if (!claude) {
    const choice = await vscode.window.showErrorMessage(
      "The Claude Code extension is not installed, so this session cannot be opened in a chat tab.",
      "Install Claude Code",
      "Resume in Terminal"
    );
    if (choice === "Install Claude Code") {
      await vscode.commands.executeCommand("workbench.extensions.search", CLAUDE_EXTENSION_ID);
    } else if (choice === "Resume in Terminal") {
      resumeInTerminal(sessionId, cwd);
    }
    return;
  }
  if (!claude.isActive) {
    log("Activating Claude Code extension…");
    await claude.activate();
  }

  try {
    log(`Invoking ${CLAUDE_OPEN_COMMAND} for session ${sessionId}`);
    await vscode.commands.executeCommand(CLAUDE_OPEN_COMMAND, sessionId);
    log(`${CLAUDE_OPEN_COMMAND} returned without error`);
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    log(`${CLAUDE_OPEN_COMMAND} failed: ${message}`);
    const choice = await vscode.window.showWarningMessage(
      "Couldn't open that session in a Claude Code tab — the extension's internal command may have changed.",
      "Resume in Terminal"
    );
    if (choice === "Resume in Terminal") resumeInTerminal(sessionId, cwd);
  }
}

/**
 * Hand the session to the window that owns `cwd`, opening it if needed.
 */
async function switchToFolder(sessionId, cwd, log) {
  if (!fs.existsSync(cwd)) {
    vscode.window.showErrorMessage(
      `Can't open this session: its folder no longer exists (${cwd}).`
    );
    return;
  }
  if (!writeHandoff(sessionId, cwd)) {
    // No shared storage — we can still get the user to the session.
    const choice = await vscode.window.showWarningMessage(
      `This session belongs to ${cwd}, and it couldn't be handed to that window.`,
      "Resume in Terminal"
    );
    if (choice === "Resume in Terminal") resumeInTerminal(sessionId, cwd);
    return;
  }

  // An empty window has nothing to lose, so reuse it. Otherwise ask for a new
  // window — VS Code focuses an existing window that already has the folder
  // open instead of duplicating it, which is exactly "switch to".
  const reuse = (vscode.workspace.workspaceFolders || []).length === 0;
  log(`handoff written; opening ${cwd} (${reuse ? "this window" : "new/existing window"})`);
  await vscode.commands.executeCommand("vscode.openFolder", vscode.Uri.file(cwd), {
    forceNewWindow: !reuse,
  });
}

/**
 * Open a dashboard session in Claude Code, switching windows if the session
 * belongs to a folder this window doesn't have open.
 *
 * @param {{ id: string, cwd?: string|null }} session
 * @param {(msg: string) => void} [log] Optional logger (the extension's output channel).
 * @returns {Promise<void>}
 */
async function openSessionInClaudeCode(session, log = () => {}) {
  const sessionId = session && session.id;
  const cwd = (session && session.cwd) || null;

  if (!isSessionId(sessionId)) {
    log(`openSessionInClaudeCode: refusing malformed session id ${JSON.stringify(sessionId)}`);
    vscode.window.showErrorMessage("Claude Code Agent Monitor: that session has no usable ID.");
    return;
  }

  if (cwd && !isCwdInThisWindow(cwd)) {
    await switchToFolder(sessionId, cwd, log);
    return;
  }
  await openInThisWindow(sessionId, cwd, log);
}

/**
 * Fetch one session's row from the local dashboard.
 *
 * @returns {Promise<{ status: number, session?: object }>}
 */
function fetchSession(sessionId) {
  return new Promise((resolve) => {
    const req = http.get(
      {
        hostname: "localhost",
        port: DASHBOARD_PORT,
        path: `/api/sessions/${encodeURIComponent(sessionId)}`,
        timeout: 3000,
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (body += c));
        res.on("end", () => {
          try {
            const parsed = JSON.parse(body);
            resolve({ status: res.statusCode, session: parsed && parsed.session });
          } catch (_) {
            resolve({ status: res.statusCode || 0 });
          }
        });
      }
    );
    req.on("timeout", () => req.destroy());
    req.on("error", () => resolve({ status: 0 }));
  });
}

/**
 * Entry point for callers that only know a session ID — browser deep links
 * and the embedded dashboard. The cwd is looked up from the dashboard rather
 * than accepted from the caller, so a crafted `vscode://` link can never make
 * this extension open an arbitrary folder: only folders the dashboard itself
 * recorded for a real session are reachable.
 *
 * @param {string} sessionId
 * @param {(msg: string) => void} [log]
 */
async function openSessionById(sessionId, log = () => {}) {
  if (!isSessionId(sessionId)) {
    log(`openSessionById: refusing malformed session id ${JSON.stringify(sessionId)}`);
    vscode.window.showErrorMessage(
      "Claude Code Agent Monitor: that link has no usable session ID."
    );
    return;
  }
  const { status, session } = await fetchSession(sessionId);
  if (status === 0) {
    vscode.window.showErrorMessage(
      `Can't reach the Agent Monitor dashboard on localhost:${DASHBOARD_PORT} to look up that session.`
    );
    return;
  }
  if (status === 404 || !session) {
    vscode.window.showErrorMessage("That session isn't in the Agent Monitor dashboard.");
    return;
  }
  if (session.provider === "codex") {
    vscode.window.showInformationMessage(
      "That's a Codex session — only Claude Code sessions can be opened in Claude Code."
    );
    return;
  }
  if (session.source && session.source !== "local") {
    vscode.window.showInformationMessage(
      "That session was collected from another machine, so it can't be opened here."
    );
    return;
  }
  await openSessionInClaudeCode({ id: session.id, cwd: session.cwd || null }, log);
}

module.exports = {
  configure,
  openSessionInClaudeCode,
  openSessionById,
  claimHandoff,
  // Exported for tests.
  isSessionId,
  isCwdInThisWindow,
  writeHandoff,
  HANDOFF_TTL_MS,
  CLAUDE_EXTENSION_ID,
  CLAUDE_OPEN_COMMAND,
};
