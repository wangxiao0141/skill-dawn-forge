#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { isIP } from "node:net";
import { fileURLToPath } from "node:url";

const command = process.argv[2];
const options = parseOptions(process.argv.slice(3));
const defaultKey = resolve(homedir(), ".ssh", "id_ed25519");
const keyPath = expandPath(options.key ?? defaultKey);
const publicKeyPath = `${keyPath}.pub`;
const sshKeygen = options["ssh-keygen"] ?? "ssh-keygen";

if (!command || options.help || !["key", "plan"].includes(command)) {
  printUsage();
  process.exit(command && !options.help ? 2 : 0);
}

try {
  if (command === "key") {
    const result = inspectOrCreateKey(Boolean(options.create));
    printJson(result);
  } else {
    printJson(createPlan());
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
      next: "Run the same command with --create after user confirmation.",
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
      "dawn-forge-management",
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
  const key = inspectOrCreateKey(false);
  const platform = requiredOption("platform");
  const host = requiredOption("host");
  const user = requiredOption("user");
  const alias = requiredOption("alias");

  if (!["macos", "windows"].includes(platform)) {
    throw new Error("--platform must be macos or windows.");
  }
  if (!validHost(host)) throw new Error("--host must be a LAN hostname or IP address.");
  if (!/^[A-Za-z0-9._-]+$/.test(user)) throw new Error("--user contains unsupported characters.");
  if (!/^[A-Za-z0-9._-]+$/.test(alias)) throw new Error("--alias contains unsupported characters.");

  const publicLine = readFileSync(publicKeyPath, "utf8").trim();
  const [type, blob] = publicLine.split(/\s+/, 2);
  const managedLine =
    `no-agent-forwarding,no-port-forwarding,no-X11-forwarding ${type} ${blob} dawn-forge-management`;
  const encodedKey = Buffer.from(managedLine, "utf8").toString("base64");
  const identityFile = portableIdentityFile(keyPath);

  return {
    platform,
    host,
    user,
    alias,
    keyFingerprint: key.fingerprint,
    connectCommand:
      `ssh -o PreferredAuthentications=password,keyboard-interactive ` +
      `-o PubkeyAuthentication=no ${user}@${host}`,
    authorizeCommand:
      platform === "macos"
        ? macosAuthorizeCommand(encodedKey)
        : windowsAuthorizeCommand(encodedKey, Boolean(options["windows-admin"])),
    verifyCommand:
      `ssh -o BatchMode=yes -o PasswordAuthentication=no ` +
      `-o KbdInteractiveAuthentication=no -o IdentitiesOnly=yes ` +
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

function requiredOption(name) {
  const value = options[name];
  if (!value) throw new Error(`Missing --${name}.`);
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

function macosAuthorizeCommand(encodedKey) {
  return [
    `KEY="$(printf %s '${encodedKey}' | base64 -D)"`,
    'umask 077; mkdir -p "$HOME/.ssh"; touch "$HOME/.ssh/authorized_keys"',
    'chmod 700 "$HOME/.ssh"; chmod 600 "$HOME/.ssh/authorized_keys"',
    'grep -qxF "$KEY" "$HOME/.ssh/authorized_keys" || printf \'%s\\n\' "$KEY" >> "$HOME/.ssh/authorized_keys"',
  ].join("; ");
}

function windowsAuthorizeCommand(encodedKey, administrator) {
  const fileSetup = administrator
    ? "$f=Join-Path $env:ProgramData 'ssh\\administrators_authorized_keys'"
    : "$d=Join-Path $HOME '.ssh'; New-Item -ItemType Directory -Force $d | Out-Null; $f=Join-Path $d 'authorized_keys'";
  const acl = administrator
    ? "& icacls.exe $f /inheritance:r /grant:r '*S-1-5-32-544:F' '*S-1-5-18:F' | Out-Null"
    : "& icacls.exe $d /inheritance:r /grant:r \"${env:USERNAME}:(OI)(CI)F\" 'SYSTEM:(OI)(CI)F' | Out-Null; " +
      "& icacls.exe $f /inheritance:r /grant:r \"${env:USERNAME}:F\" 'SYSTEM:F' | Out-Null";

  return [
    `$k=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedKey}'))`,
    fileSetup,
    "New-Item -ItemType File -Force $f | Out-Null",
    "if(-not (Select-String -LiteralPath $f -SimpleMatch $k -Quiet)){Add-Content -LiteralPath $f -Value $k -Encoding ascii}",
    acl,
  ].join("; ");
}

function printJson(value) {
  console.log(JSON.stringify(value, null, 2));
}

function printUsage() {
  const script = fileURLToPath(import.meta.url);
  console.log(`Usage:
  node "${script}" key [--create] [--key <path>] [--ssh-keygen <path>]
  node "${script}" plan --platform <macos|windows> --host <hostname-or-ip> --user <user> --alias <alias> [--windows-admin] [--key <path>]`);
}
