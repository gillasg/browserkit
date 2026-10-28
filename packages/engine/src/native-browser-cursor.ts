// The visible agent cursor and its caption, for the user watching the agent work. Purely
// cosmetic: every update is sent without awaiting, never fails or delays an action, ignores
// pointer input and stays out of the accessibility tree. Animation runs inside the page, so the
// agent moves on while the cursor is still gliding.
import { engineConfig } from "./engine-config.js";
import { browserSessionTabs } from "./native-browser-session.js";
import { onEngineInstall } from "./native-engine-install.js";
export interface CursorUpdate {
  x?: number;
  y?: number;
  /** Click: press the cursor down and ripple. */
  press?: boolean;
  /** I-beam over editable fields. */
  text?: boolean;
  /** Drag: draw a trail from here to x, y. */
  from?: { x: number; y: number };
  /** Caption pill shown beside the cursor. */
  caption?: string;
  /** Reveal the caption letter by letter (visible typing). */
  typing?: boolean;
  /** Skip if another caption appeared in the last moment (reads must not hide actions). */
  soft?: boolean;
  /** Dim the page around a target rectangle (viewport coordinates). */
  spotlight?: { x: number; y: number; width: number; height: number };
  hideSpotlight?: boolean;
  /** A label anchored to a target rectangle. */
  callout?: {
    x: number;
    y: number;
    width?: number;
    height?: number;
    label: string;
    detail?: string;
  };
  /** Show keys being pressed for a moment. */
  keys?: string[];
  /** Caption is an obvious action (click/type): hide it after ~2 s instead of keeping it. */
  transient?: boolean;
  /** Edge glow around a tab an agent drives. */
  glow?: boolean;
  /** The user has control: dim the glow and stop its pulse. */
  glowDim?: boolean;
  /** Create the overlay for the glow without showing the cursor yet. */
  glowOnly?: boolean;
  /** CSS colour for the glow (hex or rgb()). */
  glowColor?: string;
  /** Initial viewport position when the overlay is recreated after a navigation. */
  start?: { x: number; y: number };
  /** The agent waits for the user: amber cursor and spotlight, no glow, the message as caption. */
  needs?: string | null;
  /** The tab is being recorded with the cursor: show only the cursor, nothing else of ours. */
  clean?: boolean;
}

const OVERLAY = `(update) => {
  const id = "aeon-agent-cursor";
  let host = document.getElementById(id);
  if (!host) {
    host = document.createElement("div");
    host.id = id;
    host.setAttribute("data-aeon-overlay", "");
    host.setAttribute("aria-hidden", "true");
    host.style.cssText = "position:fixed;inset:0;z-index:2147483647;pointer-events:none;contain:strict";
    const root = host.attachShadow({ mode: "closed" });
    root.innerHTML = '<style>' +
      '.g{position:fixed;inset:0;border-radius:18px;pointer-events:none;opacity:0;transform:none;box-shadow:inset 0 0 0 2px rgba(139,147,167,.55),inset 0 0 28px rgba(139,147,167,.35);transition:opacity .3s ease;animation:edge 2.4s ease-in-out infinite}' +
      '.g.on{opacity:1}.g.user{animation:none;opacity:.35}.g.on.wait{opacity:.4;animation-duration:4.8s}@keyframes edge{50%{opacity:.55}}' +
      '.needs .g{opacity:0!important}.needs .a path{fill:#e08a00}.needs .t path{stroke:#e08a00}.needs .p{background:#e08a00!important}.needs .s{border-color:rgba(224,138,0,.95)}' +
      '.clean .g,.clean .p,.clean .s,.clean .co,.clean .k,.clean svg.trail{display:none!important}' +
      '.c{position:absolute;left:0;top:0;will-change:transform;transition:opacity .18s ease}' +
      '.a,.t{position:absolute;left:-3px;top:-2px;filter:drop-shadow(0 2px 4px rgba(15,23,42,.35));transition:transform 120ms ease,opacity 120ms ease}' +
      '.t{left:-6px;top:-11px;opacity:0}.c.text .a{opacity:0}.c.text .t{opacity:1}' +
      '.c.down .a,.c.down .t{transform:scale(.82)}' +
      '.c.idle .a{animation:b 2.4s ease-in-out infinite}@keyframes b{50%{transform:scale(1.06);opacity:.85}}' +
      'i{position:absolute;left:-16px;top:-16px;width:32px;height:32px;border-radius:50%;border:2px solid rgba(99,102,241,.7);background:rgba(99,102,241,.18);transform:scale(0);opacity:0}' +
      'i.on{animation:r 520ms cubic-bezier(.2,.7,.2,1)}@keyframes r{0%{transform:scale(.25);opacity:1}100%{transform:scale(1.6);opacity:0}}' +
      '.p{position:absolute;left:18px;top:20px;max-width:320px;padding:5px 10px;border-radius:999px;background:rgba(17,24,39,.88);color:#fff;font:500 12px/16px system-ui,-apple-system,Segoe UI,sans-serif;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;box-shadow:0 4px 14px rgba(0,0,0,.25);opacity:0;transform:translateY(-3px);transition:opacity 160ms ease,transform 160ms ease}' +
      '.p.on{opacity:1;transform:none}' +
      'svg.trail{position:absolute;inset:0;width:100%;height:100%;overflow:visible}' +
      '</style><div class="w"><div class="g"></div><svg class="trail"></svg><div class="c"><i></i>' +
      '<svg class="a" width="22" height="24" viewBox="0 0 22 24"><path d="M2 2l7.5 19 2.6-7.6L20 10.8z" fill="#4f46e5" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></svg>' +
      '<svg class="t" width="12" height="22" viewBox="0 0 12 22"><path d="M2 1.5h8M2 20.5h8M6 1.5v19" stroke="#4f46e5" stroke-width="2.2" stroke-linecap="round" fill="none"/></svg>' +
      '<div class="p"></div></div></div>';
    const extras = document.createElement("div");
    extras.innerHTML = '<style>' +
      '.s{position:fixed;left:0;top:0;border-radius:12px;border:2px solid rgba(99,102,241,.9);box-shadow:0 0 0 9999px rgba(15,23,42,.55);opacity:0;pointer-events:none;transition:left .25s ease,top .25s ease,width .25s ease,height .25s ease,opacity .2s ease}' +
      '.s.on{opacity:1}' +
      '.co{position:fixed;max-width:280px;padding:7px 10px;border-radius:10px;background:#111827;color:#fff;font:500 12px/16px system-ui,-apple-system,Segoe UI,sans-serif;box-shadow:0 8px 24px rgba(0,0,0,.3);opacity:0;transform:translateY(4px);transition:opacity .18s ease,transform .18s ease;pointer-events:none}' +
      '.co.on{opacity:1;transform:none}.co b{display:block;font-weight:600}.co span{display:block;opacity:.75;font-size:11px;margin-top:2px}' +
      '.k{position:fixed;left:50%;bottom:26px;transform:translateX(-50%) translateY(6px);padding:6px 10px;border-radius:8px;background:rgba(17,24,39,.9);color:#fff;font:600 11px/14px system-ui;opacity:0;transition:opacity .18s ease,transform .18s ease;pointer-events:none}' +
      '.k.on{opacity:1;transform:translateX(-50%)}' +
      '</style><div class="s"></div><div class="co"></div><div class="k"></div>';
    const wrap = root.querySelector(".w");
    wrap.append(...extras.childNodes);
    const state = host.__s = {
      root, wrap, cursor: root.querySelector(".c"), ripple: root.querySelector("i"),
      glow: root.querySelector(".g"), glowColor: "",
      pill: root.querySelector(".p"), trail: root.querySelector("svg.trail"),
      spotlight: root.querySelector(".s"), callout: root.querySelector(".co"), keys: root.querySelector(".k"),
      pageX: update.start ? update.start.x + scrollX : innerWidth / 2 + scrollX,
      pageY: update.start ? update.start.y + scrollY : innerHeight / 2 + scrollY,
      frame: 0, idle: 0, hide: 0, type: 0, cursorShown: false,
    };
    // Pinned to the page, not the viewport: when the page scrolls, the cursor scrolls with it.
    const place = () => { state.cursor.style.transform = "translate(" + (state.pageX - scrollX) + "px," + (state.pageY - scrollY) + "px)"; };
    state.place = place;
    addEventListener("scroll", place, { passive: true, capture: true });
    (document.documentElement || document.body).append(host);
    place();
  }
  const s = host.__s;
  if (update.glowColor && update.glowColor !== s.glowColor) {
    s.glowColor = update.glowColor;
    const rgb = toRgb(update.glowColor);
    if (rgb) s.glow.style.boxShadow = "inset 0 0 0 2px rgba(" + rgb + ",.55),inset 0 0 28px rgba(" + rgb + ",.35)";
    // A product colour also colours the caption, so cursor, caption and glow read as one thing.
    if (rgb && update.glowColor !== "#8b93a7") s.pill.style.background = "rgba(" + rgb + ",.95)";
  }
  if (update.glowOnly && !s.cursorShown) s.cursor.style.opacity = "0";
  if (update.x !== undefined || update.y !== undefined) {
    s.cursorShown = true;
    s.cursor.style.opacity = "1";
  }
  if (update.glow !== undefined) s.glow.classList.toggle("on", update.glow);
  if (update.glowDim !== undefined) s.glow.classList.toggle("user", update.glowDim);
  if (update.clean !== undefined) s.wrap.classList.toggle("clean", update.clean);
  if (update.needs !== undefined) {
    s.wrap.classList.toggle("needs", Boolean(update.needs));
    if (update.needs) { s.cursor.style.opacity = "1"; s.cursorShown = true; }
    else { s.spotlight.classList.remove("on"); s.pill.classList.remove("on"); }
  }
  s.cursor.classList.remove("idle");
  s.glow.classList.remove("wait");
  clearTimeout(s.idle);
  clearTimeout(s.waitTimer);
  s.idle = setTimeout(() => s.cursor.classList.add("idle"), 2200);
  // Nothing happened for a while: the agent is waiting (a page, a reply), so the glow dims.
  s.waitTimer = setTimeout(() => s.glow.classList.add("wait"), 6000);
  if (update.text !== undefined) s.cursor.classList.toggle("text", update.text);
  if (update.spotlight) {
    s.spotlight.style.left = update.spotlight.x + "px";
    s.spotlight.style.top = update.spotlight.y + "px";
    s.spotlight.style.width = update.spotlight.width + "px";
    s.spotlight.style.height = update.spotlight.height + "px";
    s.spotlight.classList.add("on");
  }
  if (update.hideSpotlight) s.spotlight.classList.remove("on");
  if (update.callout) {
    const c = update.callout;
    s.callout.textContent = "";
    const label = document.createElement("b");
    label.textContent = String(c.label || "").slice(0, 80);
    s.callout.append(label);
    if (c.detail) {
      const detail = document.createElement("span");
      detail.textContent = String(c.detail).slice(0, 120);
      s.callout.append(detail);
    }
    s.callout.style.left = Math.max(8, Math.min(innerWidth - 288, c.x)) + "px";
    s.callout.style.top = (c.y > 60 ? c.y - 44 : c.y + (c.height || 0) + 8) + "px";
    s.callout.classList.add("on");
  }
  if (update.keys && update.keys.length) {
    s.keys.textContent = "⌨ " + update.keys.slice(0, 4).join(" + ");
    s.keys.classList.add("on");
    clearTimeout(s.keysHide);
    s.keysHide = setTimeout(() => s.keys.classList.remove("on"), 2400);
  }
  if (typeof update.x === "number" && typeof update.y === "number") {
    // Glide along a gentle curve with ease-out, sized to the distance travelled.
    const fromX = s.pageX, fromY = s.pageY, toX = update.x + scrollX, toY = update.y + scrollY;
    const dx = toX - fromX, dy = toY - fromY, distance = Math.hypot(dx, dy);
    const duration = Math.min(520, 140 + distance * 0.45), bend = Math.min(80, distance * 0.18);
    const cx = fromX + dx / 2 - (dy / (distance || 1)) * bend, cy = fromY + dy / 2 + (dx / (distance || 1)) * bend;
    const start = performance.now();
    cancelAnimationFrame(s.frame);
    const step = (now) => {
      const t = Math.min(1, (now - start) / duration), e = 1 - Math.pow(1 - t, 3);
      s.pageX = (1 - e) * (1 - e) * fromX + 2 * (1 - e) * e * cx + e * e * toX;
      s.pageY = (1 - e) * (1 - e) * fromY + 2 * (1 - e) * e * cy + e * e * toY;
      s.place();
      if (t < 1) s.frame = requestAnimationFrame(step);
      else if (update.press) press();
    };
    s.frame = requestAnimationFrame(step);
    if (update.from) trail(update.from.x, update.from.y, update.x, update.y);
  } else if (update.press) press();
  function press() {
    s.cursor.classList.add("down");
    setTimeout(() => s.cursor.classList.remove("down"), 140);
    s.ripple.classList.remove("on"); void s.ripple.offsetWidth; s.ripple.classList.add("on");
  }
  function trail(x1, y1, x2, y2) {
    s.trail.innerHTML = '<path d="M' + x1 + ' ' + y1 + ' L' + x2 + ' ' + y2 + '" stroke="rgba(99,102,241,.55)" stroke-width="3" stroke-linecap="round" stroke-dasharray="6 6" fill="none"/>';
    setTimeout(() => { s.trail.innerHTML = ""; }, 900);
  }
  if (update.needs) update.caption = update.needs;
  if (update.caption && !(update.soft && Date.now() - (s.captionAt || 0) < 1500)) {
    s.captionAt = Date.now();
    const text = String(update.caption).slice(0, 120);
    clearTimeout(s.hide); clearInterval(s.type);
    s.pill.classList.add("on");
    if (update.typing) {
      // Visual only: the real text is already in the field; the caption just reveals it.
      let shown = 0; const prefix = text.indexOf('"') + 1;
      s.pill.textContent = text.slice(0, prefix);
      s.type = setInterval(() => {
        shown += Math.max(1, Math.ceil((text.length - prefix) / 12));
        s.pill.textContent = text.slice(0, prefix + shown);
        if (prefix + shown >= text.length) clearInterval(s.type);
      }, 22);
    } else s.pill.textContent = text;
    if (!update.needs) s.hide = setTimeout(() => s.pill.classList.remove("on"), update.transient ? 2000 : 6000);
  }
  function toRgb(color) {
    var text = String(color || "").trim();
    var hex = /^#([0-9a-f]{6})$/i.exec(text);
    if (hex) {
      var n = parseInt(hex[1], 16);
      return ((n >> 16) & 255) + "," + ((n >> 8) & 255) + "," + (n & 255);
    }
    if (text.indexOf("rgb") !== 0) return "";
    var parts = text.slice(text.indexOf("(") + 1, text.lastIndexOf(")")).split(",");
    return parts.length >= 3 ? parts.slice(0, 3).map(function (part) { return String(Number(part)).trim(); }).join(",") : "";
  }
}`;

export function showAgentCursor(
  debuggee: chrome.debugger.Debuggee,
  x: number,
  y: number,
  press = false,
  extra: Omit<CursorUpdate, "x" | "y" | "press"> = {},
): void {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return;
  const tabId = debuggee.tabId;
  const prior = tabId === undefined ? undefined : lastPositions.get(tabId);
  updateAgentCursor(debuggee, {
    ...extra,
    ...(prior && extra.start === undefined ? { start: prior } : {}),
    x: Math.round(x),
    y: Math.round(y),
    press,
  });
  if (tabId !== undefined) lastPositions.set(tabId, { x: Math.round(x), y: Math.round(y) });
}
const lastPositions = new Map<number, { x: number; y: number }>();
onEngineInstall(() => {
  chrome.tabs.onRemoved.addListener((tabId) => lastPositions.delete(tabId));
});

/** A caption without moving the cursor, e.g. while reading or navigating. */
export function showAgentCaption(debuggee: chrome.debugger.Debuggee, caption: string): void {
  updateAgentCursor(debuggee, { caption, soft: true });
}

// Tabs being recorded on video: nothing of ours is drawn, or only the cursor when asked for.
const recording = new Map<number, { cursor: boolean }>();
export function setTabRecording(tabId: number, state: { cursor: boolean } | undefined): void {
  if (state) recording.set(tabId, state);
  else recording.delete(tabId);
  if (state && !state.cursor) void removeAgentCursor(tabId);
  if (state?.cursor) updateAgentCursor({ tabId }, { glow: false });
}
export function tabRecording(tabId: number): { cursor: boolean } | undefined {
  return recording.get(tabId);
}

/** The toolbar dot on a tab an agent drives: the product colour, amber while it needs the user.
 * Extensions cannot mark the tab itself, so the dot sits on the toolbar icon of that tab. */
export async function showAgentBadge(tabId: number, needs = false): Promise<void> {
  const glow = await engineConfig.agentGlowColor().catch(() => NEUTRAL_GLOW);
  const color = needs ? "#e08a00" : glow === NEUTRAL_GLOW ? "#4f46e5" : glow;
  await chrome.action.setBadgeText({ tabId, text: " " }).catch(() => undefined);
  await chrome.action.setBadgeBackgroundColor({ tabId, color }).catch(() => undefined);
}
const NEUTRAL_GLOW = "#8b93a7";

/** The agent waits for the user: the cursor turns amber, points (spotlight) and says why. */
export function showAgentNeeds(
  tabId: number,
  message: string | null,
  spotlight?: { x: number; y: number; width: number; height: number },
): void {
  const point = spotlight
    ? {
        x: Math.round(spotlight.x + spotlight.width / 2),
        y: Math.round(spotlight.y + spotlight.height / 2),
      }
    : undefined;
  void showAgentBadge(tabId, message !== null);
  updateAgentCursor(
    { tabId },
    {
      needs: message,
      ...(message !== null ? { glow: false } : { glow: true, hideSpotlight: true }),
      ...(spotlight && message !== null ? { spotlight, ...point } : {}),
    },
  );
}

/** The edge glow around a tab an agent drives; dimmed while the user has control. */
export async function showAgentGlow(tabId: number, dim = false): Promise<void> {
  if (!(await engineConfig.agentGlow().catch(() => true))) return;
  const glowColor = await engineConfig.agentGlowColor().catch(() => "#8b93a7");
  updateAgentCursor({ tabId }, { glow: true, glowDim: dim, glowOnly: true, glowColor });
}

export function dimAgentGlow(tabId: number, dim: boolean): void {
  updateAgentCursor({ tabId }, { glowDim: dim });
}

export function hideAgentGlow(tabId: number): void {
  updateAgentCursor({ tabId }, { glow: false });
}

/** Dim the page around a target, e.g. for a write confirmation or a hand-off. */
export function showAgentSpotlight(
  debuggee: chrome.debugger.Debuggee,
  rect: { x: number; y: number; width: number; height: number },
): void {
  updateAgentCursor(debuggee, { spotlight: rect });
}

export function hideAgentSpotlight(debuggee: chrome.debugger.Debuggee): void {
  updateAgentCursor(debuggee, { hideSpotlight: true });
}

/** A label anchored to a target, with an optional second line. */
export function showAgentCallout(
  debuggee: chrome.debugger.Debuggee,
  rect: { x: number; y: number; width?: number; height?: number },
  label: string,
  detail?: string,
): void {
  updateAgentCursor(debuggee, {
    callout: { ...rect, label, ...(detail !== undefined ? { detail } : {}) },
  });
}

/** Show the keys being pressed for a moment. */
export function showAgentKeys(debuggee: chrome.debugger.Debuggee, keys: string[]): void {
  updateAgentCursor(debuggee, { keys });
}

function updateAgentCursor(debuggee: chrome.debugger.Debuggee, update: CursorUpdate): void {
  const recorded = debuggee.tabId === undefined ? undefined : recording.get(debuggee.tabId);
  if (recorded && !recorded.cursor) return;
  if (recorded) update = { ...update, clean: true, glow: false };
  void engineConfig
    .hideAgentCursor()
    .catch(() => false)
    .then((hidden) =>
      hidden
        ? undefined
        : chrome.debugger.sendCommand(debuggee, "Runtime.evaluate", {
            expression: `(${OVERLAY})(${JSON.stringify(update)})`,
            silent: true,
          }),
    )
    .catch(() => undefined);
}

/** Fade out and remove the cursor in a session's tabs (all tabs without a session), e.g. once
 * the agent's turn is over. */
export async function clearAgentCursors(chatId?: string): Promise<void> {
  await Promise.all(browserSessionTabs(chatId).map(removeAgentCursor));
}
export async function removeAgentCursor(tabId: number): Promise<void> {
  // Cosmetic: never fails, also where scripting is unavailable.
  await Promise.resolve()
    .then(() =>
      chrome.scripting.executeScript({ target: { tabId }, world: "MAIN", func: removeCursor }),
    )
    .catch(() => undefined);
}
function removeCursor(): void {
  const host = document.getElementById("aeon-agent-cursor");
  if (!host) return;
  host.style.transition = "opacity 300ms ease";
  host.style.opacity = "0";
  setTimeout(() => host.remove(), 320);
}
