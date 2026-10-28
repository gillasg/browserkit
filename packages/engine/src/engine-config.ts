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
  /** How a chat shows the tabs its agent works in; the host may answer per chat. */
  agentView: (chatId: string) => Promise<"split" | "thumbnails">;
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
  /** Whether a tab an agent drives shows the edge glow. Off lets tests and recorders hide it. */
  agentGlow: () => Promise<boolean>;
  /** CSS colour of the edge glow: neutral here, a product colour in hosts such as Aeon. */
  agentGlowColor: () => Promise<string>;
  /** Opt-in private/metadata network refusal for agent work. */
  privateNetwork: () => Promise<boolean>;
  privateNetworkPorts: () => Promise<number[]>;
}

export const engineConfig: EngineConfig = {
  controllingTitle: () => "An agent is controlling this tab",
  idleTitle: "browserkit",
  notificationIcon: "icon-128.png",
  tabGroups: true,
  tabGroupTitle: (_owner, title) => title ?? "Agent",
  agentView: () => Promise.resolve("split"),
  agentInFront: () => Promise.resolve(false),
  hideAgentCursor: async () =>
    (
      (await chrome.storage.local.get("browserkit-hide-agent-cursor").catch(() => ({}))) as Record<
        string,
        unknown
      >
    )["browserkit-hide-agent-cursor"] === true,
  agentGlow: () => Promise.resolve(true),
  agentGlowColor: () => Promise.resolve("#8b93a7"),
  privateNetwork: async () =>
    Boolean(
      (
        (await chrome.storage.local.get("private-network").catch(() => ({}))) as Record<
          string,
          unknown
        >
      )["private-network"],
    ),
  privateNetworkPorts: async () => {
    const saved = await chrome.storage.local
      .get("private-network-ports")
      .catch(() => ({}) as Record<string, unknown>);
    const ports = saved["private-network-ports"];
    return Array.isArray(ports)
      ? ports.map(Number).filter((port) => Number.isInteger(port) && port > 0)
      : [3000, 5173, 8080];
  },
  defaultSpace: () => "tabs",
};

export function configureEngine(patch: Partial<EngineConfig>): void {
  Object.assign(engineConfig, patch);
}
