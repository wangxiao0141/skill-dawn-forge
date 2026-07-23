import { gitProvider } from "./git.ts";
import { homebrewProvider } from "./homebrew.ts";
import { type Provider } from "./interface.ts";

export { GitProvider, gitProvider } from "./git.ts";
export { HomebrewProvider, homebrewProvider } from "./homebrew.ts";
export type {
  Provider,
  ProviderCheckResult,
  SshExecutor,
} from "./interface.ts";

export function getProvider(providerName: string): Provider {
  switch (providerName) {
    case "homebrew":
      return homebrewProvider;
    case "git":
      return gitProvider;
    default:
      throw new Error(`Unknown provider: ${providerName}`);
  }
}
