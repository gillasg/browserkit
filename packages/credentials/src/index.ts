import { activeProvider } from "./config.js";
import { hostOf, loginsFor } from "./match.js";
import { ToolMissing } from "./run.js";

export { activeProvider, readConfig, saveConfig, configPath, providerFor } from "./config.js";
export type { CredentialConfig, Provider, ProviderName } from "./config.js";
export { hostOf, loginsFor, sameSite, type Login, type SaveLogin } from "./match.js";

// What the browser engine asks the machine for when the agent signs in. The engine sends the
// page's real address; the answer goes back to the engine, which types it into the page and
// hands the agent only the outcome. Cells cannot send these requests themselves: the engine
// refuses any `credential` request that comes from agent code.

export type CredentialRequest =
  | { credential: "login"; url: string; account?: string }
  | { credential: "totp"; url: string; id: string }
  | { credential: "save"; url: string; username: string; password: string; name?: string };

export interface LoginAnswer {
  provider: string | null;
  error?: "NO_PASSWORD_MANAGER" | "PASSWORD_MANAGER_LOCKED" | "PASSWORD_MANAGER_FAILED";
  detail?: string;
  logins: { id: string; name: string; username: string; password: string; hasTotp: boolean }[];
}

export function isCredentialRequest(value: unknown): value is CredentialRequest {
  const request = value as { credential?: unknown; url?: unknown } | null;
  return (
    (request?.credential === "login" ||
      request?.credential === "totp" ||
      request?.credential === "save") &&
    typeof request.url === "string"
  );
}

export async function handleCredentialRequest(
  request: CredentialRequest,
  directory: string,
  providerOverride?: import("./config.js").Provider,
): Promise<LoginAnswer | { code: string | null } | { saved: boolean; provider: string | null }> {
  const host = hostOf(request.url);
  if (!host) throw new Error("INVALID_TARGET: sign-in needs an http(s) page");
  const provider = providerOverride ?? (await activeProvider(directory));
  if (request.credential === "totp") {
    if (!provider) return { code: null };
    const known = loginsFor(await provider.logins(host), host).some((l) => l.id === request.id);
    return { code: known ? ((await provider.totp(request.id)) ?? null) : null };
  }
  if (!provider) return { provider: null, error: "NO_PASSWORD_MANAGER", logins: [] };
  if (request.credential === "save") {
    try {
      await provider.saveLogin({
        url: request.url,
        ...(request.name ? { name: request.name } : {}),
        username: request.username,
        password: request.password,
      });
      return { saved: true, provider: provider.name };
    } catch {
      return { saved: false, provider: provider.name };
    }
  }
  try {
    const logins = loginsFor(await provider.logins(host), host, request.account);
    return {
      provider: provider.name,
      logins: logins.map(({ id, name, username, password, hasTotp }) => ({
        id,
        name,
        username,
        password,
        hasTotp,
      })),
    };
  } catch (error) {
    return failure(provider.name, error);
  }
}

function failure(provider: string, error: unknown): LoginAnswer {
  const detail = error instanceof Error ? error.message : String(error);
  const locked = /locked|unlock|not logged in|login required|unauthenticated|session/i.test(detail);
  return {
    provider,
    error:
      error instanceof ToolMissing
        ? "NO_PASSWORD_MANAGER"
        : locked
          ? "PASSWORD_MANAGER_LOCKED"
          : "PASSWORD_MANAGER_FAILED",
    detail: detail.slice(0, 200),
    logins: [],
  };
}
