// Host-specific presentation. Each extension that embeds the engine sets these once at startup.
export interface EngineConfig {
  /** Toolbar tooltip while an agent controls a tab. */
  controllingTitle: (owner: string) => string;
  /** Toolbar tooltip once control ends. */
  idleTitle: string;
  /** Extension-relative icon used for hand-off notifications. */
  notificationIcon: string;
  /** Whether tabs an agent opens are grouped per session. */
  tabGroups: boolean;
  /** Label of a session's tab group; the host may pass the chat, routine or session name. */
  tabGroupTitle: (owner: string, ownerTitle?: string) => string;
  /** How a chat page shows its agent's tabs: Split View beside the chat, or live thumbnails. */
  agentView: () => Promise<"split" | "thumbnails">;
  /**
   * Whether the agent works in the foreground: its tabs open active and switching activates them.
   * Off by default. Screen recorders (Aperture) rely on it to film the agent's work; keep it.
   */
  agentInFront: () => Promise<boolean>;
  /**
   * Where a new tab goes when the caller did not choose: its own background window for bulk or
   * outside work, or the user's window for an interactive chat. Hosts decide from their origin.
   */
  defaultSpace: (owner: string) => "window" | "tabs";
  /**
   * Whether to hide the agent cursor and its caption. Off by default. Screen recorders (Aperture)
   * draw their own cursor and rely on this; keep it.
   */
  hideAgentCursor: () => Promise<boolean>;
}

export const engineConfig: EngineConfig = {
  controllingTitle: () => "An agent is controlling this tab",
  idleTitle: "browserkit",
  notificationIcon: "icon-128.png",
  tabGroups: true,
  tabGroupTitle: () => "Agent",
  agentView: () => Promise.resolve("split"),
  agentInFront: () => Promise.resolve(false),
  hideAgentCursor: () => Promise.resolve(false),
  defaultSpace: () => "tabs",
};

export function configureEngine(patch: Partial<EngineConfig>): void {
  Object.assign(engineConfig, patch);
}
