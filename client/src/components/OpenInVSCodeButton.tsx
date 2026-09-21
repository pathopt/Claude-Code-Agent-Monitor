/**
 * @file OpenInVSCodeButton.tsx
 * @description "Open in VS Code" control for a session: a real `vscode://`
 * link in a browser tab, relayed through the host webview when the dashboard
 * is embedded in the VS Code extension. Renders nothing for sessions that
 * can't be opened (Codex, remote-source, or no recorded folder).
 * @author Son Nguyen <hoangson091104@gmail.com>
 */

import type { MouseEvent } from "react";
import { useTranslation } from "react-i18next";
import { SquareArrowOutUpRight } from "lucide-react";
import type { Session } from "../lib/types";
import {
  canOpenInVSCode,
  isEmbedded,
  requestOpenViaEmbedder,
  vscodeSessionUri,
} from "../lib/openInVSCode";

interface OpenInVSCodeButtonProps {
  session: Pick<Session, "id" | "provider" | "source" | "cwd">;
  /** `pill` sits beside badges in a table row; `button` is a header action. */
  variant?: "pill" | "button";
}

export function OpenInVSCodeButton({ session, variant = "pill" }: OpenInVSCodeButtonProps) {
  const { t } = useTranslation("sessions");
  if (!canOpenInVSCode(session)) return null;

  const href = vscodeSessionUri(session.id);

  function handleClick(e: MouseEvent<HTMLAnchorElement>) {
    // Rows and cards navigate to session detail on click.
    e.stopPropagation();
    if (!isEmbedded()) return; // let the browser follow the vscode:// link
    e.preventDefault();
    void requestOpenViaEmbedder(session.id).then((relayed) => {
      if (!relayed) window.location.href = href;
    });
  }

  const className =
    variant === "pill"
      ? "inline-flex items-center gap-1 text-[10px] font-semibold text-violet-300 bg-violet-500/10 border border-violet-500/25 hover:bg-violet-500/20 hover:text-violet-200 px-1.5 py-0.5 rounded-full transition-colors"
      : "btn-ghost";

  return (
    <a
      href={href}
      onClick={handleClick}
      className={className}
      title={t("openInVSCodeTitle")}
      aria-label={t("openInVSCodeTitle")}
    >
      <SquareArrowOutUpRight className={variant === "pill" ? "w-2.5 h-2.5" : "w-4 h-4"} />
      {variant === "pill" ? t("openInVSCodeShort") : t("openInVSCode")}
    </a>
  );
}
