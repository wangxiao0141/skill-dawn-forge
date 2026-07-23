#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir, hostname as systemHostname } from "node:os";
import { dirname, resolve } from "node:path";
import { isIP } from "node:net";
import { fileURLToPath } from "node:url";

const command = process.argv[2];
const options = parseOptions(process.argv.slice(3));
const defaultKey = resolve(homedir(), ".ssh", "id_ed25519");
const keyPath = expandPath(options.key ?? defaultKey);
const publicKeyPath = `${keyPath}.pub`;
const sshKeygen = options["ssh-keygen"] ?? "ssh-keygen";
const sshExecutable = options.ssh ?? "ssh";
const scriptPath = fileURLToPath(import.meta.url);
const controllerName = controllerIdentityName();

if (!command || options.help || !["key", "plan", "install-key"].includes(command)) {
  printUsage();
  process.exit(command && !options.help ? 2 : 0);
}

try {
  if (command === "key") {
    const result = inspectOrCreateKey(Boolean(options.create));
    printJson(result);
  } else if (command === "plan") {
    printJson(createPlan());
  } else {
    installKey();
  }
} catch (error) {
  console.error(error.message);
  process.exit(1);
}

function parseOptions(args) {
  const parsed = {};
  const flags = new Set(["create", "windows-admin", "help"]);

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (!token.startsWith("--")) throw new Error(`Unexpected argument: ${token}`);

    const name = token.slice(2);
    if (flags.has(name)) {
      parsed[name] = true;
      continue;
    }

    const value = args[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for --${name}`);
    parsed[name] = value;
    index += 1;
  }

  return parsed;
}

function expandPath(value) {
  if (value === "~") return homedir();
  if (value.startsWith("~/") || value.startsWith("~\\")) {
    return resolve(homedir(), value.slice(2));
  }
  return resolve(value);
}

function runKeygen(args) {
  const result = spawnSync(sshKeygen, args, {
    encoding: "utf8",
    windowsHide: true,
  });

  if (result.error) throw new Error(`Cannot run ssh-keygen: ${result.error.message}`);
  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || "ssh-keygen failed").trim());
  }

  return result.stdout.trim();
}

function fingerprint(path) {
  const output = runKeygen(["-lf", path]);
  const match = output.match(/\bSHA256:[A-Za-z0-9+/=]+\b/);
  if (!match) throw new Error(`Cannot parse fingerprint for ${path}`);
  return match[0];
}

function inspectOrCreateKey(create) {
  const privateExists = existsSync(keyPath);
  const publicExists = existsSync(publicKeyPath);

  if (!privateExists && !publicExists && !create) {
    return {
      exists: false,
      keyPath,
      publicKeyPath,
      next: "Run the same command with --create.",
    };
  }

  if (!privateExists && !publicExists) {
    mkdirSync(dirname(keyPath), { recursive: true, mode: 0o700 });
    runKeygen([
      "-t",
      "ed25519",
      "-f",
      keyPath,
      "-N",
      "",
      "-C",
      controllerName,
    ]);
  } else if (!privateExists || !publicExists) {
    throw new Error("The SSH key pair is incomplete; do not overwrite it.");
  }

  const publicLine = readFileSync(publicKeyPath, "utf8").trim();
  if (!publicLine.startsWith("ssh-ed25519 ")) {
    throw new Error("The default management key is not ED25519.");
  }

  const privateFingerprint = fingerprint(keyPath);
  const publicFingerprint = fingerprint(publicKeyPath);
  if (privateFingerprint !== publicFingerprint) {
    throw new Error("The private and public key fingerprints do not match.");
  }

  return {
    exists: true,
    created: !privateExists,
    keyPath,
    publicKeyPath,
    fingerprint: publicFingerprint,
    passphrase: "none",
  };
}

function createPlan() {
  const { platform, host, user } = targetOptions();
  const alias = requiredOption("alias");

  if (!/^[A-Za-z0-9._-]+$/.test(alias)) throw new Error("--alias contains unsupported characters.");

  const key = inspectOrCreateKey(true);
  const identityFile = portableIdentityFile(keyPath);

  return {
    platform,
    host,
    user,
    alias,
    controllerName,
    keyCreated: key.created,
    keyFingerprint: key.fingerprint,
    installKeyCommand: buildInstallKeyCommand(platform, host, user),
    verifyCommand:
      `ssh -o BatchMode=yes -o PasswordAuthentication=no ` +
      `-o KbdInteractiveAuthentication=no -o IdentitiesOnly=yes ` +
      `-o StrictHostKeyChecking=yes ` +
      `-i ${identityFile} ${user}@${host}`,
    sshConfigBlock: [
      `Host ${alias}`,
      `  HostName ${host}`,
      `  User ${user}`,
      `  IdentityFile ${identityFile}`,
      "  IdentitiesOnly yes",
    ].join("\n"),
  };
}

function installKey() {
  const key = inspectOrCreateKey(false);
  const { platform, host, user } = targetOptions();
  const managedKey = managedKeyPayload();
  const remoteCommand =
    platform === "macos"
      ? macosAuthorizeCommand(managedKey)
      : windowsRemoteCommand(
          windowsAuthorizeCommand(managedKey, Boolean(options["windows-admin"])),
        );

  const result = spawnSync(
    sshExecutable,
    [
      "-o",
      "PreferredAuthentications=password,keyboard-interactive",
      "-o",
      "PubkeyAuthentication=no",
      "-o",
      "StrictHostKeyChecking=accept-new",
      "-o",
      "NumberOfPasswordPrompts=1",
      `${user}@${host}`,
      remoteCommand,
    ],
    {
      stdio: "inherit",
      windowsHide: false,
    },
  );

  if (result.error) throw new Error(`Cannot run ssh: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`SSH key installation failed with exit code ${result.status}.`);

  printJson({
    installed: true,
    platform,
    host,
    user,
    controllerName,
    keyFingerprint: key.fingerprint,
  });
}

function targetOptions() {
  const platform = requiredOption("platform");
  const host = requiredOption("host");
  const user = requiredOption("user");

  if (!["macos", "windows"].includes(platform)) {
    throw new Error("--platform must be macos or windows.");
  }
  if (!validHost(host)) throw new Error("--host must be a LAN hostname or IP address.");
  if (!/^[A-Za-z0-9._-]+$/.test(user)) throw new Error("--user contains unsupported characters.");

  return { platform, host, user };
}

function managedKeyPayload() {
  const publicLine = readFileSync(publicKeyPath, "utf8").trim();
  const [type, blob] = publicLine.split(/\s+/, 2);
  const managedLine = [
    "no-agent-forwarding,no-port-forwarding,no-X11-forwarding",
    type,
    blob,
    controllerName,
  ].join(" ");

  return {
    encodedLine: Buffer.from(managedLine, "utf8").toString("base64"),
    blob,
  };
}

function buildInstallKeyCommand(platform, host, user) {
  const parts = [
    "node",
    quoteForUserShell(scriptPath),
    "install-key",
    "--platform",
    platform,
    "--host",
    host,
    "--user",
    user,
    "--controller-name",
    quoteForUserShell(controllerName),
  ];

  if (options["windows-admin"]) parts.push("--windows-admin");
  if (keyPath !== defaultKey) parts.push("--key", quoteForUserShell(keyPath));
  if (options.ssh) parts.push("--ssh", quoteForUserShell(options.ssh));
  if (options["ssh-keygen"]) {
    parts.push("--ssh-keygen", quoteForUserShell(options["ssh-keygen"]));
  }

  return parts.join(" ");
}

function requiredOption(name) {
  const value = options[name];
  if (!value) throw new Error(`Missing --${name}.`);
  return value;
}

function controllerIdentityName() {
  const value = String(options["controller-name"] ?? systemHostname()).trim();
  if (!value || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error("Cannot determine a safe controller host name.");
  }
  return value;
}

function validHost(host) {
  if (isIP(host)) return true;
  return /^[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/.test(host);
}

function portableIdentityFile(path) {
  if (path === defaultKey) return "~/.ssh/id_ed25519";
  return path.replaceAll("\\", "/");
}

function quoteForUserShell(value) {
  if (process.platform === "win32") return `'${value.replaceAll("'", "''")}'`;
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function macosAuthorizeCommand({ encodedLine, blob }) {
  return [
    "set -e",
    `KEY="$(printf %s '${encodedLine}' | base64 -D)"`,
    `BLOB='${blob}'`,
    "umask 077",
    'mkdir -p "$HOME/.ssh"',
    'AUTH="$HOME/.ssh/authorized_keys"',
    'TMP="$AUTH.dawn-forge.$$"',
    'trap \'rm -f "$TMP"\' EXIT',
    'touch "$AUTH"',
    'chmod 700 "$HOME/.ssh"',
    'chmod 600 "$AUTH"',
    "awk -v blob=\"$BLOB\" '{ keep=1; for (i=1; i<=NF; i++) if ($i == blob) keep=0; if (keep) print }' \"$AUTH\" > \"$TMP\"",
    'printf \'%s\\n\' "$KEY" >> "$TMP"',
    'mv "$TMP" "$AUTH"',
    'chmod 600 "$AUTH"',
  ].join("; ");
}

function windowsAuthorizeCommand({ encodedLine, blob }, administrator) {
  const fileSetup = administrator
    ? "$f=Join-Path $env:ProgramData 'ssh\\administrators_authorized_keys'"
    : "$d=Join-Path $HOME '.ssh'; New-Item -ItemType Directory -Force $d | Out-Null; $f=Join-Path $d 'authorized_keys'";
  const acl = administrator
    ? "& icacls.exe $f /inheritance:r /grant:r '*S-1-5-32-544:F' '*S-1-5-18:F' | Out-Null"
    : "& icacls.exe $d /inheritance:r /grant:r \"${env:USERNAME}:(OI)(CI)F\" 'SYSTEM:(OI)(CI)F' | Out-Null; " +
      "& icacls.exe $f /inheritance:r /grant:r \"${env:USERNAME}:F\" 'SYSTEM:F' | Out-Null";

  return [
    `$k=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedLine}'))`,
    `$b='${blob}'`,
    fileSetup,
    "New-Item -ItemType File -Force $f | Out-Null",
    "$lines=@(Get-Content -LiteralPath $f -ErrorAction SilentlyContinue)",
    "$kept=@($lines | Where-Object { -not (($_ -split '\\s+') -contains $b) })",
    "Set-Content -LiteralPath $f -Value @($kept + $k) -Encoding ascii",
    acl,
  ].join("; ");
}

function windowsRemoteCommand(commandText) {
  const encoded = Buffer.from(commandText, "utf16le").toString("base64");
  return `powershell.exe -NoProfile -NonInteractive -EncodedCommand ${encoded}`;
}

function printJson(value) {
  console.log(JSON.stringify(value, null, 2));
}

function printUsage() {
  console.log(`Usage:
  node "${scriptPath}" key [--create] [--key <path>] [--controller-name <name>] [--ssh-keygen <path>]
  node "${scriptPath}" plan --platform <macos|windows> --host <hostname-or-ip> --user <user> --alias <alias> [--windows-admin] [--key <path>] [--controller-name <name>] [--ssh <path>]
  node "${scriptPath}" install-key --platform <macos|windows> --host <hostname-or-ip> --user <user> [--windows-admin] [--key <path>] [--controller-name <name>] [--ssh <path>]`);
}
