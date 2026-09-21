/**
 * @file OpenInVSCodeButton.test.tsx
 * @description Covers the "open session in VS Code" link builder, the
 * openable-session rules, the embedded-webview relay handshake, and the
 * button's rendering and click isolation.
 * @author Son Nguyen <hoangson091104@gmail.com>
 */

import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { OpenInVSCodeButton } from "../OpenInVSCodeButton";
import {
  canOpenInVSCode,
  requestOpenViaEmbedder,
  vscodeSessionUri,
  VSCODE_EXTENSION_ID,
} from "../../lib/openInVSCode";

const ID = "5d27a6ad-bcaa-4392-be07-1b60fb33d8a5";
const local = { id: ID, provider: "claude" as const, source: "local", cwd: "/Users/dev/app" };

/**
 * A framed window whose parent answers relays the way the extension's
 * webview bridge does. `reply` controls what (if anything) comes back.
 */
function framedWindow(reply: (msg: { type: string; id: string }) => unknown) {
  const listeners = new Set<(e: MessageEvent) => void>();
  const parent = {
    postMessage: vi.fn((msg: { type: string; id: string }) => {
      const data = reply(msg);
      if (data === undefined) return;
      const src = (data as { __source?: unknown }).__source ?? parent;
      queueMicrotask(() => listeners.forEach((l) => l({ source: src, data } as MessageEvent)));
    }),
  };
  const win = {
    parent,
    addEventListener: (_: string, l: (e: MessageEvent) => void) => listeners.add(l),
    removeEventListener: (_: string, l: (e: MessageEvent) => void) => listeners.delete(l),
    setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
    clearTimeout: (h: ReturnType<typeof setTimeout>) => clearTimeout(h),
  };
  return { win: win as unknown as Window, parent, listeners };
}

describe("vscodeSessionUri", () => {
  it("targets the extension's open-session route", () => {
    expect(vscodeSessionUri(ID)).toBe(`vscode://${VSCODE_EXTENSION_ID}/open-session?id=${ID}`);
  });

  it("encodes the id so it cannot smuggle extra query parameters", () => {
    expect(vscodeSessionUri("a&cwd=/etc")).toContain("id=a%26cwd%3D%2Fetc");
  });
});

describe("canOpenInVSCode", () => {
  it("allows a local Claude session with a folder", () => {
    expect(canOpenInVSCode(local)).toBe(true);
  });

  it("treats a missing source as local (older rows)", () => {
    expect(canOpenInVSCode({ ...local, source: undefined })).toBe(true);
  });

  it("rejects Codex sessions", () => {
    expect(canOpenInVSCode({ ...local, provider: "codex" })).toBe(false);
  });

  it("rejects sessions collected from another machine", () => {
    expect(canOpenInVSCode({ ...local, source: "ssh-devbox" })).toBe(false);
  });

  it("rejects sessions with no recorded folder", () => {
    expect(canOpenInVSCode({ ...local, cwd: null })).toBe(false);
  });
});

describe("requestOpenViaEmbedder", () => {
  it("resolves false immediately when not framed", async () => {
    const top = { parent: null } as unknown as Window;
    (top as unknown as { parent: Window }).parent = top;
    await expect(requestOpenViaEmbedder(ID, top)).resolves.toBe(false);
  });

  it("relays the id and resolves true on the bridge's ack", async () => {
    const { win, parent, listeners } = framedWindow((m) => ({
      type: "ccam:openClaudeSession:ack",
      id: m.id,
    }));
    await expect(requestOpenViaEmbedder(ID, win, 200)).resolves.toBe(true);
    expect(parent.postMessage).toHaveBeenCalledWith(
      { type: "ccam:openClaudeSession", id: ID },
      "*"
    );
    expect(listeners.size).toBe(0); // listener cleaned up
  });

  it("times out to false when nothing answers (older extension)", async () => {
    const { win, listeners } = framedWindow(() => undefined);
    await expect(requestOpenViaEmbedder(ID, win, 30)).resolves.toBe(false);
    expect(listeners.size).toBe(0);
  });

  it("ignores an ack for a different session", async () => {
    const { win } = framedWindow(() => ({ type: "ccam:openClaudeSession:ack", id: "other" }));
    await expect(requestOpenViaEmbedder(ID, win, 30)).resolves.toBe(false);
  });

  it("ignores an ack that does not come from the parent frame", async () => {
    const { win } = framedWindow((m) => ({
      type: "ccam:openClaudeSession:ack",
      id: m.id,
      __source: { not: "the parent" },
    }));
    await expect(requestOpenViaEmbedder(ID, win, 30)).resolves.toBe(false);
  });
});

describe("OpenInVSCodeButton", () => {
  it("renders a vscode:// link for an openable session", () => {
    render(<OpenInVSCodeButton session={local} />);
    const link = screen.getByRole("link", {
      name: "Open this session in Claude Code inside VS Code",
    });
    expect(link).toHaveAttribute("href", vscodeSessionUri(ID));
    expect(link).toHaveTextContent("VS Code");
  });

  it("uses the longer label as a header button", () => {
    render(<OpenInVSCodeButton session={local} variant="button" />);
    expect(screen.getByRole("link")).toHaveTextContent("Open in VS Code");
  });

  it.each([
    ["Codex", { ...local, provider: "codex" as const }],
    ["remote", { ...local, source: "ssh-devbox" }],
    ["folderless", { ...local, cwd: null }],
  ])("renders nothing for a %s session", (_, session) => {
    const { container } = render(<OpenInVSCodeButton session={session} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("does not trigger the row's own click (navigation to detail)", () => {
    const onRowClick = vi.fn();
    render(
      <div onClick={onRowClick}>
        <OpenInVSCodeButton session={local} />
      </div>
    );
    fireEvent.click(screen.getByRole("link"));
    expect(onRowClick).not.toHaveBeenCalled();
  });
});
