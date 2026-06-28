// Shared reconnection helpers for Supabase Realtime channels and presence.
//
// Goals:
//  - When a channel reports CHANNEL_ERROR / TIMED_OUT / CLOSED unexpectedly,
//    schedule a reconnection attempt with exponential backoff + jitter.
//  - When the browser regains network (`online`) or the tab becomes visible
//    again (`visibilitychange`), trigger an immediate resync.
//  - Always re-fetch authoritative state on reconnect, so the game state
//    stays consistent with the server even if we missed realtime events
//    while disconnected.
//
// The helpers here are intentionally framework-agnostic: they only deal with
// scheduling. Callers wire the actual `subscribe()` / `track()` / `refresh()`
// logic through the provided callbacks.

const BASE_DELAY_MS = 500;
const MAX_DELAY_MS = 15_000;
const INITIAL_RPC_DELAY_MS = 400;

let firstRpcReadyAt = typeof window === "undefined" ? 0 : Date.now() + INITIAL_RPC_DELAY_MS;

export function backoffDelay(attempt: number): number {
  const exp = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** Math.min(attempt, 6));
  // Full jitter: [0, exp]
  return Math.floor(Math.random() * exp);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

/**
 * Avoid launching the first rooms RPC while the page and Realtime socket are
 * still changing state. Later calls pass immediately unless the socket is in
 * the middle of connecting/closing or the browser is offline.
 */
export async function waitForStableRpcTransport(
  connectionState: () => string,
): Promise<void> {
  if (typeof window === "undefined") return;

  if (document.readyState === "loading") {
    await new Promise<void>((resolve) => {
      document.addEventListener("DOMContentLoaded", () => resolve(), { once: true });
    });
    firstRpcReadyAt = Math.max(firstRpcReadyAt, Date.now() + INITIAL_RPC_DELAY_MS);
  }

  const initialWait = firstRpcReadyAt - Date.now();
  if (initialWait > 0) await delay(initialWait);
  firstRpcReadyAt = 0;

  while (!navigator.onLine) {
    await new Promise<void>((resolve) => window.addEventListener("online", () => resolve(), { once: true }));
  }

  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const state = connectionState();
    if (state !== "connecting" && state !== "closing") return;
    await delay(50);
  }
}