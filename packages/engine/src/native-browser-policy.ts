// Private-network policy decisions. This is a name/IP check used before an agent navigation or
// fetch, plus a post-hoc check of the address a response came from. Chrome extensions cannot block
// on the resolved address before connecting (there is no per-tab proxy), so rebinding is detected
// after the first response instead of being prevented.
const PRIVATE_V4 = [
  /^10\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^192\.168\./,
  /^127\./,
  /^169\.254\./,
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./,
  /^0\./,
];
const METADATA = new Set([
  "169.254.169.254",
  "169.254.170.2",
  "100.100.100.200",
  "fd00:ec2::254",
  "metadata.google.internal",
]);

/** The reason an address is private, metadata or local, or undefined for a public address. */
export function privateAddress(address: string): string | undefined {
  const value = address
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, "");
  if (!value) return undefined;
  if (METADATA.has(value)) return `metadata address ${value}`;
  if (value === "::1" || value === "::") return `private address ${value}`;
  if (PRIVATE_V4.some((re) => re.test(value))) return `private address ${value}`;
  if (/^(fc|fd|fe8|fe9|fea|feb)/i.test(value)) return `private address ${value}`;
  return undefined;
}

/** True when an agent must not open this URL unless the policy is explicitly off. */
export function privateTarget(url: string, allowPorts: readonly number[] = []): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "invalid url";
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return undefined;
  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (METADATA.has(host) || /\.(local|internal)$/.test(host)) return `private host ${host}`;
  const loopback = host === "localhost" || host === "::1" || /^127\./.test(host);
  if (loopback)
    return allowPorts.includes(Number(parsed.port || (parsed.protocol === "https:" ? 443 : 80)))
      ? undefined
      : `private address ${host}`;
  if (PRIVATE_V4.some((re) => re.test(host))) return `private address ${host}`;
  if (/^(fc|fd|fe8|fe9|fea|feb)/i.test(host)) return `private address ${host}`;
  return undefined;
}

/**
 * Resolved addresses are refused even on an allowed loopback port: only a literal
 * localhost/127.0.0.1 gets the development allowlist. A public-looking hostname that resolves
 * into the private network (nip.io, a hosts entry, split-horizon DNS) is the rebinding case.
 */
export function resolvedTarget(host: string, addresses: readonly string[]): string | undefined {
  for (const address of addresses) {
    const reason = privateAddress(address);
    if (reason) return `resolved ${host} to ${reason}`;
  }
  return undefined;
}
