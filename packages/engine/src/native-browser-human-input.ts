// Human-like pointer and keyboard timing for input sent through the debugger.

type Point = { x: number; y: number };
type Params = Record<string, unknown>;

const random = (min: number, max: number) => min + Math.random() * (max - min);
const noise = (scale: number) => (Math.random() + Math.random() + Math.random() - 1.5) * scale;
const sleep = (ms: number) =>
  ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();
const minimumJerk = (t: number) => t * t * t * (10 - 15 * t + 6 * t * t);

function bezier(p0: Point, p1: Point, p2: Point, p3: Point, t: number): Point {
  const u = 1 - t;
  return {
    x: u * u * u * p0.x + 3 * u * u * t * p1.x + 3 * u * t * t * p2.x + t * t * t * p3.x,
    y: u * u * u * p0.y + 3 * u * u * t * p1.y + 3 * u * t * t * p2.y + t * t * t * p3.y,
  };
}

/** Points and delays for one human-looking movement from `from` to `to`. */
export function trajectory(from: Point, to: Point): { point: Point; delay: number }[] {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const distance = Math.hypot(dx, dy);
  if (distance < 2) return [];
  // Fitts' law with a ~40 px target, plus personal variation.
  const duration = Math.min(1100, (90 + 110 * Math.log2(distance / 40 + 1)) * random(0.85, 1.25));
  const normal = { x: -dy / distance, y: dx / distance };
  const bow = (Math.random() < 0.5 ? -1 : 1) * random(0.04, 0.18) * distance;
  const c1 = {
    x: from.x + dx * random(0.2, 0.35) + normal.x * bow,
    y: from.y + dy * random(0.2, 0.35) + normal.y * bow,
  };
  const c2 = {
    x: from.x + dx * random(0.65, 0.8) + normal.x * bow * 0.6,
    y: from.y + dy * random(0.65, 0.8) + normal.y * bow * 0.6,
  };
  const overshoot = distance > 250 && Math.random() < 0.25;
  const end = overshoot
    ? { x: to.x + (dx / distance) * random(4, 12), y: to.y + (dy / distance) * random(4, 12) }
    : to;
  const points: { point: Point; delay: number }[] = [];
  let elapsed = 0;
  while (elapsed < duration) {
    const step = random(8, 17);
    elapsed = Math.min(duration, elapsed + step);
    const s = minimumJerk(elapsed / duration);
    const p = bezier(from, c1, c2, end, s);
    const tremor = (1 - s) * 0.9;
    points.push({ point: { x: p.x + noise(tremor), y: p.y + noise(tremor) }, delay: step });
  }
  if (overshoot) {
    const back = Math.max(3, Math.round(random(4, 7)));
    for (let i = 1; i <= back; i++) {
      const s = minimumJerk(i / back);
      points.push({
        point: { x: end.x + (to.x - end.x) * s, y: end.y + (to.y - end.y) * s },
        delay: random(10, 18),
      });
    }
  }
  // The caller's own event lands exactly on the target; drop a sample that duplicates it.
  points.pop();
  return points.map(({ point, delay }) => ({
    point: { x: Math.round(point.x * 10) / 10, y: Math.round(point.y * 10) / 10 },
    delay,
  }));
}

type TabState = {
  pointer?: Point;
  aim?: Point & { dx: number; dy: number };
  arrivedAt: number;
  pressedAt?: number;
  lastKeyAt: number;
  queue: Promise<void>;
};

const tabs = new Map<number, TabState>();
let enabled = true;

/** Turn the pacing off for a fast run (tests, bulk reads). */
export function setHumanInputEnabled(value: boolean): void {
  enabled = value;
}

export function forgetHumanInput(tabId: number): void {
  tabs.delete(tabId);
}

function state(tabId: number): TabState {
  let value = tabs.get(tabId);
  if (!value) {
    value = { arrivedAt: 0, lastKeyAt: 0, queue: Promise.resolve() };
    tabs.set(tabId, value);
  }
  return value;
}

async function dispatch(debuggee: chrome.debugger.Debuggee, type: string, params: Params) {
  await chrome.debugger
    .sendCommand(debuggee, "Input.dispatchMouseEvent", { type, ...params })
    .catch(() => undefined);
}

/** Sends the curved movement leading up to a target and returns the adjusted params. */
export async function humanMouse(
  debuggee: chrome.debugger.Debuggee,
  method: string,
  params: Params,
): Promise<Params> {
  if (!enabled || debuggee.tabId === undefined) return params;
  const tab = state(debuggee.tabId);
  let output: Params = params;
  const run = tab.queue.then(async () => {
    output = await paceMouse(debuggee, tab, method, params);
  });
  tab.queue = run.catch(() => undefined);
  await run;
  return output;
}

async function paceMouse(
  debuggee: chrome.debugger.Debuggee,
  tab: TabState,
  method: string,
  params: Params,
): Promise<Params> {
  if (method === "mouseWheel") {
    const dx = Number(params.deltaX ?? 0);
    const dy = Number(params.deltaY ?? 0);
    const frames = glide(dx, dy);
    const last = frames.pop();
    for (const frame of frames)
      await dispatch(debuggee, "mouseWheel", { ...params, deltaX: frame.x, deltaY: frame.y });
    return last ? { ...params, deltaX: last.x, deltaY: last.y } : params;
  }
  if (typeof params.x !== "number" || typeof params.y !== "number") return params;
  // People land a few pixels off center, consistently for one target.
  if (!tab.aim || Math.hypot(tab.aim.x - params.x, tab.aim.y - params.y) >= 1)
    tab.aim = { x: params.x, y: params.y, dx: noise(1.4), dy: noise(1.0) };
  const x = Math.round((params.x + tab.aim.dx) * 10) / 10;
  const y = Math.round((params.y + tab.aim.dy) * 10) / 10;
  const output = { ...params, x, y };
  const dragging = typeof params.buttons === "number" && params.buttons > 0;
  if (method === "mouseMoved" && !dragging) await travel(debuggee, tab, { x, y }, params);
  else if (
    (method === "mousePressed" || method === "mouseReleased") &&
    tab.pointer &&
    Math.hypot(tab.pointer.x - x, tab.pointer.y - y) >= 2
  )
    await travel(debuggee, tab, { x, y }, params);
  if (method === "mousePressed") {
    await sleep(random(45, 130) - (Date.now() - tab.arrivedAt));
    tab.pressedAt = Date.now();
  }
  if (method === "mouseReleased" && tab.pressedAt !== undefined) {
    await sleep(random(60, 140) - (Date.now() - tab.pressedAt));
    delete tab.pressedAt;
  }
  tab.pointer = { x, y };
  return output;
}

async function travel(
  debuggee: chrome.debugger.Debuggee,
  tab: TabState,
  to: Point,
  params: Params,
): Promise<void> {
  // The first movement on a page starts from somewhere plausible, not the corner.
  const from = tab.pointer ?? { x: to.x + random(-260, 260), y: to.y + random(-180, 180) };
  const path = trajectory(from, to);
  for (const { point, delay } of path) {
    const sent = Date.now();
    await dispatch(debuggee, "mouseMoved", {
      x: point.x,
      y: point.y,
      ...(typeof params.button === "string" ? { button: params.button } : {}),
      ...(typeof params.buttons === "number" ? { buttons: params.buttons } : {}),
      ...(typeof params.modifiers === "number" ? { modifiers: params.modifiers } : {}),
    });
    await sleep(delay - (Date.now() - sent));
  }
  tab.arrivedAt = Date.now();
}

/** Per-frame wheel deltas for one scroll: a quick start that eases out, at ~60 Hz. */
function glide(dx: number, dy: number): Point[] {
  const distance = Math.hypot(dx, dy);
  if (distance < 40) return [{ x: dx, y: dy }];
  const frames = Math.max(
    4,
    Math.round((Math.min(650, 140 + distance * 0.45) * random(0.85, 1.15)) / 16.7),
  );
  const ease = (t: number) => 1 - (1 - t) ** 3;
  return Array.from({ length: frames }, (_, index) => ({
    x: dx * (ease((index + 1) / frames) - ease(index / frames)),
    y: dy * (ease((index + 1) / frames) - ease(index / frames)),
  }));
}

/** Space consecutive key presses like a person. */
export async function paceKey(debuggee: chrome.debugger.Debuggee): Promise<void> {
  if (!enabled || debuggee.tabId === undefined) return;
  const tab = state(debuggee.tabId);
  const gap = random(30, 110) - (Date.now() - tab.lastKeyAt);
  if (gap > 0 && tab.lastKeyAt > 0 && Date.now() - tab.lastKeyAt < 1000) await sleep(gap);
  tab.lastKeyAt = Date.now();
}

/** Type one character at a time, with key spacing. */
export async function humanType(debuggee: chrome.debugger.Debuggee, text: string): Promise<void> {
  if (!enabled) {
    await chrome.debugger.sendCommand(debuggee, "Input.insertText", { text });
    return;
  }
  for (const char of text) {
    await paceKey(debuggee);
    await chrome.debugger.sendCommand(debuggee, "Input.insertText", { text: char });
  }
}
