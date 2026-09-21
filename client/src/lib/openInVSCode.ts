/**
 * @file openInVSCode.ts
 * @description Opens a dashboard session in Claude Code inside VS Code.
 *
 * Two routes, chosen per click:
 * - **Browser tab:** follow a `vscode://` link. The Agent Monitor VS Code
 *   extension's URI handler receives it, looks the session up in this
 *   dashboard, and opens it in the window that owns the session's folder.
 * - **Embedded in the extension's dashboard tab:** the page is a cross-origin
 *   iframe inside a VS Code webview, where `vscode://` navigation is not a
 *   reliable way out. Instead we ask the host webview to relay the request and
 *   wait briefly for an ack, falling back to the link if none arrives.
 *
 * Only the session id travels in either route. The extension resolves the
 * folder from the dashboard's own record, so a crafted link cannot point it at
 * an arbitrary path.
 * @author Son Nguyen <hoangson091104@gmail.com>
 */

import type { Session } from "./types";

/** Marketplace id of the companion extension that owns the `vscode://` route. */
export const VSCODE_EXTENSION_ID = "hoangsonw.claude-code-agent-monitor";

/** How long to wait for the VS Code webview bridge to acknowledge a relay. */
export const EMBED_ACK_TIMEOUT_MS = 400;

const RELAY_TYPE = "ccam:openClaudeSession";
const ACK_TYPE = "ccam:openClaudeSession:ack";

/** Deep link handled by the extension's URI handler. */
export function vscodeSessionUri(sessionId: string): string {
  return `vscode://${VSCODE_EXTENSION_ID}/open-session?id=${encodeURIComponent(sessionId)}`;
}

/**
 * Only local Claude sessions with a known folder can be opened: Codex sessions
 * are not Claude conversations, and remote-source sessions live on another
 * machine's disk.
 */
export function canOpenInVSCode(session: Pick<Session, "provider" | "source" | "cwd">): boolean {
  return (
    session.provider !== "codex" && (!session.source || session.source === "local") && !!session.cwd
  );
}

/** True when this page is framed — e.g. inside the extension's dashboard tab. */
export function isEmbedded(win: Window = window): boolean {
  try {
    return win.parent !== win;
  } catch {
    return true; // cross-origin access threw, which only happens when framed
  }
}

/**
 * Ask the embedding VS Code webview to open the session. Resolves `true` once
 * the bridge acknowledges, `false` if nothing answers (not embedded by the
 * extension, or an older extension without the bridge).
 */
export function requestOpenViaEmbedder(
  sessionId: string,
  win: Window = window,
  timeoutMs: number = EMBED_ACK_TIMEOUT_MS
): Promise<boolean> {
  if (!isEmbedded(win)) return Promise.resolve(false);
  return new Promise((resolve) => {
    const finish = (result: boolean) => {
      win.clearTimeout(timer);
      win.removeEventListener("message", onMessage);
      resolve(result);
    };
    const onMessage = (e: MessageEvent) => {
      const data = e.data as { type?: unknown; id?: unknown } | null;
      if (e.source === win.parent && data?.type === ACK_TYPE && data.id === sessionId) {
        finish(true);
      }
    };
    const timer = win.setTimeout(() => finish(false), timeoutMs);
    win.addEventListener("message", onMessage);
    // The webview's origin is an opaque vscode-webview:// value we can't know
    // ahead of time; the payload is only a session id, which is not secret.
    win.parent.postMessage({ type: RELAY_TYPE, id: sessionId }, "*");
  });
}
