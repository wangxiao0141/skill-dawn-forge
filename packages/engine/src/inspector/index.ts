import { spawnSync } from "node:child_process";
import { TextDecoder } from "node:util";

import { ExitCode } from "../protocol/index.ts";

export interface InspectorSnapshot {
  readonly platform: "macos";
  readonly remoteUser: string;
  readonly freeDiskBytes: number;
  readonly homebrew: {
    readonly installed: boolean;
    readonly version?: string;
    readonly formulae: readonly string[];
    readonly casks: readonly string[];
  };
  readonly git: {
    readonly installed: boolean;
    readonly version?: string;
    readonly userName?: string;
    readonly userEmail?: string;
  };
}

export interface InspectorConnection {
  readonly configPath: string;
  readonly alias: string;
}

export interface InspectorSshExecutor {
  run(
    configPath: string,
    alias: string,
    command: string,
  ): Promise<{
    readonly stdout: string;
    readonly stderr: string;
    readonly exitCode: number;
  }>;
}

export class InspectorError extends Error {
  readonly exitCode = ExitCode.ActionFailed;

  constructor(message: string) {
    super(message);
    this.name = "InspectorError";
  }
}

export const macosInspectorCommand = [
  "set -e",
  "printf '%s\\n' __DAWN_FORGE_INSPECTOR_V1__",
  "id -un",
  "df -Pk \"$HOME\" | awk 'NR==2 { print $4 }'",
  'BREW="$(command -v brew || true)"',
  '[ -n "$BREW" ] || [ ! -x /opt/homebrew/bin/brew ] || BREW=/opt/homebrew/bin/brew',
  '[ -n "$BREW" ] || [ ! -x /usr/local/bin/brew ] || BREW=/usr/local/bin/brew',
  'if [ -n "$BREW" ]; then printf \'%s\\n\' BREW:1; "$BREW" --version | head -n 1; "$BREW" list --formula; printf \'%s\\n\' __CASKS__; "$BREW" list --cask; else printf \'%s\\n\\n%s\\n\' BREW:0 __CASKS__; fi',
  "printf '%s\\n' __GIT__",
  'if command -v git >/dev/null 2>&1; then printf \'%s\\n\' GIT:1; git --version; else printf \'%s\\n\\n\' GIT:0; fi',
  "printf '%s\\n' __GIT_NAME__",
  'if command -v git >/dev/null 2>&1; then GIT_NAME="$(git config --global --get user.name 2>/dev/null || true)"; printf \'%s\' "$GIT_NAME" | base64 | tr -d \'\\n\'; fi; printf \'\\n\'',
  "printf '%s\\n' __GIT_EMAIL__",
  'if command -v git >/dev/null 2>&1; then GIT_EMAIL="$(git config --global --get user.email 2>/dev/null || true)"; printf \'%s\' "$GIT_EMAIL" | base64 | tr -d \'\\n\'; fi; printf \'\\n\'',
].join("; ");

function decodeInspectorBase64(value: string): string {
  if (value === "") {
    return "";
  }
  if (
    value.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      value,
    )
  ) {
    throw new InspectorError("macOS Inspector 返回了无效 Git identity。");
  }
  const decoded = Buffer.from(value, "base64");
  if (decoded.toString("base64") !== value) {
    throw new InspectorError("macOS Inspector 返回了无效 Git identity。");
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(decoded);
  } catch {
    throw new InspectorError("macOS Inspector 返回了无效 Git identity。");
  }
}

export class NodeInspectorSshExecutor implements InspectorSshExecutor {
  readonly #ssh: string;

  constructor(ssh = process.env.DAWN_SSH ?? "ssh") {
    this.#ssh = ssh;
  }

  async run(
    configPath: string,
    alias: string,
    command: string,
  ): Promise<{
    stdout: string;
    stderr: string;
    exitCode: number;
  }> {
    const result = spawnSync(
      this.#ssh,
      ["-F", configPath, alias, command],
      {
        encoding: "utf8",
        timeout: 30_000,
        windowsHide: true,
      },
    );
    return {
      stdout: result.stdout ?? "",
      stderr: result.stderr || result.error?.message || "",
      exitCode: result.status ?? 1,
    };
  }
}

export async function inspectMacos(
  connection: InspectorConnection,
  ssh: InspectorSshExecutor,
): Promise<InspectorSnapshot> {
  const result = await ssh.run(
    connection.configPath,
    connection.alias,
    macosInspectorCommand,
  );
  if (result.exitCode !== 0) {
    throw new InspectorError(
      result.stderr.trim() ||
        `macOS Inspector SSH 失败，退出码 ${result.exitCode}。`,
    );
  }
  const lines = result.stdout.replaceAll("\r", "").split("\n");
  const caskMarker = lines.indexOf("__CASKS__");
  const gitMarker = lines.indexOf("__GIT__");
  const gitNameMarker = lines.indexOf("__GIT_NAME__");
  const gitEmailMarker = lines.indexOf("__GIT_EMAIL__");
  if (
    lines[0] !== "__DAWN_FORGE_INSPECTOR_V1__" ||
    !lines[1] ||
    !/^[0-9]+$/.test(lines[2] ?? "") ||
    !/^BREW:[01]$/.test(lines[3] ?? "") ||
    caskMarker < 5 ||
    gitMarker <= caskMarker ||
    gitNameMarker <= gitMarker + 1 ||
    gitEmailMarker <= gitNameMarker ||
    !/^GIT:[01]$/.test(lines[gitMarker + 1] ?? "")
  ) {
    throw new InspectorError("macOS Inspector 返回了无效快照。");
  }
  const freeDiskKilobytes = Number.parseInt(lines[2], 10);
  const freeDiskBytes = freeDiskKilobytes * 1024;
  if (!Number.isSafeInteger(freeDiskBytes)) {
    throw new InspectorError("macOS Inspector 磁盘空间超出安全整数范围。");
  }
  const homebrewInstalled = lines[3] === "BREW:1";
  const homebrewVersion = lines[4]?.trim();
  const formulae = homebrewInstalled
    ? [...new Set(lines.slice(5, caskMarker).filter(Boolean))].sort()
    : [];
  const casks = homebrewInstalled
    ? [...new Set(lines.slice(caskMarker + 1, gitMarker).filter(Boolean))].sort()
    : [];
  const gitInstalled = lines[gitMarker + 1] === "GIT:1";
  const gitOutput = lines[gitMarker + 2]?.trim() ?? "";
  const gitVersion = gitOutput.match(/^git version (.+)$/)?.[1];
  const gitUserName = decodeInspectorBase64(lines
    .slice(gitNameMarker + 1, gitEmailMarker)
    .join("\n")
    .trimEnd());
  const gitUserEmail = decodeInspectorBase64(
    lines.slice(gitEmailMarker + 1).join("\n").trimEnd(),
  );
  if (
    (homebrewInstalled && !homebrewVersion) ||
    (!homebrewInstalled && (formulae.length > 0 || casks.length > 0)) ||
    (gitInstalled && !gitVersion)
  ) {
    throw new InspectorError("macOS Inspector 返回了不一致的快照。");
  }
  return {
    platform: "macos",
    remoteUser: lines[1],
    freeDiskBytes,
    homebrew: {
      installed: homebrewInstalled,
      ...(homebrewVersion ? { version: homebrewVersion } : {}),
      formulae,
      casks,
    },
    git: {
      installed: gitInstalled,
      ...(gitVersion ? { version: gitVersion } : {}),
      ...(gitUserName ? { userName: gitUserName } : {}),
      ...(gitUserEmail ? { userEmail: gitUserEmail } : {}),
    },
  };
}
