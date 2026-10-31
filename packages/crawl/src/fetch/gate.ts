import { FetchError } from "./types.js";

// The user's site rules for plain HTTP. A host sets the gate once, and every fetcher asks it
// before it touches a URL, so a crawl that follows links or redirects never lands on a site the
// user blocked. The answer is the reason a URL is refused, or undefined when it may be fetched.

export type WebGate = (url: string) => string | undefined | Promise<string | undefined>;

let gate: WebGate | undefined;

export function useWebGate(next: WebGate | undefined): void {
  gate = next;
}

/** Throws SITE_BLOCKED (status 451, never retried) when the gate refuses the URL. */
export async function passGate(url: string): Promise<void> {
  const reason = await gate?.(url);
  if (reason) throw new FetchError(reason, 451);
}
