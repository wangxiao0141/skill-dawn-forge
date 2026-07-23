export interface SshRunOptions {
  readonly onOutput?: (stream: "stdout" | "stderr") => void;
}

// 注入的 SSH executor，允许测试替换远程调用。
export interface SshExecutor {
  run(
    command: string,
    options?: SshRunOptions,
  ): Promise<{ stdout: string; stderr: string; exitCode: number }>;
}

export interface ProviderCheckResult {
  installed: boolean;
  version?: string;
}

export interface Provider {
  check(
    params: Record<string, unknown>,
    ssh: SshExecutor,
  ): Promise<ProviderCheckResult>;
  apply(params: Record<string, unknown>, ssh: SshExecutor): Promise<void>;
  verify(params: Record<string, unknown>, ssh: SshExecutor): Promise<void>;
  revoke?(
    params: Record<string, unknown>,
    ssh: SshExecutor,
  ): Promise<void>;
}
