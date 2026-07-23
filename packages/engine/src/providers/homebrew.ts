import {
  type Provider,
  type ProviderCheckResult,
  type SshExecutor,
} from "./interface.ts";

const HOMEBREW_MANUAL_INSTALL_ERROR =
  "Homebrew must be installed manually via the official installer; cannot apply automatically.";

interface FormulaParams {
  readonly formula: string;
  readonly cask: boolean;
}

function isHomebrewEntry(params: Record<string, unknown>): boolean {
  return Object.keys(params).length === 0;
}

function parseFormulaParams(
  params: Record<string, unknown>,
): FormulaParams {
  const keys = Object.keys(params);
  if (keys.some((key) => key !== "formula" && key !== "cask")) {
    throw new Error("Homebrew provider received an unknown parameter.");
  }
  const formula = params.formula;
  if (typeof formula !== "string" || formula.length === 0) {
    throw new Error("Homebrew provider requires a non-empty formula parameter.");
  }
  if (!/^[a-zA-Z0-9][a-zA-Z0-9@+._/-]*$/.test(formula)) {
    throw new Error(`Invalid Homebrew formula: ${formula}`);
  }
  if (
    params.cask !== undefined &&
    typeof params.cask !== "boolean"
  ) {
    throw new Error("Homebrew provider cask parameter must be boolean.");
  }
  return { formula, cask: params.cask === true };
}

function listCommand(params: FormulaParams): string {
  return params.cask
    ? `brew list --cask --versions ${params.formula}`
    : `brew list --versions ${params.formula}`;
}

function installCommand(params: FormulaParams): string {
  return params.cask
    ? `brew install --cask ${params.formula}`
    : `brew install ${params.formula}`;
}

function isCommandNotFound(stderr: string, exitCode: number): boolean {
  return (
    exitCode === 127 ||
    /(?:command not found|brew: not found|no such file or directory)/i.test(
      stderr,
    )
  );
}

export class HomebrewProvider implements Provider {
  async check(
    params: Record<string, unknown>,
    ssh: SshExecutor,
  ): Promise<ProviderCheckResult> {
    if (isHomebrewEntry(params)) {
      const result = await ssh.run("brew --version");
      if (result.exitCode !== 0) {
        return { installed: false };
      }

      const version = result.stdout.trim().split(/\r?\n/, 1)[0];
      return version
        ? { installed: true, version }
        : { installed: false };
    }

    const formulaParams = parseFormulaParams(params);
    const result = await ssh.run(listCommand(formulaParams));

    if (isCommandNotFound(result.stderr, result.exitCode)) {
      throw new Error(
        "Homebrew is not installed or the brew command is not available.",
      );
    }
    if (result.exitCode !== 0 || result.stdout.trim() === "") {
      return { installed: false };
    }

    const output = result.stdout.trim().split(/\r?\n/, 1)[0];
    const version = output.startsWith(`${formulaParams.formula} `)
      ? output.slice(formulaParams.formula.length + 1).trim()
      : output;
    return version
      ? { installed: true, version }
      : { installed: false };
  }

  async apply(
    params: Record<string, unknown>,
    ssh: SshExecutor,
  ): Promise<void> {
    if (isHomebrewEntry(params)) {
      throw new Error(HOMEBREW_MANUAL_INSTALL_ERROR);
    }

    const formulaParams = parseFormulaParams(params);
    const result = await ssh.run(installCommand(formulaParams));
    if (isCommandNotFound(result.stderr, result.exitCode)) {
      throw new Error(
        "Homebrew is not installed or the brew command is not available.",
      );
    }
    if (result.exitCode !== 0) {
      throw new Error(
        `Failed to install Homebrew package: ${formulaParams.formula}`,
      );
    }
  }

  async verify(
    params: Record<string, unknown>,
    ssh: SshExecutor,
  ): Promise<void> {
    const result = await this.check(params, ssh);
    if (!result.installed) {
      const name = isHomebrewEntry(params)
        ? "Homebrew"
        : parseFormulaParams(params).formula;
      throw new Error(`${name} is not installed.`);
    }
  }
}

export const homebrewProvider = new HomebrewProvider();
