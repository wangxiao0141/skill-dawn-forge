export type ActionType = "install" | "skip" | "conflict" | "manual";

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | { readonly [key: string]: JsonValue }
  | readonly JsonValue[];

export type ActionState =
  | "pending"
  | "blocked"
  | "running"
  | "succeeded"
  | "skipped"
  | "failed"
  | "needs_user";

export interface IdentityEvidence {
  readonly sshHostKeyFingerprint: string;
  readonly machineId: string;
  readonly architecture: string;
  readonly remoteUser: string;
}

export interface Target {
  readonly targetId: string;
  readonly displayName: string;
  readonly platform: "macos";
  readonly locators: Readonly<{ sshAlias: string }>;
  readonly identityEvidence: IdentityEvidence;
  readonly targetFingerprint: string;
  readonly registeredAt: string;
}

export interface Action {
  readonly actionId: string;
  readonly type: ActionType;
  readonly packageId: string;
  readonly provider: string;
  readonly params: Readonly<Record<string, JsonValue>>;
  readonly critical: boolean;
  readonly dependsOn: readonly string[];
}

export interface PlanSpec {
  readonly engineVersion: string;
  readonly catalogVersion: string;
  readonly targetId: string;
  readonly targetFingerprint: string;
  readonly profileHash: string;
  readonly actions: readonly Action[];
}

export interface Plan {
  readonly spec: PlanSpec;
  readonly planHash: string;
  readonly createdAt: string;
}

export interface RunEvent {
  readonly timestamp: string;
  readonly runId: string;
  readonly event:
    | { readonly type: "run-started" }
    | {
        readonly type: "action-started";
        readonly actionId: string;
        readonly message: string;
      }
    | {
        readonly type: "action-succeeded";
        readonly actionId: string;
        readonly message: string;
      }
    | {
        readonly type: "action-skipped";
        readonly actionId: string;
        readonly message: string;
      }
    | {
        readonly type: "action-failed";
        readonly actionId: string;
        readonly message: string;
        readonly critical: boolean;
      }
    | {
        readonly type: "action-blocked";
        readonly actionId: string;
        readonly reason: string;
      }
    | {
        readonly type: "needs-user";
        readonly actionId: string;
        readonly instruction: string;
      }
    | { readonly type: "run-completed"; readonly summary: string }
    | { readonly type: "run-stopped"; readonly reason: string };
}

export const ExitCode = {
  Success: 0,
  ParamError: 2,
  NeedsUser: 10,
  PlanInvalid: 20,
  IdentityConflict: 30,
  ActionFailed: 40,
  VerifyDrift: 50,
  LockConflict: 60,
} as const;

export type ExitCode = (typeof ExitCode)[keyof typeof ExitCode];

export { computePlanHash, computeTargetFingerprint } from "./hash.ts";
