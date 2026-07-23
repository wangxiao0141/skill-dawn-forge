import { homebrewProvider } from "./homebrew.ts";
import {
  type Provider,
  type ProviderCheckResult,
  type SshExecutor,
} from "./interface.ts";

const GIT_VERSION_PATTERN = /^git version (.+)$/;

function assertEmptyParams(params: Record<string, unknown>): void {
  if (Object.keys(params).length !== 0) {
    throw new Error("Git provider does not accept parameters.");
  }
}

export class GitProvider implements Provider {
  async check(
    params: Record<string, unknown>,
    ssh: SshExecutor,
  ): Promise<ProviderCheckResult> {
    assertEmptyParams(params);
    const result = await ssh.run("git --version");
    if (result.exitCode !== 0) {
      return { installed: false };
    }

    const match = result.stdout.trim().match(GIT_VERSION_PATTERN);
    return match
      ? { installed: true, version: match[1] }
      : { installed: false };
  }

  async apply(
    params: Record<string, unknown>,
    ssh: SshExecutor,
  ): Promise<void> {
    assertEmptyParams(params);
    await homebrewProvider.apply({ formula: "git" }, ssh);
  }

  async verify(
    params: Record<string, unknown>,
    ssh: SshExecutor,
  ): Promise<void> {
    assertEmptyParams(params);
    const result = await this.check({}, ssh);
    if (!result.installed) {
      throw new Error("git --version did not return a valid Git version.");
    }
  }
}

export const gitProvider = new GitProvider();
