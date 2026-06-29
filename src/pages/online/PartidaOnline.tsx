import { useNavigate, useParams } from "@/lib/router-shim";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ClientOnly } from "@/components/ClientOnly";
import { Button } from "@/components/ui/button";
import { usePlayerIdentity } from "@/hooks/usePlayerIdentity";
import { useRoomRealtime, type RoomFullDTO } from "@/online/useRoomRealtime";
import { submitAction, sendChatPhrase, sendTextMessage, setPaused, advanceBots, markActivity, proposeAction, respondProposal, cancelProposal, flagPlayerInChat, leaveRoom, rematchStay, getAllHandsDebug } from "@/online/rooms.functions";
import { useRoomChat } from "@/online/useRoomChat";
import { filterProfanity, loadBlacklistFromSupabase } from "@/online/profanityFilter";
import { useRoomTextChat } from "@/online/useRoomTextChat";
import { useRoomChatFlags } from "@/online/useRoomChatFlags";
import { buildChatFlagNotices } from "@/online/chatFlagNotices";
import { legalActions } from "@/game/engine";
import { computeShoutDisplay } from "@/game/shoutDisplay";
import { useShoutFlash, useShoutFlashes } from "@/game/useShoutFlash";
import type { Action, MatchState, PlayerId } from "@/game/types";
import type { ChatPhraseId } from "@/game/phrases";
import { useAvatarsByDevice } from "@/online/useAvatarsByDevice";
import { getBotAvatarsBySeat } from "@/online/botAvatars";

import { TrucBoard } from "@/components/truc/TrucBoard";
import { TableChat } from "@/components/truc/TableChat";
import { BoardRoomChat } from "@/online/BoardRoomChat";
import { salaForRoom } from "@/online/salaAssignment";
import { Loader2, Copy, Check, LogOut } from "lucide-react";
import { toast } from "sonner";
import { ShareAppButton } from "@/components/ShareAppButton";
import { useGameSettings, type TurnTimeoutSec } from "@/lib/gameSettings";
import { recordMatchResult } from "@/lib/playerStats";
import { applyAbandonXpPenalty } from "@/lib/xpPenalty";
import { usePlayerMiniStats } from "@/online/usePlayerMiniStats";
import { getRoomPlayerProfileUserId } from "@/online/types";
import { useOnlinePresenceLookup } from "@/online/useLobbyPresence";
import { useRoomPresence } from "@/online/useRoomPresence";
import { RoomMembersPanel } from "@/online/RoomMembersPanel";
import { TableSeatPicker, type SeatInfo } from "@/online/TableSeatPicker";
import { getPresenceStatus, type PresenceStatus } from "@/online/presence";
import {
  BOT_DELAY_MS,
  LOW_LATENCY_BOT_TICK_MS,
  LOW_LATENCY_ENVIT_REVEAL_ROUND_END_MS,
  LOW_LATENCY_ROUND_END_MS,
  SHOUT_FLASH_HOLD_MS,
  SHOUT_FLASH_BUFFER_MS,
} from "@/game/chatTimings";
import { useT } from "@/i18n/useT";


function currentActor(state: MatchState): PlayerId | null {
  const r = state.round;
  if (r.phase === "game-end" || r.phase === "round-end") return null;
  for (const p of [0, 1, 2, 3] as PlayerId[]) {
    if (legalActions(state, p).length === 0) continue;
    if (
      (r.envitState.kind === "pending" && r.envitState.awaitingTeam === (p % 2 === 0 ? "nos" : "ells")) ||
      (r.trucState.kind === "pending" && r.trucState.awaitingTeam === (p % 2 === 0 ? "nos" : "ells")) ||
      r.turn === p
    ) {
      return p;
    }
  }
  return null;
}

function Loading() {
  return (
    <main className="min-h-screen flex items-center justify-center">
      <Loader2 className="w-6 h-6 animate-spin text-primary" />
    </main>
  );
}

function OnlinePartidaPage() {
  return (
    <ClientOnly fallback={<Loading />}>
      <PartidaOnline />
    </ClientOnly>
  );
}

function PartidaOnline() {
  const t = useT();
  const { codi = "" } = useParams<{ codi: string }>();
  const navigate = useNavigate();
  const { deviceId, name, hasName, ready } = usePlayerIdentity();
  const code = codi.toUpperCase();

  // Spectator mode via ?spectator=1&seat=N
  const searchParams = typeof window !== "undefined" ? new URLSearchParams(window.location.search) : new URLSearchParams();
  const isSpectator = searchParams.get("spectator") === "1";
  const spectatorSeatRaw = searchParams.get("seat");
  const spectatorSeat: PlayerId | null =
    isSpectator && spectatorSeatRaw != null && /^[0-3]$/.test(spectatorSeatRaw)
      ? (Number(spectatorSeatRaw) as PlayerId)
      : null;
  const isSpectatorRef = useRef(isSpectator);
  isSpectatorRef.current = isSpectator;

  const { data, error, loading, runWithExplicitRefresh, applyOptimistic } = useRoomRealtime(
    ready ? code : null,
    deviceId,
    isSpectator ? spectatorSeat : null,
  );

  const [transitionActive, setTransitionActive] = useState(false);
  const [spectatorCopied, setSpectatorCopied] = useState(false);
  const state = data?.room.matchState ?? null;
  const { messages: chatMessages, reset: resetRoomChat } = useRoomChat(data?.room.id ?? null, state);
  const textMessages = useRoomTextChat(data?.room.id ?? null);
  // Presència a nivell de sala (per llistar espectadors en directe).
  // Un membre és espectador si l'URL ho indica i a més no té asiento real.
  const presenceIsSpectator = isSpectator && (data?.mySeat == null);
  const presenceMembers = useRoomPresence({
    roomId: data?.room.id ?? null,
    deviceId,
    name,
    userId: null,
    isSpectator: presenceIsSpectator,
    enabled: ready && hasName,
  });
  
  const chatFlags = useRoomChatFlags(data?.room.id ?? null, deviceId);
  const { settings, update } = useGameSettings();

  const mySeat = data?.mySeat ?? null;
  const viewerSeat: PlayerId | null = mySeat ?? (isSpectator ? spectatorSeat : null);
  const players = data?.players;
  const seatKinds = data?.room.seatKinds;
  const isTableAdmin = !!data && data.room.hostDevice === deviceId;

  useEffect(() => {
    resetRoomChat();
  }, [state?.history.length, resetRoomChat]);

  // Carrega la llista negra de paraules des de Supabase un sol cop.
  useEffect(() => {
    void loadBlacklistFromSupabase();
  }, []);

  // Bot-driver: cualquier humano sentado empuja al servidor para que avance
  // UN paso de bot por petición. El servidor (advanceBots) aplica como
  // mucho UNA acción por llamada, replicando el ritmo de la partida
  // offline (~BOT_DELAY_MS entre acciones). Cuando el servidor escribe el
  // nuevo match_state, realtime lo propaga, este effect se re-ejecuta y
  // programa el siguiente tick. Watchdog: si no llega update en ~2.5s,
  // reintenta (red caída, etc.).
  useEffect(() => {
    if (!data || !state || mySeat == null || data.room.pausedAt != null) return;
    if (data.room.seatKinds[mySeat] !== "human") return;
    if (transitionActive && state.round.phase !== "round-end") return;
    const actor = currentActor(state);
    const roomId = data.room.id;
    const fire = () => {
      advanceBots({ data: { roomId, deviceId } }).catch(() => {});
    };

    // Fin de mano: dejamos que la animación de envit/recogida se reproduzca
    // antes de pedir al servidor que abra la siguiente ronda.
    if (state.round.phase === "round-end") {
      const lastSummary = state.history[state.history.length - 1];
      const envitRevealed = !!(
        lastSummary &&
        lastSummary.envitWinner &&
        !lastSummary.envitRejected &&
        lastSummary.envitPoints > 0
      );
      let delay = envitRevealed
        ? LOW_LATENCY_ENVIT_REVEAL_ROUND_END_MS
        : LOW_LATENCY_ROUND_END_MS;
      if (lastSummary && (lastSummary as any).trucRejected) {
        delay = Math.max(delay, SHOUT_FLASH_HOLD_MS + SHOUT_FLASH_BUFFER_MS + LOW_LATENCY_ROUND_END_MS);
      }
      delay += mySeat * 150;
      const timer = window.setTimeout(fire, delay);
      return () => window.clearTimeout(timer);
    }

    if (actor == null || data.room.seatKinds[actor] !== "bot") return;

    // Cadencia offline: esperamos BOT_DELAY_MS entre acciones de bot.
    // Stagger por seat para que un cliente concreto vaya primero y los
    // demás actúen como fallback si el primero no llega.
    const tickDelay = BOT_DELAY_MS + mySeat * 200;
    const firstTimer = window.setTimeout(fire, tickDelay);
    // Watchdog: si el servidor no progresa en ~2.5s (p. ej. la petición
    // se perdió), reintentamos. Se desmonta automáticamente cuando el
    // estado cambia y el effect se re-ejecuta.
    const watchdog = window.setInterval(fire, 2500);
    return () => {
      window.clearTimeout(firstTimer);
      window.clearInterval(watchdog);
    };
  }, [data, state, mySeat, deviceId, transitionActive]);

  // Marcador compartit per evitar dobles `leaveRoom` quan l'usuari ja ha
  // disparat el flux explícit d'abandó (handleAbandon).
  const leavingRef = useRef(false);



  // Cleanup d'abandó: si l'usuari tanca la pestanya, fa swipe-back o navega
  // fora sense passar pel botó d'abandonar, alliberem el seient (best-effort)
  // perquè la mesa no quedi "fantasma". Per a status="playing" el servidor
  // manté el seient si encara queden altres humans (per a la reentrada),
  // però destrueix la mesa quan érem l'últim humà real. El TTL d'1 minut
  // del servidor cobreix els casos en què aquesta crida no arribi a temps.
  const roomIdForUnload = data?.room.id;
  const mySeatForUnload = data?.mySeat ?? null;
  useEffect(() => {
    if (!roomIdForUnload || mySeatForUnload == null) return;
    const handleUnload = () => {
      if (leavingRef.current) return;
      try {
        const baseUrl = (import.meta.env.VITE_SUPABASE_URL as string | undefined)
          ?? "https://sgonrrtqdcwyajsmufhs.supabase.co";
        const url = `${baseUrl}/functions/v1/rooms-rpc`;
        const body = JSON.stringify({ fn: "leaveRoom", data: { roomId: roomIdForUnload, deviceId } });
        navigator.sendBeacon(url, new Blob([body], { type: "application/json" }));
      } catch { /* noop */ }
    };
    window.addEventListener("pagehide", handleUnload);
    window.addEventListener("beforeunload", handleUnload);
    return () => {
      window.removeEventListener("pagehide", handleUnload);
      window.removeEventListener("beforeunload", handleUnload);
    };
  }, [roomIdForUnload, mySeatForUnload, deviceId]);

  // Cleanup en desmuntar el component (SPA back / canvi de ruta): si encara
  // estic assegut i no he passat pel flux explícit d'abandó, allibera el
  // seient via beacon + RPC. El servidor decideix què fer segons l'estat.
  const leaveOnUnmountSnap = useRef<{ roomId: string; seated: boolean } | null>(null);
  useEffect(() => {
    leaveOnUnmountSnap.current = data && data.mySeat != null
      ? { roomId: data.room.id, seated: true }
      : null;
  }, [data]);
  useEffect(() => {
    return () => {
      const snap = leaveOnUnmountSnap.current;
      if (!snap || !snap.seated) return;
      if (leavingRef.current) return;
      try {
        const baseUrl = (import.meta.env.VITE_SUPABASE_URL as string | undefined)
          ?? "https://sgonrrtqdcwyajsmufhs.supabase.co";
        const url = `${baseUrl}/functions/v1/rooms-rpc`;
        const body = JSON.stringify({ fn: "leaveRoom", data: { roomId: snap.roomId, deviceId } });
        navigator.sendBeacon(url, new Blob([body], { type: "application/json" }));
      } catch { /* noop */ }
      leaveRoom({ data: { roomId: snap.roomId, deviceId } }).catch(() => { /* noop */ });
    };
  }, [deviceId]);




  // Derived values — memoised against the exact inputs the board needs, so
  // unrelated updates (e.g. a player presence flip) don't rebuild them.
  const myActions = useMemo<Action[]>(
    () => (state && mySeat != null ? legalActions(state, mySeat) : []),
    [state, mySeat],
  );

  // Mateixa font de veritat que la partida offline: tots els carteles
  // (truc, envit, V/X, família, acceptat) es deriven del MatchState.
  const display = useMemo(
    () => state ? computeShoutDisplay(state) : null,
    [state],
  );
  // Flash transitori del cant (1.6s), derivat del log. Mateix hook que offline.
  const shoutFlashes = useShoutFlashes(state);
  const shoutFlash = shoutFlashes.length === 0 ? null : shoutFlashes[shoutFlashes.length - 1];

  // Als indicadors dels seients mostrem sempre el nom de jugador (display
  // name) — el mateix que apareix al llistat de connectats del xat — i mai
  // el username únic.
  const seatNames = useMemo(() => {
    if (viewerSeat == null || !players || !seatKinds) {
      return { bottom: "", right: "", top: "", left: "" };
    }
    const nameOf = (seat: PlayerId): string => {
      const occupant = players.find((p) => p.seat === seat);
      if (occupant) return occupant.name;
      return seatKinds[seat] === "bot" ? `Bot ${seat + 1}` : `Seient ${seat + 1}`;
    };
    return {
      bottom: nameOf(viewerSeat),
      right: nameOf(((viewerSeat + 1) % 4) as PlayerId),
      top: nameOf(((viewerSeat + 2) % 4) as PlayerId),
      left: nameOf(((viewerSeat + 3) % 4) as PlayerId),
    };
  }, [viewerSeat, players, seatKinds]);

  // `rawDealKey` brut a partir de l'snapshot actual: només té valor quan
  // estem clarament al començament d'una mà (12 cartes en mà i cap baza
  // jugada encara). Si no, és `null`. A més de `fullHands === 12` i
  // `tricks[0].cards.length === 0`, també exigim que la fase siga "play"
  // (no "round-end" / "game-end") i que no hi haja entrades al log que
  // corresponguen a aquesta mà encara — és a dir, que la mà acabe just de
  // començar a nivell semàntic, no només estructural.
  const rawDealKey = useMemo(() => {
    if (!state) return null;
    const r = state.round;
    if (r.phase === "round-end" || r.phase === "game-end") return null;
    const inHand = r.hands[0].length + r.hands[1].length + r.hands[2].length + r.hands[3].length;
    const playedThisRound = r.tricks.reduce((acc, t) => acc + t.cards.length, 0);
    if (inHand + playedThisRound !== 12) return null;
    if (r.tricks.length !== 1 || r.tricks[0].cards.length >= 4) return null;
    return `online-${state.history.length}-${state.cames}-${r.mano}`;
  }, [state]);

  // Gate d'estabilitat: només acceptem el `rawDealKey` com a vàlid si el
  // mateix valor s'ha mantingut estable durant `DEAL_STABLE_MS`. Així
  // snapshots transitòries (per exemple, una fila intermèdia que el
  // servidor escriu i sobreescriu ràpidament) no disparen l'animació.
  const DEAL_STABLE_MS = 250;
  const [stableDealKey, setStableDealKey] = useState<string | null>(null);
  useEffect(() => {
    if (rawDealKey == null) {
      setStableDealKey(null);
      return;
    }
    if (rawDealKey === stableDealKey) return;
    const t = window.setTimeout(() => {
      setStableDealKey(rawDealKey);
    }, DEAL_STABLE_MS);
    return () => window.clearTimeout(t);
  }, [rawDealKey, stableDealKey]);

  // Bloqueig del `dealKey` mentre l'animació està en curs: una vegada emetem
  // un valor no nul (que fa arrencar l'animació de repartir al TrucBoard),
  // el "congelem" fins que el `TrucBoard` ens notifica explícitament que
  // l'animació ha acabat (via `onDealAnimationEnd`). Així snapshots
  // consecutives del servidor no poden reiniciar l'animació enmig, i
  // alliberem el bloqueig en quant pot ser, sense esperar un timeout fix.
  // Mantenim un timeout de seguretat per si la senyal no arriba mai (per
  // exemple, si el board es desmunta abans de completar l'animació).
  const DEAL_ANIMATION_FALLBACK_MS = 5000;
  const lastEmittedDealKeyRef = useRef<string | null>(null);
  const animatingDealKeyRef = useRef<string | null>(null);
  const fallbackTimerRef = useRef<number | null>(null);
  // `consumedDealKeyRef` recorda l'últim `dealKey` que el `TrucBoard` ja ha
  // "consumit" (animat o ignorat). Sobreviu als re-munts del board perquè
  // viu en aquest component pare, així una nova instància de `TrucBoard` no
  // tornarà a disparar l'animació per una mà ja repartida.
  const consumedDealKeyRef = useRef<string | null>(null);
  const handleDealKeyConsumed = useCallback((key: string) => {
    consumedDealKeyRef.current = key;
  }, []);
  const releaseDealLock = useCallback((key: string) => {
    if (animatingDealKeyRef.current === key) {
      animatingDealKeyRef.current = null;
    }
    if (fallbackTimerRef.current != null) {
      window.clearTimeout(fallbackTimerRef.current);
      fallbackTimerRef.current = null;
    }
  }, []);
  const handleDealAnimationEnd = useCallback((key: string) => {
    releaseDealLock(key);
  }, [releaseDealLock]);
  useEffect(() => {
    return () => {
      if (fallbackTimerRef.current != null) {
        window.clearTimeout(fallbackTimerRef.current);
      }
    };
  }, []);
  const dealKey = useMemo(() => {
    if (stableDealKey == null) {
      // Quan ja no estem al començament de la mà, alliberem el bloqueig
      // perquè la pròxima vegada que canviï puga emetre's de nou.
      lastEmittedDealKeyRef.current = null;
      return null;
    }
    if (stableDealKey === lastEmittedDealKeyRef.current) {
      return stableDealKey;
    }
    if (animatingDealKeyRef.current != null) {
      // Encara hi ha una animació en curs: mantenim el valor anterior fins
      // que el TrucBoard ens notifique que ha acabat.
      return lastEmittedDealKeyRef.current;
    }
    lastEmittedDealKeyRef.current = stableDealKey;
    animatingDealKeyRef.current = stableDealKey;
    if (fallbackTimerRef.current != null) {
      window.clearTimeout(fallbackTimerRef.current);
    }
    const lockedKey = stableDealKey;
    fallbackTimerRef.current = window.setTimeout(() => {
      releaseDealLock(lockedKey);
    }, DEAL_ANIMATION_FALLBACK_MS);
    return stableDealKey;
  }, [stableDealKey, releaseDealLock]);

  // Re-evaluate derived presence every 10s so seats fade to "away"/"offline"
  // even when no realtime event arrives between heartbeats.
  const [presenceTick, setPresenceTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setPresenceTick((n) => n + 1), 10_000);
    return () => clearInterval(id);
  }, []);

  // Senyal d'activitat: qualsevol toc/clic/tecla a la partida refresca la
  // presència i reseteja al servidor les faltes d'inactivitat i el piloto
  // automàtic per a aquest seient. Throttle 5s per no saturar.
  const roomIdForActivity = data?.room.id ?? null;
  const seatedHere = mySeat != null;
  useEffect(() => {
    if (!roomIdForActivity || !seatedHere) return;
    let lastSent = 0;
    const fire = () => {
      const now = Date.now();
      if (now - lastSent < 5000) return;
      lastSent = now;
      markActivity({ data: { roomId: roomIdForActivity, deviceId } }).catch(() => {});
    };
    window.addEventListener("pointerdown", fire, { passive: true });
    window.addEventListener("keydown", fire);
    window.addEventListener("touchstart", fire, { passive: true });
    return () => {
      window.removeEventListener("pointerdown", fire);
      window.removeEventListener("keydown", fire);
      window.removeEventListener("touchstart", fire);
    };
  }, [roomIdForActivity, seatedHere, deviceId]);

  const { deviceIds: onlineDeviceIds, userIds: onlineUserIds } = useOnlinePresenceLookup(true);

  const { seatPresence, seatPresenceLastSeen } = useMemo(() => {
    const presence: Record<PlayerId, PresenceStatus | null> = { 0: null, 1: null, 2: null, 3: null };
    const lastSeen: Record<PlayerId, string | null> = { 0: null, 1: null, 2: null, 3: null };
    if (!players || !seatKinds) return { seatPresence: presence, seatPresenceLastSeen: lastSeen };
    const now = Date.now();
    for (const seat of [0, 1, 2, 3] as PlayerId[]) {
      if (seatKinds[seat] !== "human") continue;
      const occupant = players.find((p) => p.seat === seat);
      if (!occupant) {
        presence[seat] = "offline";
        continue;
      }
      const profUserId = getRoomPlayerProfileUserId(occupant);
      const livePresent =
        onlineDeviceIds.has(occupant.deviceId) ||
        (!!profUserId && onlineUserIds.has(profUserId));
      const effectiveOnline = occupant.isOnline || livePresent;
      presence[seat] = getPresenceStatus(effectiveOnline, occupant.lastSeen, now);
      lastSeen[seat] = occupant.lastSeen;
    }
    return { seatPresence: presence, seatPresenceLastSeen: lastSeen };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [players, seatKinds, presenceTick, onlineDeviceIds, onlineUserIds]);

  // Avatars per seient (només jugadors humans amb perfil vinculat). La RPC rep
  // el profile_user_id real, no el device_id temporal local.
  const seatedProfileUserIds = useMemo(() => {
    if (!players || !seatKinds) return [] as string[];
    return players
      .filter((p) => seatKinds[p.seat] === "human")
      .map((p) => getRoomPlayerProfileUserId(p))
      .filter((id): id is string => !!id);
  }, [players, seatKinds]);
  const userIdsByDevice = useMemo(() => {
    const out: Record<string, string | null> = {};
    for (const player of players ?? []) {
      if (player.deviceId) out[player.deviceId] = getRoomPlayerProfileUserId(player);
    }
    return out;
  }, [players]);
  const seatedPlayersRefreshKey = useMemo(() => {
    if (!players || !seatKinds) return "";
    return players
      .filter((p) => seatKinds[p.seat] === "human")
      .map((p) => `${p.seat}:${p.deviceId}:${getRoomPlayerProfileUserId(p) ?? ""}`)
      .sort()
      .join("|");
  }, [players, seatKinds]);
  const avatarsByDevice = useAvatarsByDevice(seatedProfileUserIds, userIdsByDevice, seatedPlayersRefreshKey);
  const seatAvatars = useMemo<Record<PlayerId, string | null>>(() => {
    const out: Record<PlayerId, string | null> = { 0: null, 1: null, 2: null, 3: null };
    if (!players || !seatKinds) return out;
    const botAvatars = data?.room?.id ? getBotAvatarsBySeat(data.room.id, seatKinds) : null;
    for (const seat of [0, 1, 2, 3] as PlayerId[]) {
      if (seatKinds[seat] === "bot") {
        out[seat] = botAvatars?.[seat] ?? null;
        continue;
      }
      if (seatKinds[seat] !== "human") continue;
      const occupant = players.find((p) => p.seat === seat);
      if (!occupant) continue;
      out[seat] = avatarsByDevice[occupant.deviceId] ?? null;
    }
    return out;
  }, [players, seatKinds, avatarsByDevice, data?.room?.id]);

  // Identitats per seient (per a obrir el perfil al clicar).
  const seatIdentities = useMemo<Record<PlayerId, { userId: string | null; deviceId: string | null } | null>>(() => {
    const out: Record<PlayerId, { userId: string | null; deviceId: string | null } | null> = { 0: null, 1: null, 2: null, 3: null };
    if (!players || !seatKinds) return out;
    for (const seat of [0, 1, 2, 3] as PlayerId[]) {
      if (seatKinds[seat] !== "human") continue;
      const occupant = players.find((p) => p.seat === seat);
      if (!occupant) continue;
      out[seat] = {
        userId: getRoomPlayerProfileUserId(occupant),
        deviceId: occupant.deviceId ?? null,
      };
    }
    return out;
  }, [players, seatKinds]);

  // Stable refs to the latest values handlers depend on. Using refs lets
  // dispatchAction / handleSay / handleSendText keep referential identity
  // across renders, so React.memo on TrucBoard / TableChat doesn't tear down
  // and rebuild children every time `data` mutates (which happens twice per
  // local move: optimistic apply + realtime echo).
  const dispatchCtxRef = useRef<{
    roomId: string | null;
    mySeat: PlayerId | null;
    deviceId: string;
  }>({ roomId: null, mySeat: null, deviceId });
  dispatchCtxRef.current = {
    roomId: data?.room.id ?? null,
    mySeat,
    deviceId,
  };

  const dispatchAction = useCallback(async (player: PlayerId, action: Action) => {
    if (isSpectatorRef.current) return;
    const ctx = dispatchCtxRef.current;
    if (!ctx.roomId) return;
    let rollback: (() => void) | null = null;
    let markHttp: ((ok: boolean) => void) | null = null;
    if (ctx.mySeat != null && player === ctx.mySeat) {
      const handle = applyOptimistic(player, action);
      rollback = handle.rollback;
      markHttp = handle.markHttp;
    }
    const isTransient = (err: unknown): boolean => {
      const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
      return (
        msg.includes("failed to fetch") ||
        msg.includes("networkerror") ||
        msg.includes("network request failed") ||
        msg.includes("timeout") ||
        msg.includes("timed out") ||
        msg.includes("502") ||
        msg.includes("503") ||
        msg.includes("504") ||
        msg.includes("ecconn") ||
        msg.includes("aborted")
      );
    };
    const trySubmit = async () => {
      const result = await submitAction({ data: { roomId: ctx.roomId!, deviceId: ctx.deviceId, action } });
      return result;
    };
    try {
      const result = await trySubmit();
      if (result?.stale) {
        // State was stale (race with bot advance) — silently rollback and refresh
        if (rollback) rollback();
        try { await runWithExplicitRefresh(async () => {}); } catch { /* noop */ }
        return;
      }
      if (markHttp) markHttp(true);
    } catch (firstErr) {
      if (isTransient(firstErr)) {
        await new Promise((r) => setTimeout(r, 250));
        try {
          const result = await trySubmit();
          if (result?.stale) {
            if (rollback) rollback();
            try { await runWithExplicitRefresh(async () => {}); } catch { /* noop */ }
            return;
          }
          if (markHttp) markHttp(true);
          return;
        } catch (retryErr) {
          if (markHttp) markHttp(false);
          if (rollback) rollback();
          toast.error(retryErr instanceof Error ? retryErr.message : String(retryErr));
          try { await runWithExplicitRefresh(async () => {}); } catch { /* noop */ }
          return;
        }
      }
      if (markHttp) markHttp(false);
      if (rollback) rollback();
      toast.error(firstErr instanceof Error ? firstErr.message : String(firstErr));
      try { await runWithExplicitRefresh(async () => {}); } catch { /* noop */ }
    }
  }, [applyOptimistic, runWithExplicitRefresh]);

  const handleSay = useCallback(async (phraseId: ChatPhraseId) => {
    if (isSpectatorRef.current) return;
    const roomId = dispatchCtxRef.current.roomId;
    if (!roomId) return;
    try {
      await sendChatPhrase({ data: { roomId, deviceId: dispatchCtxRef.current.deviceId, phraseId } });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  }, []);

  const handleSendText = useCallback(async (text: string) => {
    const roomId = dispatchCtxRef.current.roomId;
    if (!roomId) return;
    try {
      await sendTextMessage({
        data: {
          roomId,
          deviceId: dispatchCtxRef.current.deviceId,
          text: filterProfanity(text),
          // En mode espectador, el servidor exigeix un senderName perquè
          // el nostre device no està a room_players.
          senderName: isSpectatorRef.current ? (name || undefined) : undefined,
        },
      });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  }, [name]);

  const handleFlagSeat = useCallback(async (
    targetSeat: PlayerId,
    ctx?: { messageId?: number; messageText?: string },
  ) => {
    const roomId = dispatchCtxRef.current.roomId;
    if (!roomId) return;
    try {
      const res = await flagPlayerInChat({
        data: {
          roomId,
          deviceId: dispatchCtxRef.current.deviceId,
          targetSeat,
          messageId: ctx?.messageId ?? null,
          messageText: ctx?.messageText ?? null,
        },
      });
      toast.success(`Jugador silenciat ${res.muteMinutes} min al xat (${res.reporterCount} report${res.reporterCount === 1 ? "" : "s"}).`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  }, []);

  // Compta humans REALMENT ocupats (presents a la sala). Una proposta
  // col·lectiva només té sentit si hi ha 2 o més humans.
  const humanCount = useMemo(() => {
    if (!players || !seatKinds) return 0;
    return players.filter((p) => seatKinds[p.seat] === "human").length;
  }, [players, seatKinds]);

  const proposeOrExecute = useCallback(async (kind: "pause" | "restart" | "resume") => {
    const ctx = dispatchCtxRef.current;
    if (!ctx.roomId) return;
    try {
      if (kind === "pause" && humanCount <= 1) {
        await setPaused({ data: { roomId: ctx.roomId, deviceId: ctx.deviceId, paused: true } });
        return;
      }
      if (kind === "resume" && humanCount <= 1) {
        await setPaused({ data: { roomId: ctx.roomId, deviceId: ctx.deviceId, paused: false } });
        return;
      }
      await proposeAction({ data: { roomId: ctx.roomId, deviceId: ctx.deviceId, kind } });
      if (humanCount > 1) {
        toast.info(
          kind === "pause"
            ? "Esperant que els altres jugadors confirmen la pausa…"
            : kind === "resume"
            ? "Esperant que els altres jugadors confirmen reanudar la partida…"
            : "Esperant que els altres jugadors confirmen reiniciar la partida…",
        );
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  }, [humanCount]);

  const handlePauseToggle = useCallback(async (next: boolean) => {
    if (isSpectatorRef.current) return;
    const ctx = dispatchCtxRef.current;
    if (!ctx.roomId) return;
    try {
      if (!next) {
        await proposeOrExecute("resume");
        return;
      }
      await proposeOrExecute("pause");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  }, [proposeOrExecute]);

  // Need a ref for status because handleNewGame captures it but we want a
  // stable identity across re-renders.
  const roomStatusRef = useRef<RoomFullDTO["room"]["status"] | null>(null);
  roomStatusRef.current = data?.room.status ?? null;

  const handleNewGame = useCallback(async () => {
    if (isSpectatorRef.current) return;
    const ctx = dispatchCtxRef.current;
    if (!ctx.roomId) return;
    const status = roomStatusRef.current;
    // Final de partida (status="finished") o taula tornada al lobby:
    // l'usuari es queda i demanem una nova partida. Si la taula està
    // plena, comença immediatament; si algú ha abandonat, esperem que
    // s'ompli i el servidor l'iniciarà sol.
    if (status === "finished" || status === "lobby") {
      try {
        await rematchStay({ data: { roomId: ctx.roomId, deviceId: ctx.deviceId } });
      } catch (e) {
        toast.error(e instanceof Error ? e.message : String(e));
      }
      return;
    }
    // Partida en curs: cal el consentiment de tots per a reiniciar.
    if (humanCount <= 1) {
      try {
        await proposeAction({ data: { roomId: ctx.roomId, deviceId: ctx.deviceId, kind: "restart" } });
      } catch (e) {
        toast.error(e instanceof Error ? e.message : String(e));
      }
      return;
    }
    await proposeOrExecute("restart");
  }, [humanCount, proposeOrExecute]);

  // Resposta a una proposta col·lectiva.
  const respondToProposal = useCallback(async (accept: boolean) => {
    const ctx = dispatchCtxRef.current;
    if (!ctx.roomId) return;
    try {
      const res = await respondProposal({ data: { roomId: ctx.roomId, deviceId: ctx.deviceId, accept } });
      if (res.status === "rejected") {
        toast.error("Has rebutjat la proposta.");
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  }, []);

  // Detecció de canvis a la proposta (rebuig / expiració) per al proposant.
  const lastProposalRef = useRef<string | null>(null);
  const proposal = data?.room.pendingProposal ?? null;
  useEffect(() => {
    const sig = proposal
      ? `${proposal.createdAt}|${Object.values(proposal.votes).join(",")}`
      : null;
    const prev = lastProposalRef.current;
    lastProposalRef.current = sig;
    // Quan una proposta desapareix sense haver-se executat (cap canvi de status
    // observable a aquest nivell), si jo era el proposant ho interpretem com
    // a rebuig.
    if (prev && !sig && data && mySeat != null) {
      // No tenim info de qui era el proposant ara; només mostrem el toast si
      // som l'únic que va proposar (cap altra proposta entrant). Ho controlem
      // amb un ref a part.
      if (lastProposerSeatRef.current === mySeat) {
        toast.error("No han acceptat tots els jugadors, no és possible.");
      }
      lastProposerSeatRef.current = null;
    }
    if (proposal) {
      lastProposerSeatRef.current = proposal.proposerSeat;
    }
  }, [proposal, data, mySeat]);
  const lastProposerSeatRef = useRef<PlayerId | null>(null);

  // Caducitat automàtica al client: quan expira, si encara hi ha proposta,
  // la cancel·lem (un client qualsevol). Tot i així, la cancel·lació la fa
  // el primer que hi arribe.
  useEffect(() => {
    if (!proposal || !data) return;
    const ms = new Date(proposal.expiresAt).getTime() - Date.now();
    if (ms <= 0) {
      cancelProposal({ data: { roomId: data.room.id } }).catch(() => {});
      return;
    }
    const t = window.setTimeout(() => {
      cancelProposal({ data: { roomId: data.room.id } }).catch(() => {});
    }, ms + 200);
    return () => window.clearTimeout(t);
  }, [proposal, data]);

  const seatNamesBySeat = useMemo<Record<PlayerId, string>>(() => {
    const out: Record<PlayerId, string> = { 0: "", 1: "", 2: "", 3: "" };
    if (players && seatKinds) {
      for (const seat of [0, 1, 2, 3] as PlayerId[]) {
        const occupant = players.find((p) => p.seat === seat);
        out[seat] = occupant
          ? occupant.name
          : seatKinds[seat] === "bot" ? `Bot ${seat + 1}` : `Seient ${seat + 1}`;
      }
    }
    return out;
  }, [players, seatKinds]);

  const flagNotices = useMemo(
    () => buildChatFlagNotices(chatFlags.flags, deviceId, seatNamesBySeat),
    [chatFlags.flags, deviceId, seatNamesBySeat],
  );

  const lastHumanInRoom = humanCount <= 1;

  const handleAbandon = useCallback(async () => {
    const ctx = dispatchCtxRef.current;
    const wasSpectator = isSpectatorRef.current;
    // Marquem que estem abandonant per a que la UI no mostre la pantalla
    // d'error si la sala s'esborra (cas de l'últim humà) mentre encara no
    // s'ha completat la navegació.
    leavingRef.current = true;
    // Navega immediatament: així evitem que un re-render intermedi mostre
    // l'error "room_not_found" quan el servidor esborra la sala perquè
    // érem l'últim humà.
    const sala = code ? salaForRoom({ code }) : null;
    navigate(sala ? `/online/lobby/${sala}` : "/");
    if (!wasSpectator && ctx.roomId) {
      if (!lastHumanInRoom) {
        try {
          await applyAbandonXpPenalty(10);
        } catch {
          /* best-effort; no bloquegem la navegació */
        }
      }
      try {
        await leaveRoom({ data: { roomId: ctx.roomId, deviceId: ctx.deviceId } });
      } catch {
        // No bloquegem la navegació si la crida falla; el servidor té
        // mecanismes de neteja per detectar humans desconnectats.
      }
    }
  }, [navigate, lastHumanInRoom, code]);
  const handleChangeTurnTimeoutSec = useCallback(
    (sec: TurnTimeoutSec) => update({ turnTimeoutSec: sec }),
    [update],
  );

  // Modal de confirmació per a la proposta col·lectiva (mostrat a tots els
  // humans excepte al proposant, mentre el seu vot encara siga "pending").
  const myVote = proposal ? proposal.votes[deviceId] : undefined;
  const showProposalModal =
    !!proposal &&
    mySeat != null &&
    proposal.proposerSeat !== mySeat &&
    myVote === "pending";
  // Modal d'espera per al proposant: així té feedback visual i pot cancel·lar
  // la proposta sense haver de tornar a clicar el botó (que provocaria
  // "proposal_already_active").
  const showProposerWaitingModal =
    !!proposal &&
    mySeat != null &&
    proposal.proposerSeat === mySeat;
  const cancelMyProposal = useCallback(async () => {
    const ctx = dispatchCtxRef.current;
    if (!ctx.roomId) return;
    try {
      await cancelProposal({ data: { roomId: ctx.roomId } });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  }, []);


  if (!ready || loading) return <Loading />;
  if (error) {
    if (leavingRef.current) return <Loading />;
    return (
      <main className="min-h-screen flex flex-col items-center justify-center gap-3 px-5">
        <p className="text-destructive text-sm text-center">{error}</p>
        <Button onClick={() => navigate("/")} variant="outline">Tornar a inici</Button>
      </main>
    );
  }
  if (!data) return <Loading />;

  // Room transitioned away from "playing" — show contextual UI instead of
  // infinite loading when matchState becomes null.
  const roomStatus = data.room.status;
  // "abandoned": la taula s'ha tancat definitivament.
  if (roomStatus === "abandoned") {
    return (
      <main className="min-h-screen flex flex-col items-center justify-center gap-4 px-5">
        <h2 className="font-display font-bold text-gold text-xl">Taula tancada</h2>
        <p className="text-sm text-muted-foreground text-center">
          Aquesta taula ha sigut tancada.
        </p>
        <div className="flex gap-3">
          <Button onClick={() => navigate("/")} variant="outline">Tornar a inici</Button>
          <Button onClick={() => navigate("/")}>Inici</Button>
        </div>
      </main>
    );
  }
  // "finished": mantenim el TrucBoard renderitzat per a que es veja
  //   l'overlay final amb els botons "Nova partida" / "Abandonar".
  // "lobby": si veníem d'una partida acabada i algú ha eixit, la taula
  //   torna a lobby esperant nous jugadors. Mostrem una pantalla d'espera.
  if (roomStatus === "lobby") {
    return (
      <main className="min-h-screen flex flex-col items-center justify-center gap-4 px-5">
        <h2 className="font-display font-bold text-gold text-xl">Esperant jugadors</h2>
        <p className="text-sm text-muted-foreground text-center">
          La taula està esperant que s'òmpliguen els seients lliures. La nova partida començarà automàticament.
        </p>
        <Button onClick={handleAbandon} variant="outline">Abandonar la taula</Button>
      </main>
    );
  }

  if (!state) return <Loading />;

  if (mySeat == null && !isSpectator) {
    return (
      <main className="min-h-screen flex flex-col items-center justify-center gap-3 px-5">
        <p className="text-sm text-muted-foreground text-center">No estàs en aquesta partida.</p>
        <Button onClick={() => navigate(`/online/sala/${code}`)} variant="outline">Entrar a la sala</Button>
      </main>
    );
  }

  // Spectator: pick a player to follow.
  if (isSpectator && mySeat == null && spectatorSeat == null) {
    const room = data!.room;
    const pickerSeats: SeatInfo[] = ([0, 1, 2, 3] as PlayerId[]).map((s) => {
      const kind = seatKinds?.[s] ?? "empty";
      const occ = players?.find((p) => p.seat === s);
      const isHostSeat = !!occ && occ.deviceId === room.hostDevice;
      let occupant: SeatInfo["occupant"];
      if (kind === "bot") {
        occupant = { kind: "bot", avatarUrl: seatAvatars[s] ?? null };
      } else if (kind === "human" && occ) {
        occupant = {
          kind: "human",
          name: occ.name,
          online: seatPresence[s] !== "offline",
          lastSeen: seatPresenceLastSeen[s],
          avatarUrl: seatAvatars[s] ?? null,
          userId: seatIdentities[s]?.userId ?? null,
          deviceId: seatIdentities[s]?.deviceId ?? null,
        };
      } else {
        occupant = { kind: "empty" };
      }
      return {
        seat: s,
        kind,
        occupant,
        isHost: isHostSeat,
        // Cliclable: humà o bot. Lliure no permet seguir ningú.
        selectable: kind === "human" || kind === "bot",
      };
    });
    const copyCode = async () => {
      try {
        await navigator.clipboard.writeText(code);
        setSpectatorCopied(true);
        window.setTimeout(() => setSpectatorCopied(false), 1500);
      } catch {
        /* noop */
      }
    };
    return (
      <main className="menu-screen min-h-screen flex flex-col items-center px-5 py-4">
        <div className="w-full max-w-md flex-1 flex flex-col">
          <div className="flex items-center justify-between">
            <ShareAppButton />
            <Button
              onClick={handleAbandon}
              size="sm"
              variant="outline"
              className="h-8 w-8 p-0 border-foreground/80 text-foreground hover:bg-foreground/10"
              aria-label={t("common.back_home")}
              title={t("common.back_home")}
            >
              <LogOut className="w-4 h-4" />
            </Button>
          </div>

          <div className="flex-1 flex flex-col justify-center gap-5 py-4">
            <header className="text-center flex flex-col items-center gap-2">
              <div className="inline-flex items-center gap-3">
                <h1 className="font-title font-black italic text-gold text-3xl sm:text-4xl">
                  {t("sala.table")}
                </h1>
                <button
                  type="button"
                  onClick={copyCode}
                  className="inline-flex items-center gap-2 px-3 py-1.5 rounded-xl border-2 border-primary/60 bg-background/40 hover:bg-primary/10"
                  aria-label={t("sala.copy_code")}
                  title={t("sala.copy_code_short")}
                >
                  <span className="sala-code-title font-title font-black italic text-primary text-3xl sm:text-4xl">
                    {code}
                  </span>
                  {spectatorCopied ? (
                    <Check className="w-5 h-5 text-team-nos" />
                  ) : (
                    <Copy className="w-5 h-5 text-primary/70" />
                  )}
                </button>
              </div>
            </header>

            <section className="flex flex-col gap-3">
              <p className="text-base font-semibold text-foreground text-center">
                La partida de quin jugador vols seguir?
              </p>
              <p className="text-sm text-muted-foreground text-center">
                Selecciona el avatar del jugador de qui vullgues veure la seua partida i les seues cartes
              </p>
              <TableSeatPicker
                seats={pickerSeats}
                showTeams
                textSize="large"
                onSeatClick={(s) => {
                  const kind = seatKinds?.[s];
                  if (kind !== "human" && kind !== "bot") return;
                  navigate(`/online/partida/${code}?spectator=1&seat=${s}`, { replace: true });
                }}
              />
            </section>

            <div className="flex items-center justify-center gap-1.5 flex-wrap">
              {[
                { label: `${room.targetCames} cames` },
                { label: t("sala.points", { n: room.targetCama }) },
                { label: `${room.turnTimeoutSec}s/torn` },
              ].map((opt) => (
                <button
                  key={opt.label}
                  type="button"
                  disabled
                  aria-disabled
                  className="option-chip inline-flex items-center justify-center rounded-md border border-primary/25 bg-background/30 text-foreground h-8 px-3 text-[11px] font-display leading-tight whitespace-nowrap cursor-not-allowed opacity-100"
                >
                  <span className="option-chip-label">{opt.label}</span>
                </button>
              ))}
            </div>
          </div>
        </div>
      </main>
    );
  }


  // viewerSeat is guaranteed non-null beyond this point
  const renderSeat: PlayerId = (mySeat ?? spectatorSeat) as PlayerId;

  return (
    <>
      <TrucBoard
        match={state as MatchState}
        humanActions={myActions}
        dispatch={dispatchAction}
        shoutFlash={shoutFlash}
        shoutFlashes={shoutFlashes}
        lastShoutByPlayer={display!.lastShoutByPlayer}
        shoutLabelByPlayer={display!.shoutLabelByPlayer}
        acceptedShoutByPlayer={display!.acceptedShoutByPlayer}
        rejectedShoutByPlayer={display!.rejectedShoutByPlayer}
        shoutFamilyByPlayer={display!.shoutFamilyByPlayer}
        envitShoutByPlayer={display!.envitShoutByPlayer}
        envitShoutLabelByPlayer={display!.envitShoutLabelByPlayer}
        envitOutcomeByPlayer={display!.envitOutcomeByPlayer}
        messages={chatMessages}
        onSay={handleSay}
        onNewGame={handleNewGame}
        onAbandon={handleAbandon}
        onMatchEnd={(winnerTeam) => {
          if (isSpectator || mySeat == null || !seatKinds) return;
          const myTeam: "nos" | "ells" = (mySeat % 2 === 0) ? "nos" : "ells";
          const won = winnerTeam === myTeam;
          // Comptem oponents (3 seients que no són el meu)
          let humans = 0; let bots = 0;
          for (let s = 0; s < 4; s++) {
            if (s === mySeat) continue;
            const k = seatKinds[s];
            if (k === "human") humans++;
            else if (k === "bot") bots++;
            else bots++; // seient buit: comptat com a bot per a l'XP
          }
          void recordMatchResult(won, humans, bots);
        }}
        perspectiveSeat={renderSeat}
        seatNames={seatNames}
        dealKey={dealKey}
        initialConsumedDealKey={consumedDealKeyRef.current}
        onDealKeyConsumed={handleDealKeyConsumed}
        onDealAnimationEnd={handleDealAnimationEnd}
        onTransitionActiveChange={setTransitionActive}
        
        belowHandSlot={
          <TableChat
            messages={textMessages}
            mySeat={renderSeat}
            seatNames={seatNamesBySeat}
            onSend={handleSendText}
            roomCode={code}
            mutedSeatsExpiry={chatFlags.mutedSeatsExpiry}
            myMuteExpiresAt={chatFlags.myMuteExpiresAt}
            onFlagSeat={isSpectator ? undefined : handleFlagSeat}
            iAlreadyFlaggedSeat={chatFlags.iAlreadyFlagged}
            flagNotices={flagNotices}
            seatIdentities={seatIdentities}
          />
        }
        turnTimeoutSec={(data.room.turnTimeoutSec ?? settings.turnTimeoutSec) as TurnTimeoutSec}
        onChangeTurnTimeoutSec={handleChangeTurnTimeoutSec}
        turnAnchorAt={data.room.turnStartedAt}
        seatPresence={seatPresence}
        seatPresenceLastSeen={seatPresenceLastSeen}
        seatAvatars={seatAvatars}
        seatIdentities={seatIdentities}
        onPauseToggle={isSpectator ? undefined : handlePauseToggle}
        paused={data.room.pausedAt != null}
        isSpectator={isSpectator}
        lastHumanInRoom={lastHumanInRoom}
      />
      <BoardRoomChat
        roomId={data.room.id}
        roomCode={code}
        deviceId={deviceId}
        name={name}
        hasName={hasName}
        ready={ready}
        mySeat={renderSeat}
        players={players ?? []}
        salaSlug={code ? salaForRoom({ code }) : null}
        buttonClassName="fixed right-4 top-[125px] z-40 h-12 w-12 rounded-full text-primary-foreground shadow-lg bg-accent"
      />

      {showProposalModal && proposal && (
        <div
          className="fixed inset-0 z-[9200] bg-black/80 backdrop-blur-sm flex items-center justify-center p-4"
          role="dialog"
          aria-modal="true"
        >
          <div className="bg-background border border-primary/30 rounded-2xl p-6 w-[92vw] sm:max-w-md shadow-lg space-y-4">
            <h2 className="font-title font-black italic text-gold text-2xl text-center">
              {proposal.kind === "pause"
                ? `${proposal.proposerName} vol pausar la partida`
                : proposal.kind === "resume"
                ? `${proposal.proposerName} vol reanudar la partida`
                : `${proposal.proposerName} vol començar de nou la partida`}
            </h2>
            <p className="text-sm text-muted-foreground text-center">
              Cal el consentiment de tots els jugadors humans. Si no acceptes, la
              proposta es cancel·larà.
            </p>
            <div className="flex flex-col-reverse sm:flex-row sm:justify-end gap-2 w-full">
              <Button variant="outline" onClick={() => respondToProposal(false)}>
                No accepte
              </Button>
              <Button onClick={() => respondToProposal(true)}>
                Accepte
              </Button>
            </div>
          </div>
        </div>
      )}

      {showProposerWaitingModal && proposal && (
        <div
          className="fixed inset-0 z-[9200] bg-black/80 backdrop-blur-sm flex items-center justify-center p-4"
          role="dialog"
          aria-modal="true"
        >
          <div className="bg-background border border-primary/30 rounded-2xl p-6 w-[92vw] sm:max-w-md shadow-lg space-y-4">
            <h2 className="font-title font-black italic text-gold text-2xl text-center">
              {proposal.kind === "pause"
                ? "Esperant que els altres jugadors accepten pausar la partida"
                : proposal.kind === "resume"
                ? "Esperant que els altres jugadors accepten reanudar la partida"
                : "Esperant que els altres jugadors accepten començar una nova partida"}
            </h2>
            <p className="text-sm text-muted-foreground text-center">
              Cal el consentiment de tots els jugadors humans. Pots cancel·lar la
              proposta mentre esperes.
            </p>
            <div className="flex justify-center w-full">
              <Button variant="outline" onClick={cancelMyProposal}>
                Cancel·lar
              </Button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
export default OnlinePartidaPage;