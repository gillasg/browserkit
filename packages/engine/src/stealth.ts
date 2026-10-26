// What a page can learn about being driven. The probe runs in the page; the engine adds what
// only it knows (an open Runtime domain, scripts queued for every new document). Detection is
// reported, never hidden: page.stealthCheck() is a diagnostic, not a guarantee.

const injected = new Map<number, Set<string>>();

/** Records a script the engine queued for every document of a tab, so checks can name it. */
export function noteInjectedScript(tabId: number, label: string): void {
  const labels = injected.get(tabId) ?? new Set<string>();
  labels.add(label);
  injected.set(tabId, labels);
}

export function injectedScripts(tabId: number): string[] {
  return [...(injected.get(tabId) ?? [])];
}

export function forgetStealth(tabId: number): void {
  injected.delete(tabId);
}

export interface StealthProbe {
  webdriver?: boolean;
  globals?: string[];
  overlays?: string[];
  wrapped?: string[];
  geolocationShim?: boolean;
  isolatedNames?: string[];
}

export interface StealthState {
  runtimeEnabled: boolean;
  injectedScripts: string[];
}

export interface StealthReport extends StealthState {
  detectable: boolean;
  /** One readable line per signal a page can see. */
  signals: string[];
  probe: StealthProbe;
}

/** Turns the page's observations and the engine's own state into named, readable signals. */
export function judgeStealth(probe: StealthProbe, state: StealthState): StealthReport {
  const signals: string[] = [];
  if (probe.webdriver === true)
    signals.push("navigator.webdriver is true (Chrome is in automation mode)");
  if (state.runtimeEnabled)
    signals.push("the Runtime domain is enabled for this tab (console capture is on)");
  for (const name of probe.globals ?? [])
    signals.push(`a page global named ${name} was added by the agent`);
  for (const name of probe.overlays ?? []) signals.push(`an agent overlay is present: ${name}`);
  for (const name of probe.wrapped ?? [])
    signals.push(`${name} is wrapped and its function source is not native`);
  if (probe.geolocationShim === true)
    signals.push("navigator.geolocation is answered by the agent's location shim");
  for (const name of state.injectedScripts)
    signals.push(`a script is queued for every document of this tab: ${name}`);
  return {
    detectable: signals.length > 0,
    signals,
    runtimeEnabled: state.runtimeEnabled,
    injectedScripts: state.injectedScripts,
    probe,
  };
}
