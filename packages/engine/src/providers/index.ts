import { gitProvider } from "./git.ts";
import { gitIdentityProvider } from "./git-identity.ts";
import { homebrewProvider } from "./homebrew.ts";
import { type Provider } from "./interface.ts";

export { GitProvider, gitProvider } from "./git.ts";
export {
  GitIdentityProvider,
  gitIdentityProvider,
  parseGitIdentityParams,
} from "./git-identity.ts";
export { HomebrewProvider, homebrewProvider } from "./homebrew.ts";
export type {
  Provider,
  ProviderCheckResult,
  SshExecutor,
  SshRunOptions,
} from "./interface.ts";

export function getProvider(providerName: string): Provider {
  switch (providerName) {
    case "homebrew":
      return homebrewProvider;
    case "git":
      return gitProvider;
    case "git-identity":
      return gitIdentityProvider;
    default:
      throw new Error(`Unknown provider: ${providerName}`);
  }
}
