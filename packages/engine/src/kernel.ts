// The kernel: the one door from browser code to Chrome and the web. Every request a cell makes
// is matched to a declared effect, and the kernel applies the effect's needs before it runs:
// a tab it names must belong to this cell's reach and sit on an allowed site, and a URL it names
// must pass the user's site rules. A new feature adds an effect here (or composes existing
// ones); it never talks to Chrome on its own, so these rules hold for every feature.

export interface Effect<Cell> {
  /** The effect's name in the kernel spec, for errors and traces. */
  name: string;
  match(value: Record<string, unknown>): boolean;
  /** Where the request names its tab; the kernel authorizes and guards that tab. */
  tab?: (value: Record<string, unknown>) => unknown;
  /** The URL or site the request reaches; the kernel checks it against the site rules. */
  site?: (value: Record<string, unknown>) => unknown;
  run(cell: Cell, value: Record<string, unknown>, tabId: number | undefined): Promise<unknown>;
}

export interface KernelChecks<Cell> {
  /** The tab's id when this cell may use it; throws INVALID_TARGET otherwise. */
  authorize(cell: Cell, target: unknown): number;
  /** Refuses a tab on a blocked site (SITE_BLOCKED). */
  guardTab(cell: Cell, tabId: number): Promise<void>;
  /** Refuses a blocked URL or site (SITE_BLOCKED). */
  guardSite(cell: Cell, site: unknown): Promise<void>;
}

/** Runs the first effect that matches, after its declared needs pass; undefined when none does. */
export async function runEffect<Cell>(
  effects: readonly Effect<Cell>[],
  checks: KernelChecks<Cell>,
  cell: Cell,
  value: Record<string, unknown>,
): Promise<{ value: unknown } | undefined> {
  const effect = effects.find((candidate) => candidate.match(value));
  if (!effect) return undefined;
  let tabId: number | undefined;
  if (effect.tab) {
    tabId = checks.authorize(cell, effect.tab(value));
    await checks.guardTab(cell, tabId);
  }
  if (effect.site) await checks.guardSite(cell, effect.site(value));
  return { value: await effect.run(cell, value, tabId) };
}

export const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;
