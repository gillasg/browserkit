import type { Ability, AbilityHost, AbilityWay } from "./abilities.js";

// What each way of doing an ability needs from the host that runs it. Needs are read off the
// ways themselves, so they can never drift from what the ability does. A way whose need the host
// lacks is refused before it starts (ABILITY_NEEDS), instead of failing halfway or quietly
// skipping a step such as opening the page first.

export type AbilityNeed = "site-api" | "page-open" | "page-collect" | "page-script" | "workflow";

const PROVIDED: Record<AbilityNeed, (host: AbilityHost) => boolean> = {
  "site-api": (host) => Boolean(host.call ?? host.write),
  "page-open": (host) => Boolean(host.open),
  "page-collect": (host) => Boolean(host.collect),
  "page-script": (host) => Boolean(host.script),
  workflow: (host) => Boolean(host.workflow),
};

export function wayNeeds(way: AbilityWay): AbilityNeed[] {
  if (way.kind === "api") return way.open ? ["site-api", "page-open"] : ["site-api"];
  if (way.kind === "steps") return ["workflow"];
  if (way.kind === "page") return ["page-collect"];
  // A node script calls the site API through the host or, without one, the shared transport.
  return way.runtime === "page" ? ["page-script"] : [];
}

/** Everything the ability can need, over all its ways. */
export function abilityNeeds(ability: Pick<Ability, "ways">): AbilityNeed[] {
  return [...new Set(ability.ways.flatMap(wayNeeds))];
}

/** The needs of this way the host cannot meet. */
export function missingNeeds(way: AbilityWay, host: AbilityHost): AbilityNeed[] {
  return wayNeeds(way).filter((need) => !PROVIDED[need](host));
}

/** "ABILITY_NEEDS: …" when the host cannot run this way, else undefined. */
export function needsError(way: AbilityWay, host: AbilityHost): string | undefined {
  const missing = missingNeeds(way, host);
  return missing.length
    ? `ABILITY_NEEDS: this host cannot run a ${way.kind} way (no ${missing.join(", ")})`
    : undefined;
}
