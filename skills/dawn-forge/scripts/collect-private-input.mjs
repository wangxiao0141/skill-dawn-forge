#!/usr/bin/env node

import { randomBytes } from "node:crypto";
import {
  chmod,
  link,
  lstat,
  mkdir,
  open,
  realpath,
  rename,
  unlink,
} from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { homedir, userInfo } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const maxInputBytes = 1024 * 1024;
const urlPattern = /[a-z][a-z0-9+.-]*:\/\/\S*/i;
const safeNamePattern =
  /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,62}[A-Za-z0-9])?$/;

export class PrivateInputError extends Error {
  constructor(message, exitCode = 2) {
    super(message);
    this.name = "PrivateInputError";
    this.exitCode = exitCode;
  }
}

export function parseArguments(argv) {
  if (argv.some((argument) => urlPattern.test(argument))) {
    throw new PrivateInputError(
      "拒绝从命令参数接收 URL。请通过隐藏输入或显式 `--stdin` 传入内容。",
    );
  }

  const options = {
    exists: false,
    help: false,
    name: undefined,
    replace: false,
    stdin: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    switch (argv[index]) {
      case "--help":
      case "-h":
        options.help = true;
        break;
      case "--name":
        options.name = readOptionValue(argv, ++index, "--name");
        break;
      case "--stdin":
        options.stdin = true;
        break;
      case "--replace":
        options.replace = true;
        break;
      case "--exists":
        options.exists = true;
        break;
      default:
        throw new PrivateInputError(
          `存在未知命令参数（位置 ${index + 1}），其内容未回显。`,
        );
    }
  }

  if (options.help) return options;
  assertSafeName(options.name);
  if (options.exists && (options.stdin || options.replace)) {
    throw new PrivateInputError(
      "`--exists` 不能与 `--stdin` 或 `--replace` 同时使用。",
    );
  }
  return options;
}

export function privateInputPath(name, { home = homedir() } = {}) {
  assertSafeName(name);
  return join(
    resolve(home),
    ".dawn-forge",
    "private-inputs",
    `${name}.txt`,
  );
}

export async function destinationStatus(destination) {
  try {
    const status = await lstat(destination);
    return {
      exists: true,
      isRegularFile: status.isFile(),
      isSymbolicLink: status.isSymbolicLink(),
    };
  } catch (error) {
    if (error.code === "ENOENT") {
      return {
        exists: false,
        isRegularFile: false,
        isSymbolicLink: false,
      };
    }
    throw error;
  }
}

export async function collectPrivateInput({
  input = process.stdin,
  output = process.stderr,
  stdinMode = false,
  name,
}) {
  let value;
  if (stdinMode) {
    if (input.isTTY) {
      throw new PrivateInputError(
        "TTY 中不要使用 `--stdin`，请省略该参数以启用隐藏输入。",
      );
    }
    value = await readBoundedStream(input);
  } else {
    if (!input.isTTY || typeof input.setRawMode !== "function") {
      throw new PrivateInputError(
        "非 TTY 输入必须显式添加 `--stdin`；该模式仅用于管道或自动化。",
      );
    }
    value = Buffer.from(
      await readHiddenLine(
        input,
        output,
        `请输入 ${name}（输入隐藏，Enter 完成）: `,
      ),
      "utf8",
    );
  }

  value = removeOneTrailingLineEnding(value);
  if (value.length === 0) {
    throw new PrivateInputError("输入不能为空。");
  }
  if (value.length > maxInputBytes) {
    throw new PrivateInputError("输入超过 1 MiB 限制。");
  }
  if (value.includes(0)) {
    throw new PrivateInputError("输入不能包含 NUL 字节。");
  }
  return value;
}

export function createPrivateInputWriter({
  platform = process.platform,
  tightenWindowsAcl = tightenWindowsFileAcl,
} = {}) {
  return async function writePrivateInput(
    name,
    value,
    {
      home = homedir(),
      replaceExisting = false,
    } = {},
  ) {
    const destination = privateInputPath(name, { home });
    const parent = dirname(destination);

    await inspectPrivatePath(name, home);
    await mkdir(parent, { recursive: true, mode: 0o700 });
    await inspectPrivatePath(name, home);
    if (platform !== "win32") {
      await chmod(parent, 0o700);
    }

    const existing = await destinationStatus(destination);
    if (existing.exists && !replaceExisting) {
      throw new PrivateInputError(
        "目标文件已存在；未覆盖。确认需要替换后使用 `--replace`。",
        4,
      );
    }
    if (
      existing.exists &&
      (!existing.isRegularFile || existing.isSymbolicLink)
    ) {
      throw new PrivateInputError("目标路径不是普通文件，已拒绝替换。");
    }

    const temporaryPath = join(
      parent,
      `.${basename(destination)}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`,
    );
    let handle;
    let published = false;

    try {
      handle = await open(temporaryPath, "wx", 0o600);
      await handle.writeFile(value);
      await handle.sync();
      await handle.close();
      handle = undefined;

      if (platform === "win32") {
        if (!(await tightenWindowsAcl(temporaryPath))) {
          throw new PrivateInputError(
            "无法确认或收紧 Windows ACL，已拒绝发布 private input。",
          );
        }
      } else {
        await chmod(temporaryPath, 0o600);
      }

      if (replaceExisting) {
        await rename(temporaryPath, destination);
      } else {
        try {
          await link(temporaryPath, destination);
        } catch (error) {
          if (error.code === "EEXIST") {
            throw new PrivateInputError(
              "目标文件已存在；未覆盖。确认需要替换后使用 `--replace`。",
              4,
            );
          }
          throw error;
        }
        await unlink(temporaryPath);
      }
      published = true;

      const finalStatus = await lstat(destination);
      if (!finalStatus.isFile() || finalStatus.isSymbolicLink()) {
        throw new PrivateInputError("发布后的目标路径不是普通文件。");
      }
      if (platform !== "win32") {
        await chmod(destination, 0o600);
      }
      await inspectPrivatePath(name, home);
      await syncDirectoryBestEffort(parent);

      return {
        bytes: value.length,
        path: destination,
        permissions: platform === "win32" ? "acl-restricted" : "0600",
        replaced: existing.exists,
        status: existing.exists ? "replaced" : "stored",
      };
    } finally {
      if (handle !== undefined) {
        await handle.close().catch(() => {});
      }
      if (!published) {
        await unlink(temporaryPath).catch((error) => {
          if (error.code !== "ENOENT") throw error;
        });
      }
    }
  };
}

export const writePrivateInput = createPrivateInputWriter();

function assertSafeName(name) {
  if (
    typeof name !== "string" ||
    !safeNamePattern.test(name) ||
    name.includes("..")
  ) {
    throw new PrivateInputError(
      "`--name` 必须是 1-64 个字母、数字、点、下划线或连字符，且不能包含 `..`。",
    );
  }
}

async function inspectPrivatePath(name, home) {
  const resolvedHome = resolve(home);
  const homeStatus = await lstat(resolvedHome).catch((error) => {
    if (error.code === "ENOENT") {
      throw new PrivateInputError("控制机用户的 home 目录不存在。");
    }
    throw error;
  });
  if (!homeStatus.isDirectory() || homeStatus.isSymbolicLink()) {
    throw new PrivateInputError(
      "控制机用户的 home 路径不是可信的普通目录。",
    );
  }

  const realHome = await realpath(resolvedHome);
  if (!sameFilesystemPath(realHome, resolvedHome)) {
    throw new PrivateInputError(
      "控制机用户的 home 路径包含 symlink、junction 或 reparse point。",
    );
  }

  const destination = privateInputPath(name, { home: resolvedHome });
  const segments = relative(resolvedHome, destination).split(sep).filter(Boolean);
  let candidate = resolvedHome;
  for (let index = 0; index < segments.length; index += 1) {
    candidate = join(candidate, segments[index]);
    let status;
    try {
      status = await lstat(candidate);
    } catch (error) {
      if (error.code === "ENOENT") break;
      throw error;
    }

    if (status.isSymbolicLink()) {
      throw new PrivateInputError(
        "private input 路径包含 symlink、junction 或 reparse point。",
      );
    }
    const expected = join(realHome, ...segments.slice(0, index + 1));
    if (!sameFilesystemPath(await realpath(candidate), expected)) {
      throw new PrivateInputError(
        "private input 路径包含重定向的 reparse point。",
      );
    }

    const isDestination = index === segments.length - 1;
    if (!isDestination && !status.isDirectory()) {
      throw new PrivateInputError("private input 路径的现有父级不是目录。");
    }
    if (isDestination && !status.isFile()) {
      throw new PrivateInputError("目标路径不是普通文件。");
    }
  }
}

async function readBoundedStream(stream) {
  const chunks = [];
  let totalBytes = 0;
  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += buffer.length;
    if (totalBytes > maxInputBytes + 2) {
      throw new PrivateInputError("输入超过 1 MiB 限制。");
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

async function readHiddenLine(input, output, prompt) {
  output.write(prompt);
  const previousRawMode = Boolean(input.isRaw);
  input.setEncoding("utf8");
  input.setRawMode(true);
  input.resume();

  return new Promise((resolvePromise, rejectPromise) => {
    let value = "";

    const finish = (error) => {
      input.off("data", onData);
      input.off("error", onError);
      input.off("end", onEnd);
      input.setRawMode(previousRawMode);
      input.pause();
      output.write("\n");
      if (error) rejectPromise(error);
      else resolvePromise(value);
    };

    const onError = () =>
      finish(new PrivateInputError("读取隐藏输入失败。"));
    const onEnd = () =>
      finish(new PrivateInputError("隐藏输入在按下 Enter 前结束。"));
    const onData = (chunk) => {
      for (const character of chunk) {
        if (character === "\u0003") {
          finish(new PrivateInputError("输入已取消。", 130));
          return;
        }
        if (character === "\r" || character === "\n") {
          finish();
          return;
        }
        if (character === "\u007f" || character === "\b") {
          value = Array.from(value).slice(0, -1).join("");
          continue;
        }
        if (character < " " && character !== "\t") continue;
        value += character;
        if (Buffer.byteLength(value, "utf8") > maxInputBytes) {
          finish(new PrivateInputError("输入超过 1 MiB 限制。"));
          return;
        }
      }
    };

    input.on("data", onData);
    input.once("error", onError);
    input.once("end", onEnd);
  });
}

function removeOneTrailingLineEnding(value) {
  let end = value.length;
  if (end > 0 && value[end - 1] === 0x0a) {
    end -= 1;
    if (end > 0 && value[end - 1] === 0x0d) end -= 1;
  }
  return value.subarray(0, end);
}

function readOptionValue(argv, index, option) {
  const value = argv[index];
  if (value === undefined || value.startsWith("--")) {
    throw new PrivateInputError(`${option} 缺少值。`);
  }
  return value;
}

function sameFilesystemPath(left, right) {
  const normalizedLeft = resolve(left);
  const normalizedRight = resolve(right);
  if (process.platform === "win32" || process.platform === "darwin") {
    return normalizedLeft.toLocaleLowerCase("en-US") ===
      normalizedRight.toLocaleLowerCase("en-US");
  }
  return normalizedLeft === normalizedRight;
}

function tightenWindowsFileAcl(path) {
  const account = windowsAccountName();
  if (!account) return false;
  const icaclsPath = process.env.SystemRoot
    ? join(process.env.SystemRoot, "System32", "icacls.exe")
    : "icacls.exe";

  const grant = spawnSync(
    icaclsPath,
    [path, "/grant:r", `${account}:F`, "/q"],
    { stdio: "ignore", windowsHide: true },
  );
  if (grant.status !== 0) return false;

  const removeInheritance = spawnSync(
    icaclsPath,
    [path, "/inheritance:r", "/q"],
    { stdio: "ignore", windowsHide: true },
  );
  if (removeInheritance.status !== 0) return false;

  const verify = spawnSync(
    icaclsPath,
    [path, "/verify", "/q"],
    { stdio: "ignore", windowsHide: true },
  );
  if (verify.status !== 0) return false;

  const query = spawnSync(icaclsPath, [path], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    windowsHide: true,
  });
  if (query.status !== 0) return false;
  const normalizedAcl = query.stdout.toLocaleLowerCase("en-US");
  const normalizedAccount = account.toLocaleLowerCase("en-US");
  const accessEntries = normalizedAcl.match(/:\([^)\r\n]+\)/g) ?? [];
  return (
    normalizedAcl.includes(`${normalizedAccount}:(f)`) &&
    !normalizedAcl.includes("(i)") &&
    accessEntries.length === 1
  );
}

function windowsAccountName() {
  const username = process.env.USERNAME || userInfo().username;
  if (!username) return undefined;
  return process.env.USERDOMAIN
    ? `${process.env.USERDOMAIN}\\${username}`
    : username;
}

async function syncDirectoryBestEffort(path) {
  let directoryHandle;
  try {
    directoryHandle = await open(path, "r");
    await directoryHandle.sync();
  } catch (error) {
    if (!["EACCES", "EINVAL", "EISDIR", "ENOSYS", "EPERM"].includes(error.code)) {
      throw error;
    }
  } finally {
    await directoryHandle?.close().catch(() => {});
  }
}

function printHelp() {
  console.log(`用法:
  node "${scriptPath}" --name <label> [--replace]
  <producer> | node "${scriptPath}" --name <label> --stdin [--replace]
  node "${scriptPath}" --name <label> --exists

固定输出目录: ${join(homedir(), ".dawn-forge", "private-inputs")}

规则:
  - TTY 默认隐藏输入；非 TTY 必须显式使用 --stdin。
  - 默认拒绝覆盖；只有 --replace 会原子替换普通文件。
  - 不接受输出路径；文件名固定为 <label>.txt。
  - URL 不得作为命令参数。`);
}

export async function runCli(argv = process.argv.slice(2)) {
  const options = parseArguments(argv);
  if (options.help) {
    printHelp();
    return;
  }

  const home = homedir();
  const destination = privateInputPath(options.name, { home });
  await inspectPrivatePath(options.name, home);
  const status = await destinationStatus(destination);

  if (options.exists) {
    console.log(
      JSON.stringify({
        path: destination,
        status: status.exists ? "exists" : "missing",
      }),
    );
    return;
  }
  if (status.exists && !options.replace) {
    throw new PrivateInputError(
      "目标文件已存在；未读取新输入，也未覆盖。确认需要替换后使用 `--replace`。",
      4,
    );
  }
  if (
    status.exists &&
    (!status.isRegularFile || status.isSymbolicLink)
  ) {
    throw new PrivateInputError("目标路径不是普通文件，已拒绝替换。");
  }

  const value = await collectPrivateInput({
    stdinMode: options.stdin,
    name: options.name,
  });
  const result = await writePrivateInput(options.name, value, {
    home,
    replaceExisting: options.replace,
  });
  console.log(JSON.stringify(result));
}

if (resolve(process.argv[1] ?? "") === resolve(scriptPath)) {
  try {
    await runCli();
  } catch (error) {
    if (error instanceof PrivateInputError) {
      console.error(error.message);
      process.exitCode = error.exitCode;
    } else {
      console.error("保存 private input 失败；秘密内容未回显。");
      process.exitCode = 1;
    }
  }
}
