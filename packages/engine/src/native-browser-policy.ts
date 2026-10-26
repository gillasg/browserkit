// Private-network policy decisions. This is a name/IP check used before an agent navigation or
// fetch; Chrome extensions cannot block on the resolved address before connecting, so rebinding is
// detected after the first response instead.
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
  if (host === "localhost" || host === "::1" || PRIVATE_V4.some((re) => re.test(host)))
    return allowPorts.includes(Number(parsed.port || (parsed.protocol === "https:" ? 443 : 80)))
      ? undefined
      : `private address ${host}`;
  if (/^(fc|fd|fe8|fe9|fea|feb)/i.test(host)) return `private address ${host}`;
  return undefined;
}
