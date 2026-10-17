import type { WaiterStyle } from './waiter';

/**
 * start.ng player bridge.
 *
 * Follows the official recipe from https://start.ng/docs.md: a hidden iframe of
 * https://start.ng/connect, talked to with postMessage. The reply is only
 * trusted when it comes from that frame's window and origin.
 *
 * Everything here is optional: when start.ng does not answer (local play, or
 * any other host) the caller simply gets `null` and keeps the default look, so
 * the game is always playable.
 */

const START_NG = 'https://start.ng';
const TIMEOUT_MS = 2500;

export interface StartNgPlayer {
  /** Character name (docs: "their character's name"). */
  name: string;
  /** Account name, null for guests. */
  account: string | null;
  /** Normalised character style, ready for `waiter.setStyle`. */
  style: Partial<WaiterStyle> | null;
  /** PNG data URL of the character's face, may be absent. */
  face: string | null;
  signedIn: boolean;
}

let framePromise: Promise<HTMLIFrameElement> | null = null;

function connectFrame(): Promise<HTMLIFrameElement> {
  framePromise ??= new Promise((resolve, reject) => {
    const el = document.createElement('iframe');
    el.src = `${START_NG}/connect`;
    el.hidden = true;
    el.setAttribute('aria-hidden', 'true');
    el.onload = () => resolve(el);
    el.onerror = () => reject(new Error('start.ng connect frame failed'));
    document.body.append(el);
  });
  return framePromise;
}

/** Sends a message to the connect page and resolves its reply, or null. */
export async function askStartNg<T = Record<string, unknown>>(
  message: Record<string, unknown>,
  replyType: string,
  timeoutMs = TIMEOUT_MS
): Promise<T | null> {
  let el: HTMLIFrameElement;
  try {
    el = await connectFrame();
  } catch {
    return null;
  }
  return new Promise((resolve) => {
    const requestId = Math.random().toString(36).slice(2);
    const done = (reply: T | null) => {
      clearTimeout(timer);
      removeEventListener('message', onMessage);
      resolve(reply);
    };
    const timer = setTimeout(() => done(null), timeoutMs);
    function onMessage(e: MessageEvent) {
      if (e.origin !== START_NG || e.source !== el.contentWindow) return;
      const data = e.data as { type?: string; requestId?: string } | null;
      if (data?.type === replyType && data.requestId === requestId) done(data as T);
    }
    addEventListener('message', onMessage);
    el.contentWindow?.postMessage({ ...message, requestId }, START_NG);
  });
}

/** Keeps only the documented style fields; unknown values are dropped. */
function normalizeStyle(raw: unknown): Partial<WaiterStyle> | null {
  if (!raw || typeof raw !== 'object') return null;
  const s = raw as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of ['body', 'primaryColor', 'secondaryColor', 'skinColor', 'hairColor', 'hair', 'hat', 'accessory']) {
    if (typeof s[key] === 'string') out[key] = s[key];
  }
  return out as Partial<WaiterStyle>;
}

/**
 * Who is playing: the signed-in player, or start.ng's guest look.
 * Resolves to null when start.ng is not available (e.g. local dev server).
 */
export async function getPlayer(): Promise<StartNgPlayer | null> {
  const reply = await askStartNg<{
    user?: { name?: string; account?: string; style?: unknown; face?: string } | null;
    guest?: { name?: string; style?: unknown; face?: string } | null;
  }>({ type: 'startng:whoami' }, 'startng:user');
  const user = reply?.user ?? null;
  const guest = reply?.guest ?? null;
  const who = user ?? guest;
  if (!who) return null;
  return {
    name: typeof who.name === 'string' ? who.name : 'Guest',
    account: typeof user?.account === 'string' ? user.account : null,
    style: normalizeStyle(who.style),
    face: typeof who.face === 'string' ? who.face : null,
    signedIn: !!user,
  };
}

/** Re-asks when the player comes back to the tab (they may have signed in). */
export function watchPlayer(callback: (player: StartNgPlayer | null) => void): void {
  const refresh = () => {
    void getPlayer().then(callback);
  };
  addEventListener('focus', refresh);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') refresh();
  });
}

/** Link that signs the player in on start.ng and returns them to this page. */
export function signInUrl(): string {
  const back = location.origin + location.pathname;
  return `${START_NG}/?return_to=${encodeURIComponent(back)}`;
}

/** True when start.ng opened the game for a guest (?guest in the address). */
export function isGuestLink(): boolean {
  return new URLSearchParams(location.search).has('guest');
}

/** True when we are actually served from a start.ng subdomain. */
export function onStartNg(): boolean {
  return location.hostname.endsWith('.start.ng');
}
