// One vocabulary for what a URL produced, shared by sweeps, checks and jobs. The point is that
// "59 results, all empty" is a signal, not a finding: every item says whether it was ok, gated,
// a shell, dead, parked, redirected, blocked or an error, and a run with no ok items says so.
//
// judgeOutcome and registrableDomain are also injected into browser code (their source is put in
// the sweep realm), so they must stay self-contained: no imports, no closures.

export type Outcome =
  "ok" | "gated" | "shell" | "dead" | "parked" | "redirected" | "blocked" | "error";

export interface OutcomeSignals {
  /** Readiness state: ready, empty, loading, login, challenge, not-found, error. */
  readiness?: string;
  httpStatus?: number | null;
  /** Requests the capture kept (media, API calls). */
  captured?: number;
  /** The asked-for thing (a player, a manifest, a row) was found. */
  found?: boolean;
  /** A gate was detected: age, consent, terms, region, enter. */
  gate?: string | null;
  /** The affirmative control was clicked. */
  gateClicked?: boolean;
  /** A bot wall or captcha is on the page. */
  challenge?: boolean;
  requestedUrl?: string;
  finalUrl?: string;
}

export interface Judged {
  outcome: Outcome;
  reason: string;
}

const PARKED_HOSTS = [
  "sedoparking.com",
  "parkingcrew.net",
  "bodis.com",
  "dan.com",
  "afternic.com",
  "hugedomains.com",
  "domainmarket.com",
  "undeveloped.com",
  "godaddy.com",
];

/** The eTLD+1 of a host, without a full public-suffix list: enough to spot a redirect off-site. */ export function registrableDomain(
  url: string,
): string {
  let host = "";
  try {
    host = new URL(/^[a-z]+:\/\//i.test(url) ? url : "https://" + url).hostname.toLowerCase();
  } catch {
    return "";
  }
  const parts = host.split(".").filter(Boolean);
  if (parts.length <= 2) return parts.join(".");
  const two = parts.slice(-2).join(".");
  const multi = [
    "co.uk",
    "org.uk",
    "ac.uk",
    "gov.uk",
    "com.au",
    "net.au",
    "co.nz",
    "co.za",
    "co.jp",
    "com.br",
    "com.mx",
    "com.ar",
    "co.in",
    "com.tr",
    "com.cn",
    "com.tw",
    "co.kr",
    "com.sg",
    "com.hk",
  ];
  return multi.includes(two) ? parts.slice(-3).join(".") : two;
}

function isParkedHost(host: string): boolean {
  return PARKED_HOSTS.some((parked) => host === parked || host.endsWith("." + parked));
}

/** Classifies one item from the signals a run can see without guessing. */
export function judgeOutcome(signals: OutcomeSignals): Judged {
  const gate = signals.gate && signals.gate !== "none" ? signals.gate : undefined;
  if (gate && signals.gateClicked !== true)
    return { outcome: "gated", reason: gate + " gate, nothing clicked" };
  if (signals.challenge) return { outcome: "blocked", reason: "bot wall or captcha" };
  if (signals.httpStatus && signals.httpStatus >= 400)
    return { outcome: "blocked", reason: "HTTP " + signals.httpStatus };
  const requested = signals.requestedUrl ?? "";
  const final = signals.finalUrl ?? requested;
  // A parking redirect is a parked page, not just "redirected": say which one it is.
  const parked = registrableDomain(final);
  if (
    ["sedoparking.com", "parkingcrew.net", "bodis.com", "dan.com", "afternic.com"].some(
      (host) => parked === host || parked.endsWith("." + host),
    ) ||
    ["hugedomains.com", "domainmarket.com", "undeveloped.com", "godaddy.com"].some(
      (host) => parked === host || parked.endsWith("." + host),
    )
  )
    return { outcome: "parked", reason: "parking page" };
  if (requested && final && registrableDomain(final) !== registrableDomain(requested))
    return {
      outcome: "redirected",
      reason: "off-site redirect to " + (registrableDomain(final) || final),
    };
  if (signals.found || (signals.captured ?? 0) > 0)
    return {
      outcome: "ok",
      reason: signals.captured ? signals.captured + " captured request(s)" : "found what was asked",
    };
  if (signals.readiness === "challenge")
    return { outcome: "blocked", reason: "challenge wording on the page" };
  if (signals.readiness === "login")
    return { outcome: "gated", reason: "sign-in wall, nothing clicked" };
  if (signals.readiness === "not-found" || signals.readiness === "error")
    return { outcome: "dead", reason: "page was " + signals.readiness };
  if (signals.readiness === "empty" || signals.readiness === "ready")
    return { outcome: "shell", reason: "page loaded, nothing found" };
  if (signals.readiness === "loading")
    return { outcome: "error", reason: "still loading at the deadline" };
  return { outcome: "dead", reason: "nothing loaded" };
}

export interface OutcomeSummary {
  total: number;
  counts: Partial<Record<Outcome, number>>;
  dominant?: Outcome;
  okRate: number;
  /** Set when the run looks like a broken method rather than a result. */
  warning?: string;
}

/** Counts, the dominant outcome and the guardrail: a run that found nothing says so. */
export function summarizeOutcomes(outcomes: readonly Outcome[]): OutcomeSummary {
  const counts: Partial<Record<Outcome, number>> = {};
  for (const outcome of outcomes) counts[outcome] = (counts[outcome] ?? 0) + 1;
  const total = outcomes.length;
  const ok = counts.ok ?? 0;
  const dominant = (Object.entries(counts) as [Outcome, number][]).sort(
    (left, right) => right[1] - left[1],
  )[0]?.[0];
  const summary: OutcomeSummary = {
    total,
    counts,
    okRate: total ? Math.round((ok / total) * 1000) / 1000 : 0,
    ...(dominant ? { dominant } : {}),
  };
  if (total >= 1 && ok === 0)
    summary.warning =
      "0 of " +
      total +
      " produced a result" +
      (dominant ? " (mostly " + dominant + ")" : "") +
      "; check the method (gates? play? frames?) before continuing";
  else if (total >= 20 && ok / total < 0.05)
    summary.warning =
      ok +
      " of " +
      total +
      " produced a result (" +
      Math.round((ok / total) * 100) +
      "%); below any plausible base rate — check the method before continuing";
  return summary;
}
