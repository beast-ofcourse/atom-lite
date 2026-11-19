import { spawn } from "node:child_process";
import { statSync } from "node:fs";
import { homedir } from "node:os";

export class FolderPickerUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FolderPickerUnavailable";
  }
}

export interface FolderPickerCommand {
  command: string;
  args: string[];
}

const TITLE = "Select the Atom-lite workspace";

const WINDOWS_SCRIPT = [
  "Add-Type -AssemblyName System.Windows.Forms | Out-Null",
  "$dialog = New-Object System.Windows.Forms.FolderBrowserDialog",
  `$dialog.Description = '${TITLE}'`,
  "$dialog.UseDescriptionForTitle = $true",
  "if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {",
  "  [Console]::Out.Write($dialog.SelectedPath)",
  "}",
].join("; ");

export function isAndroid(
  platform: string = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return platform === "android" || Boolean(env.TERMUX_VERSION);
}

/** Native folder-picker commands for one platform, in preference order. */
export function folderPickerCommands(
  platform: string = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): FolderPickerCommand[] {
  if (platform === "darwin") {
    return [
      {
        command: "osascript",
        args: ["-e", `POSIX path of (choose folder with prompt "${TITLE}")`],
      },
    ];
  }
  if (platform === "win32") {
    return [
      {
        command: "powershell.exe",
        args: ["-NoProfile", "-STA", "-Command", WINDOWS_SCRIPT],
      },
      {
        command: "pwsh",
        args: ["-NoProfile", "-STA", "-Command", WINDOWS_SCRIPT],
      },
    ];
  }
  if (isAndroid(platform, env)) {
    return [{ command: "termux-saf-managedir", args: [] }];
  }
  return [
    {
      command: "zenity",
      args: ["--file-selection", "--directory", `--title=${TITLE}`],
    },
    {
      command: "kdialog",
      args: ["--getexistingdirectory", homedir(), "--title", TITLE],
    },
    {
      command: "yad",
      args: ["--file", "--directory", `--title=${TITLE}`],
    },
  ];
}

/**
 * Map an Android SAF tree URI returned by Termux to a filesystem path.
 * Only shared-storage trees map to a path Node can read; app-private
 * document providers do not.
 */
export function androidTreeUriToPath(uri: string): string | null {
  const external = "content://com.android.externalstorage.documents/tree/";
  if (uri.startsWith(external)) {
    const decoded = decodeURIComponent(
      uri.slice(external.length).split("?")[0],
    );
    const colon = decoded.indexOf(":");
    if (colon < 0) return null;
    const volume = decoded.slice(0, colon);
    const rest = decoded.slice(colon + 1);
    if (volume === "primary") {
      return rest ? `/storage/emulated/0/${rest}` : "/storage/emulated/0";
    }
    return rest ? `/storage/${volume}/${rest}` : `/storage/${volume}`;
  }
  if (
    uri.startsWith(
      "content://com.android.providers.downloads.documents/tree/downloads",
    )
  ) {
    return "/storage/emulated/0/Download";
  }
  return null;
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function cancellation(stderr: string): boolean {
  return /user (?:canceled|cancelled)|-128/i.test(stderr);
}

interface RunResult {
  stdout: string;
  stderr: string;
  code: number | null;
  missing: boolean;
}

function run(command: string, args: string[]): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: string[] = [];
    const stderr: string[] = [];
    let settled = false;
    const finish = (result: RunResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish({
        stdout: "",
        stderr: "folder picker timed out",
        code: null,
        missing: false,
      });
    }, 10 * 60_000);
    timer.unref?.();

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => stdout.push(chunk));
    child.stderr?.on("data", (chunk: string) => stderr.push(chunk));
    child.on("error", (error) => {
      finish({
        stdout: stdout.join(""),
        stderr: stderr.join("") || error.message,
        code: null,
        missing: (error as NodeJS.ErrnoException).code === "ENOENT",
      });
    });
    child.on("close", (code) => {
      finish({
        stdout: stdout.join(""),
        stderr: stderr.join(""),
        code,
        missing: false,
      });
    });
  });
}

/**
 * Open the platform's native folder picker. Returns the selected directory,
 * or null when the user cancels. Throws when no picker is available or the
 * selection cannot be used as a workspace.
 */
export async function pickNativeDirectory(
  options: { platform?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<string | null> {
  const commands = folderPickerCommands(options.platform, options.env);
  for (const [index, entry] of commands.entries()) {
    const result = await run(entry.command, entry.args);
    if (result.missing) {
      if (index === commands.length - 1) {
        throw new FolderPickerUnavailable(
          process.platform === "linux"
            ? "No native folder picker found. Install zenity or kdialog."
            : `Native folder picker unavailable: ${entry.command}`,
        );
      }
      continue;
    }
    if (result.code !== 0) {
      if (cancellation(result.stderr) || !result.stderr.trim()) return null;
      throw new FolderPickerUnavailable(
        result.stderr.trim() || `${entry.command} failed`,
      );
    }
    const raw = result.stdout.trim();
    if (!raw) return null;
    const path =
      entry.command === "termux-saf-managedir"
        ? androidTreeUriToPath(raw)
        : raw;
    if (!path) {
      throw new FolderPickerUnavailable(
        "Android returned a folder Termux cannot address as a filesystem path. Choose a folder under shared storage.",
      );
    }
    if (!isDirectory(path)) {
      throw new FolderPickerUnavailable(
        `The selected path is not a directory: ${path}`,
      );
    }
    return path;
  }
  return null;
}
