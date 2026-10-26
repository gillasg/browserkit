// Events from browserkit's own page chrome (the vault save banner, the sign-in approval bar)
// must not read as the user taking over the tab. The listener runs in the isolated world, where
// the page cannot forge these attributes.
export function isBrowserkitOverlay(target: EventTarget | null | undefined): boolean {
  const element = target as { hasAttribute?: (name: string) => boolean } | null | undefined;
  return Boolean(element?.hasAttribute?.("data-browserkit-overlay"));
}

export function isBrowserkitOverlayEvent(path: readonly EventTarget[]): boolean {
  return path.some(isBrowserkitOverlay);
}
