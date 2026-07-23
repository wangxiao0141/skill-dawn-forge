import {
  type Provider,
  type ProviderCheckResult,
  type SshExecutor,
} from "./interface.ts";

export interface GitIdentityParams {
  readonly name: string;
  readonly email: string;
}

function isSafeValue(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 200 &&
    value === value.trim() &&
    !/[\u0000-\u001f\u007f]/.test(value)
  );
}

export function parseGitIdentityParams(
  params: Record<string, unknown>,
): GitIdentityParams {
  if (
    Object.keys(params).length !== 2 ||
    !Object.hasOwn(params, "name") ||
    !Object.hasOwn(params, "email") ||
    !isSafeValue(params.name) ||
    !isSafeValue(params.email) ||
    !/^[^@\s]+@[^@\s]+$/.test(params.email)
  ) {
    throw new Error(
      "Git identity requires safe, non-empty name and email parameters.",
    );
  }
  return { name: params.name, email: params.email };
}

export class GitIdentityProvider implements Provider {
  async check(
    params: Record<string, unknown>,
    ssh: SshExecutor,
  ): Promise<ProviderCheckResult> {
    const expected = parseGitIdentityParams(params);
    const name = await ssh.run("git config --global --get user.name");
    const email = await ssh.run("git config --global --get user.email");
    if (name.exitCode !== 0 || email.exitCode !== 0) {
      return { installed: false };
    }
    return {
      installed:
        name.stdout.trimEnd() === expected.name &&
        email.stdout.trimEnd() === expected.email,
    };
  }

  async apply(
    params: Record<string, unknown>,
    ssh: SshExecutor,
  ): Promise<void> {
    const identity = parseGitIdentityParams(params);
    const encodedName = Buffer.from(identity.name, "utf8").toString("base64");
    const encodedEmail = Buffer.from(identity.email, "utf8").toString(
      "base64",
    );
    const result = await ssh.run(
      `git config --global user.name "$(printf '%s' '${encodedName}' | base64 -D)" && ` +
        `git config --global user.email "$(printf '%s' '${encodedEmail}' | base64 -D)"`,
    );
    if (result.exitCode !== 0) {
      throw new Error("Failed to configure the global Git identity.");
    }
  }

  async verify(
    params: Record<string, unknown>,
    ssh: SshExecutor,
  ): Promise<void> {
    if (!(await this.check(params, ssh)).installed) {
      throw new Error("Global Git identity does not match the approved Plan.");
    }
  }
}

export const gitIdentityProvider = new GitIdentityProvider();
