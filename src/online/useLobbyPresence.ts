// Canal de presència global per a jugadors online.
// Usa Supabase Realtime Presence: cada client publica la seua identitat i
// veu la resta de jugadors connectats. La neteja és automàtica en desconnectar.
import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { salaForRoom } from "@/online/salaAssignment";
import { backoffDelay } from "@/online/realtimeReconnect";
import {
  DEV_MOCK_PRESENCE,
  DEV_MOCK_ONLINE_PLAYERS,
  DEV_MOCK_ONLINE_DEVICE_IDS,
  DEV_MOCK_ONLINE_USER_IDS,
} from "@/online/devSeededPresence";

export interface OnlinePlayer {
  deviceId: string;
  name: string;
  /** Codi de la taula on està assegut, si n'hi ha. */
  roomCode: string | null;
  /** Slug de la sala a la qual pertany (derivat del roomCode o explícit). */
  salaSlug: string | null;
  /** Identificador d'usuari autenticat, si està vinculat. */
  userId?: string | null;
}

interface PresenceState {
  deviceId: string;
  name: string;
  roomCode: string | null;
  salaSlug: string | null;
  userId?: string | null;
  joinedAt: number;
}

const CHANNEL_NAME = "lobby:presence";

// ----------------------------------------------------------------------------
// Singleton compartit del canal `lobby:presence`.
//
// supabase-js deduplica `supabase.channel(name)` per topic dins d'un mateix
// client: dues crides amb el mateix nom retornen la MATEIXA instància. Si dos
// hooks (per exemple `useLobbyPresence` al lobby i `useOnlinePresenceLookup`
// dins del diàleg de perfil) intenten registrar callbacks `on('presence', …)`
// sobre aquest canal compartit, el segon callback s'afegeix DESPRÉS del
// `subscribe()` del primer i Supabase llança l'error
// "cannot add `presence` callbacks for realtime:lobby:presence after
// `subscribe()`".
//
// Per evitar-ho, mantenim una sola subscripció a nivell de mòdul i
// multiplexem l'estat de presència via un petit EventEmitter intern.
// ----------------------------------------------------------------------------

type SharedPresenceSnapshot = {
  states: Record<string, PresenceState[]>;
};

type SharedPresenceListener = (snap: SharedPresenceSnapshot) => void;

let sharedChannel: ReturnType<typeof supabase.channel> | null = null;
let sharedRefCount = 0;
let sharedSnapshot: SharedPresenceSnapshot = { states: {} };
const sharedListeners = new Set<SharedPresenceListener>();
const sharedTrackers = new Map<string, PresenceState>(); // key -> meta to track
let sharedSubscribed = false;
let sharedReconnectAttempts = 0;
let sharedReconnectTimer: ReturnType<typeof setTimeout> | null = null;
let sharedWakeListenersInstalled = false;

function emitSharedSnapshot() {
  sharedListeners.forEach((l) => {
    try { l(sharedSnapshot); } catch { /* ignore */ }
  });
}

function ensureSharedChannel(): ReturnType<typeof supabase.channel> {
  if (sharedChannel) return sharedChannel;
  const ch = supabase.channel(CHANNEL_NAME, {
    config: { presence: { key: `shared:${Math.random().toString(36).slice(2)}` } },
  });
  sharedChannel = ch;
  sharedSubscribed = false;

  const sync = () => {
    sharedSnapshot = { states: ch.presenceState<PresenceState>() };
    emitSharedSnapshot();
  };

  ch.on("presence", { event: "sync" }, sync)
    .on("presence", { event: "join" }, sync)
    .on("presence", { event: "leave" }, sync)
    .subscribe(async (status) => {
      if (status === "SUBSCRIBED") {
        sharedSubscribed = true;
        sharedReconnectAttempts = 0;
        // Re-track every active tracker (publishers) on this shared channel.
        for (const meta of sharedTrackers.values()) {
          try { await ch.track(meta); } catch { /* ignore */ }
        }
      } else if (status === "CLOSED" || status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
        sharedSubscribed = false;
        scheduleSharedReconnect();
      }
    });

  installSharedWakeListeners();
  return ch;
}

function scheduleSharedReconnect() {
  if (sharedRefCount === 0) return;
  if (sharedReconnectTimer) return;
  const delay = backoffDelay(sharedReconnectAttempts++);
  sharedReconnectTimer = setTimeout(() => {
    sharedReconnectTimer = null;
    forceSharedReconnect();
  }, delay);
}

function forceSharedReconnect() {
  if (sharedRefCount === 0) return;
  if (sharedChannel) {
    try { supabase.removeChannel(sharedChannel); } catch { /* ignore */ }
    sharedChannel = null;
  }
  sharedSubscribed = false;
  ensureSharedChannel();
}

function installSharedWakeListeners() {
  if (sharedWakeListenersInstalled) return;
  if (typeof window === "undefined") return;
  sharedWakeListenersInstalled = true;
  const onWake = () => {
    if (sharedRefCount === 0) return;
    if (!sharedSubscribed) {
      // Channel is in a stale/closed state — force a fresh subscription now.
      if (sharedReconnectTimer) {
        clearTimeout(sharedReconnectTimer);
        sharedReconnectTimer = null;
      }
      sharedReconnectAttempts = 0;
      forceSharedReconnect();
    } else if (sharedChannel) {
      // Even when "subscribed", mobile WebViews can keep stale sockets after
      // long suspensions. Republish our trackers so the server flushes any
      // missed presence state to us via the next sync.
      for (const meta of sharedTrackers.values()) {
        try { void sharedChannel.track(meta); } catch { /* ignore */ }
      }
    }
  };
  window.addEventListener("online", onWake);
  window.addEventListener("focus", onWake);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") onWake();
  });
}

function acquireSharedChannel(): ReturnType<typeof supabase.channel> {
  sharedRefCount++;
  return ensureSharedChannel();
}

function releaseSharedChannel() {
  sharedRefCount = Math.max(0, sharedRefCount - 1);
  if (sharedRefCount === 0 && sharedChannel) {
    try { supabase.removeChannel(sharedChannel); } catch { /* ignore */ }
    sharedChannel = null;
    sharedSubscribed = false;
    sharedSnapshot = { states: {} };
    sharedTrackers.clear();
    if (sharedReconnectTimer) {
      clearTimeout(sharedReconnectTimer);
      sharedReconnectTimer = null;
    }
    sharedReconnectAttempts = 0;
  }
}

async function publishSharedPresence(key: string, meta: PresenceState) {
  sharedTrackers.set(key, meta);
  const ch = sharedChannel;
  if (ch && sharedSubscribed) {
    try { await ch.track(meta); } catch { /* ignore */ }
  }
}

function unpublishSharedPresence(key: string) {
  sharedTrackers.delete(key);
  const ch = sharedChannel;
  if (ch && sharedSubscribed) {
    try { ch.untrack(); } catch { /* ignore */ }
  }
}

/**
 * Manté el canal de presència sempre subscrit durant tota la vida de l'app,
 * sense publicar res. Així, en navegar a Sales/Lobby la `sharedSnapshot` ja
 * conté l'última llista coneguda i la UI pinta instantàniament sense parpalleig.
 */
export function keepSharedChannelWarm(): () => void {
  acquireSharedChannel();
  return () => releaseSharedChannel();
}

/**
 * Força una resincronització profunda del canal de presència compartit.
 * Útil per al botó "Refrescar" del lobby: neteja l'estat local, reconnecta
 * el socket i republica els trackers per rebre una snapshot fresca del
 * servidor amb la llista real de jugadors connectats (sense fantasmes).
 */
export function forceLobbyPresenceResync(): void {
  // Buidem la snapshot local perquè la UI deixi de pintar dades antigues
  // mentre arriba la nova sincronització.
  sharedSnapshot = { states: {} };
  emitSharedSnapshot();
  if (sharedReconnectTimer) {
    clearTimeout(sharedReconnectTimer);
    sharedReconnectTimer = null;
  }
  sharedReconnectAttempts = 0;
  if (sharedRefCount > 0) {
    forceSharedReconnect();
  }
}

function snapshotToPlayers(snap: SharedPresenceSnapshot): OnlinePlayer[] {
  // Dedupe per usuari: si un mateix `deviceId` (o `userId`) apareix en
  // diverses claus de presència (per exemple, dues pestanyes obertes), el
  // comptem una sola vegada, prioritzant la meta amb `joinedAt` més recent.
  const byDedupeKey = new Map<string, OnlinePlayer & { _joinedAt: number }>();
  for (const [key, metas] of Object.entries(snap.states)) {
    for (const meta of metas) {
      if (!meta || !meta.name) continue;
      const dedupeKey = meta.userId || meta.deviceId || key;
      const candidate = {
        deviceId: meta.deviceId ?? key,
        name: meta.name,
        roomCode: meta.roomCode ?? null,
        salaSlug: meta.salaSlug ?? null,
        userId: meta.userId ?? null,
        _joinedAt: meta.joinedAt ?? 0,
      };
      const prev = byDedupeKey.get(dedupeKey);
      if (!prev || candidate._joinedAt >= prev._joinedAt) {
        byDedupeKey.set(dedupeKey, candidate);
      }
    }
  }
  return Array.from(byDedupeKey.values())
    .map(({ _joinedAt, ...p }) => p)
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function useLobbyPresence({
  deviceId,
  name,
  roomCode = null,
  salaSlug: salaSlugProp = null,
  enabled = true,
  userId = null,
  /** Si es passa, filtra els jugadors que pertanyen a aquesta sala. */
  filterBySala,
}: {
  deviceId: string;
  name: string;
  roomCode?: string | null;
  salaSlug?: string | null;
  enabled?: boolean;
  userId?: string | null;
  filterBySala?: string | null;
}): OnlinePlayer[] {
  // Derive salaSlug from roomCode if not explicitly provided
  const salaSlug = salaSlugProp ?? (roomCode ? salaForRoom({ code: roomCode }) : null);

  // Inicialitza síncronament des de la snapshot global perquè la UI tinga
  // dades immediates en muntar (sense esperar el primer `sync` del canal).
  // No depèn de `enabled`/`deviceId`/`name`: el `GlobalLobbyWarmup` ja manté
  // el canal viu des de l'arrencada de l'app, així que la snapshot ja està
  // poblada encara que aquest hook concret encara no publique res.
  const [players, setPlayers] = useState<OnlinePlayer[]>(() =>
    snapshotToPlayers(sharedSnapshot),
  );

  // Effect 1: lectura passiva del canal compartit. SEMPRE escolta perquè la
  // UI puga pintar el comptador sense esperar a `ready` / `hasName`. El
  // `GlobalLobbyWarmup` ja ha invocat `acquireSharedChannel()` a l'arrencada,
  // així que ací el canal ja està connectat (o connectant-se) abans que aquesta
  // pantalla munte.
  useEffect(() => {
    acquireSharedChannel();
    const update = (snap: SharedPresenceSnapshot) => {
      setPlayers(snapshotToPlayers(snap));
    };
    sharedListeners.add(update);
    update(sharedSnapshot);
    return () => {
      sharedListeners.delete(update);
      releaseSharedChannel();
    };
  }, []);

  // Effect 2: publica/actualitza la pròpia presència quan canvien les meta.
  useEffect(() => {
    if (!enabled || !deviceId || !name) return;
    void publishSharedPresence(deviceId, {
      deviceId,
      name,
      roomCode,
      salaSlug,
      userId,
      joinedAt: Date.now(),
    });
    return () => {
      unpublishSharedPresence(deviceId);
    };
  }, [deviceId, name, roomCode, salaSlug, userId, enabled]);

  // Inject dev mock players (and apply filterBySala client-side)
  const filtered = useMemo(() => {
    const merged = DEV_MOCK_PRESENCE
      ? [
          ...players,
          ...DEV_MOCK_ONLINE_PLAYERS.map((p) =>
            // Override salaSlug so mocks appear in the current sala view too.
            ({ ...p, salaSlug: filterBySala ?? p.salaSlug })
          ),
        ]
      : players;
    if (!filterBySala) return merged;
    return merged.filter((p) => p.salaSlug === filterBySala);
  }, [players, filterBySala]);

  return filtered;
}
/**
 * Hook passiu (read-only): es subscriu al canal de presència global sense
 * publicar res, i exposa els conjunts de `deviceId` i `userId` connectats.
 * Útil per a indicadors d'estat "Connectat / Desconnectat" en perfils.
 */
export function useOnlinePresenceLookup(enabled = true): {
  deviceIds: Set<string>;
  userIds: Set<string>;
} {
  const [state, setState] = useState<{ deviceIds: Set<string>; userIds: Set<string> }>(
    () => ({
      deviceIds: DEV_MOCK_PRESENCE ? new Set(DEV_MOCK_ONLINE_DEVICE_IDS) : new Set(),
      userIds: DEV_MOCK_PRESENCE ? new Set(DEV_MOCK_ONLINE_USER_IDS) : new Set(),
    }),
  );

  useEffect(() => {
    if (!enabled) return;
    acquireSharedChannel();

    const update = (snap: SharedPresenceSnapshot) => {
      const deviceIds = new Set<string>(
        DEV_MOCK_PRESENCE ? DEV_MOCK_ONLINE_DEVICE_IDS : [],
      );
      const userIds = new Set<string>(
        DEV_MOCK_PRESENCE ? DEV_MOCK_ONLINE_USER_IDS : [],
      );
      for (const metas of Object.values(snap.states)) {
        const meta = metas[0];
        if (!meta) continue;
        if (meta.deviceId) deviceIds.add(meta.deviceId);
        if (meta.userId) userIds.add(meta.userId);
      }
      setState({ deviceIds, userIds });
    };
    sharedListeners.add(update);
    update(sharedSnapshot);

    return () => {
      sharedListeners.delete(update);
      releaseSharedChannel();
    };
  }, [enabled]);

  return state;
}

/**
 * Hook passiu (read-only): retorna un mapa `deviceId → name` dels jugadors
 * presents al canal global. Útil per a resoldre el nom real d'un espectador
 * a partir del seu `device_id` quan el missatge no porta `senderName`.
 */
export function usePresenceNamesByDevice(enabled = true): Record<string, string> {
  const [map, setMap] = useState<Record<string, string>>(() => {
    const initial: Record<string, string> = {};
    for (const metas of Object.values(sharedSnapshot.states)) {
      const meta = metas[0];
      if (meta?.deviceId && meta?.name) initial[meta.deviceId] = meta.name;
    }
    return initial;
  });

  useEffect(() => {
    if (!enabled) return;
    acquireSharedChannel();
    const update = (snap: SharedPresenceSnapshot) => {
      const next: Record<string, string> = {};
      for (const metas of Object.values(snap.states)) {
        const meta = metas[0];
        if (meta?.deviceId && meta?.name) next[meta.deviceId] = meta.name;
      }
      setMap(next);
    };
    sharedListeners.add(update);
    update(sharedSnapshot);
    return () => {
      sharedListeners.delete(update);
      releaseSharedChannel();
    };
  }, [enabled]);

  return map;
}