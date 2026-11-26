import { spawn } from "node:child_process";

const ALLOWED_PROTOCOLS = new Set(["http:", "https:", "mailto:"]);

export function openerCommand(
  url: string,
  platform = process.platform,
): { command: string; args: string[] } | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) return undefined;
  if (platform === "win32") {
    // cmd /c start parses shell metacharacters in model-supplied URLs.
    return { command: "explorer.exe", args: [url] };
  }
  return {
    command: platform === "darwin" ? "open" : "xdg-open",
    args: [url],
  };
}

export function openUrl(url: string): void {
  const opener = openerCommand(url);
  if (!opener) return;
  try {
    const child = spawn(opener.command, opener.args, {
      stdio: "ignore",
      detached: true,
    });
    child.on("error", () => {});
    child.unref();
  } catch {
    // URL activation is best effort and must never interrupt the TUI.
  }
}
