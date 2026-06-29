// Edge Function: rooms-rpc
// Fase 5 — Bots humanizados (3-tick consult + 7s freno 2º de pareja 1ª baza)
//          + Sistema de votación democrática (pausa/reanudar/nova partida)
//
// Despliegue:  supabase functions deploy rooms-rpc --no-verify-jwt
//
// Estructura:
//   supabase/functions/rooms-rpc/
//     index.ts        <- este archivo
//     _game/          <- copia espejo de src/game/
//
// Secrets requeridos:
//   ADMIN_PASSWORD
// Inyectados por Supabase:
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import { z } from "https://esm.sh/zod@3.23.8";

import { applyAction, legalActions, startNextRound, createMatch } from "./_game/engine.ts";
import { botDecide } from "./_game/bot.ts";
import {
  shouldConsultPartner,
  pickQuestion,
  partnerAnswerFor,
  adviceFromAnswer,
  type PartnerAdvice,
} from "./_game/botConsult.ts";
import { partnerOf } from "./_game/types.ts";
import type { Action, MatchState, PlayerId } from "./_game/types.ts";


function makeCorsHeaders(req: Request) {
  const origin = req.headers.get("origin") || "*";
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Headers":
      "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
  };
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function withCors(response: Response, req: Request) {
  const headers = new Headers(response.headers);
  const cors = makeCorsHeaders(req);
  for (const [k, v] of Object.entries(cors)) headers.set(k, v);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false } },
);

// ---------------------------------------------------------------------------
// Utilidades
// ---------------------------------------------------------------------------

const PRESENCE_ONLINE_MS = 35_000;

// Sustitución por bot tras 5 min sin presencia.
const DISCONNECT_TO_BOT_MS = 5 * 60_000;
// Tras este número de turnos consecutivos perdidos por timeout, el seient
// passa a piloto automátic (el motor de bots tira per ell sense esperar).
const AFK_AUTOPILOT_THRESHOLD = 3;

// Timings — mirroran src/game/chatTimings.ts
const CONSULT_QUESTION_DELAY_MS = 1000;
const CONSULT_ANSWER_DELAY_MS = 1300;
const CONSULT_DECIDE_DELAY_MS = 1500;
const SECOND_PLAYER_WAIT_MIN_MS = 7000;
const SECOND_PLAYER_WAIT_MAX_MS = 10000;
function randomSecondPlayerWaitMs(): number {
  return Math.floor(
    SECOND_PLAYER_WAIT_MIN_MS +
      Math.random() * (SECOND_PLAYER_WAIT_MAX_MS - SECOND_PLAYER_WAIT_MIN_MS + 1),
  );
}
const BOT_DELAY_MS = 1000;
const ROUND_END_DELAY_MS = 2000;

// Votaciones
const PROPOSAL_TTL_MS = 60_000;

function nowIso() {
  return new Date().toISOString();
}
function nowMs() {
  return Date.now();
}

type SeatKind = "human" | "bot" | "empty";

interface RoomRow {
  id: string;
  code: string;
  sala_slug: string | null;
  status: "lobby" | "playing" | "finished" | "abandoned";
  target_cames: number;
  target_cama: number;
  turn_timeout_sec: number;
  initial_mano: number;
  seat_kinds: SeatKind[];
  host_device: string;
  match_state: unknown;
  turn_started_at: string | null;
  paused_at: string | null;
  pending_proposal: unknown;
  created_at: string;
  updated_at: string;
}

interface PlayerRow {
  room_id: string;
  seat: number;
  device_id: string;
  name: string;
  last_seen: string;
}

function rowToRoomDTO(r: RoomRow) {
  return {
    id: r.id,
    code: r.code,
    status: r.status,
    targetCames: r.target_cames,
    targetCama: r.target_cama,
    turnTimeoutSec: r.turn_timeout_sec,
    initialMano: r.initial_mano,
    seatKinds: r.seat_kinds,
    hostDevice: r.host_device,
    matchState: r.match_state ?? null,
    turnStartedAt: r.turn_started_at,
    pausedAt: r.paused_at,
    pendingProposal: r.pending_proposal ?? null,
  };
}

function playerRowToDTO(p: PlayerRow, srv?: ServerSide) {
  const ageMs = Date.now() - new Date(p.last_seen).getTime();
  const seat = p.seat as PlayerId;
  return {
    seat,
    name: p.name,
    deviceId: p.device_id,
    isOnline: ageMs <= PRESENCE_ONLINE_MS,
    lastSeen: p.last_seen,
    disconnectedSince: srv?.disconnectedSince?.[seat] ?? null,
    botified: !!srv?.botifiedSeats?.includes(seat),
    afkAutoPilot: !!srv?.afkAutoPilot?.[seat],
  };
}

// ---------------------------------------------------------------------------
// Privacidad de cartas: las manos completas viven en `room_private_hands`
// (sólo service_role). En `rooms.match_state` se guardan placeholders sin
// suit/rank para que el broadcast realtime no las exponga.
// ---------------------------------------------------------------------------

type PrivateHands = Partial<Record<PlayerId, Array<{ id: string; suit: string; rank: number }>>>;

function isHiddenCard(c: unknown): boolean {
  return !!c && typeof c === "object" && (c as { hidden?: boolean }).hidden === true;
}

function hasAnyRealHand(state: MatchState): boolean {
  const hands = (state.round?.hands ?? {}) as Record<PlayerId, unknown[]>;
  for (const p of [0, 1, 2, 3] as PlayerId[]) {
    const arr = hands[p] ?? [];
    for (const c of arr) {
      if (!isHiddenCard(c)) return true;
    }
  }
  return false;
}

function extractHands(state: MatchState): PrivateHands {
  const out: PrivateHands = {};
  const hands = state.round?.hands ?? ({} as Record<PlayerId, unknown[]>);
  for (const p of [0, 1, 2, 3] as PlayerId[]) {
    const arr = (hands[p] ?? []) as Array<unknown>;
    // Sólo guardamos cartas reales (no placeholders); si todas son hidden,
    // se omite el asiento (la mano efectiva está vacía o ya enmascarada).
    const real = arr.filter((c) => !isHiddenCard(c)) as PrivateHands[PlayerId];
    if (real && real.length > 0) out[p] = real;
  }
  return out;
}

function maskHandsForStorage(state: MatchState): MatchState {
  const hands = (state.round?.hands ?? {}) as Record<PlayerId, Array<unknown>>;
  const masked: Record<PlayerId, Array<unknown>> = { 0: [], 1: [], 2: [], 3: [] };
  for (const p of [0, 1, 2, 3] as PlayerId[]) {
    const arr = hands[p] ?? [];
    masked[p] = arr.map((_c, i) => ({
      id: `hidden-${p}-${i}`,
      suit: "oros",
      rank: 1,
      hidden: true,
    }));
  }
  return { ...state, round: { ...state.round, hands: masked as never } } as MatchState;
}

function mergeHands(state: MatchState, priv: PrivateHands): MatchState {
  const cur = (state.round?.hands ?? {}) as Record<PlayerId, Array<unknown>>;
  const next: Record<PlayerId, Array<unknown>> = { 0: [], 1: [], 2: [], 3: [] };
  for (const p of [0, 1, 2, 3] as PlayerId[]) {
    const real = priv[p];
    if (real && real.length > 0) {
      next[p] = real;
    } else {
      // Si no hay manos privadas guardadas (legado o ya vacías), conserva las
      // cartas existentes en match_state (pueden ser reales o placeholders).
      next[p] = cur[p] ?? [];
    }
  }
  return { ...state, round: { ...state.round, hands: next as never } } as MatchState;
}

async function loadPrivateHands(roomId: string): Promise<PrivateHands> {
  const { data, error } = await supabase
    .from("room_private_hands").select("hands").eq("room_id", roomId).maybeSingle();
  if (error) {
    // Si la tabla no existe aún, devolvemos vacío para no romper la app
    // (modo degradado). Las cartas viajarán enmascaradas igualmente porque
    // las escrituras también enmascaran.
    if ((error.message ?? "").toLowerCase().includes("does not exist")) return {};
    throw new Error(error.message);
  }
  return ((data as { hands?: PrivateHands } | null)?.hands ?? {}) as PrivateHands;
}

async function savePrivateHands(roomId: string, hands: PrivateHands): Promise<void> {
  const { error } = await supabase
    .from("room_private_hands")
    .upsert({ room_id: roomId, hands, updated_at: nowIso() }, { onConflict: "room_id" });
  if (error) {
    if ((error.message ?? "").toLowerCase().includes("does not exist")) return;
    throw new Error(error.message);
  }
}

/**
 * Actualiza `rooms` enmascarando match_state y persistiendo las manos reales
 * por separado. Usado por todos los sitios que escriben match_state.
 */
async function persistRoomState(
  roomId: string,
  state: MatchState,
  extraPatch: Record<string, unknown> = {},
): Promise<void> {
  // Si el state que nos pasan ya viene enmascarado (todas las cartas son
  // hidden), no machacamos las manos reales guardadas: simplemente persistimos
  // el patch del match_state tal cual.
  if (hasAnyRealHand(state)) {
    const privateHands = extractHands(state);
    await savePrivateHands(roomId, privateHands);
  }
  const masked = maskHandsForStorage(state);
  const patch: Record<string, unknown> = { ...extraPatch, match_state: masked };
  const { error } = await supabase.from("rooms").update(patch).eq("id", roomId);
  if (error) throw new Error(error.message);
}

async function fetchRoomById(roomId: string): Promise<RoomRow | null> {
  const { data, error } = await supabase
    .from("rooms").select("*").eq("id", roomId).maybeSingle();
  if (error) throw new Error(error.message);
  const row = (data as RoomRow | null) ?? null;
  if (!row || !row.match_state) return row;
  const priv = await loadPrivateHands(row.id);
  row.match_state = mergeHands(row.match_state as MatchState, priv) as unknown;
  return row;
}

async function fetchRoomByCode(code: string): Promise<RoomRow | null> {
  const { data, error } = await supabase
    .from("rooms").select("*").eq("code", code).maybeSingle();
  if (error) throw new Error(error.message);
  const row = (data as RoomRow | null) ?? null;
  if (!row || !row.match_state) return row;
  const priv = await loadPrivateHands(row.id);
  row.match_state = mergeHands(row.match_state as MatchState, priv) as unknown;
  return row;
}

async function fetchPlayers(roomId: string): Promise<PlayerRow[]> {
  const { data, error } = await supabase
    .from("room_players").select("*").eq("room_id", roomId)
    .order("seat", { ascending: true });
  if (error) throw new Error(error.message);
  return (data ?? []) as PlayerRow[];
}

/**
 * Devuelve un match_state con TODAS las manos enmascaradas EXCEPTO la del
 * asiento dado. Si `seat` es null (espectador), enmascara todas.
 */
function maskMatchStateForViewer(state: MatchState, seat: PlayerId | null): MatchState {
  const masked = maskHandsForStorage(state);
  if (seat == null) return masked;
  const real = (state.round?.hands ?? {}) as Record<PlayerId, Array<unknown>>;
  const hands = (masked.round.hands as unknown) as Record<PlayerId, Array<unknown>>;
  hands[seat] = real[seat] ?? [];
  return masked;
}

function requireAdmin(password: unknown) {
  const expected = Deno.env.get("ADMIN_PASSWORD");
  if (!expected) throw new Error("admin_not_configured");
  if (typeof password !== "string" || password !== expected) {
    throw new Error("forbidden");
  }
}

// ---------------------------------------------------------------------------
// createRoom / joinRoom / getRoom / lobby / heartbeat / leave / settings
// ---------------------------------------------------------------------------

const CreateRoomSchema = z.object({
  hostDevice: z.string().min(1),
  hostName: z.string().min(1).max(40),
  targetCames: z.number().int().min(1).max(10),
  targetCama: z.number().int().refine((n) => n === 9 || n === 12).optional(),
  turnTimeoutSec: z.number().int().min(5).max(180).optional(),
  initialMano: z.number().int().min(0).max(3),
  seatKinds: z.array(z.enum(["human", "bot", "empty"])).length(4),
  hostSeat: z.number().int().min(0).max(3),
  salaSlug: z.string().min(1).max(40).optional(),
  requestedCode: z.string().min(6).max(6).optional(),
});

async function createRoom(input: z.infer<typeof CreateRoomSchema>) {
  const seatKinds = [...input.seatKinds];
  if (seatKinds[input.hostSeat] !== "human") seatKinds[input.hostSeat] = "human";
  const code = input.requestedCode?.toUpperCase();
  if (!code) throw new Error("missing_requested_code");

  const exists = await fetchRoomByCode(code);
  if (exists) {
    if (exists.status === "playing") throw new Error("room_in_play");
    await supabase.from("room_players").delete().eq("room_id", exists.id);
    const { error: delErr } = await supabase.from("rooms").delete().eq("id", exists.id);
    if (delErr) throw new Error(delErr.message);
  }

  const { data: room, error } = await supabase
    .from("rooms")
    .insert({
      code,
      sala_slug: input.salaSlug ?? null,
      status: "lobby",
      target_cames: input.targetCames,
      target_cama: input.targetCama ?? 12,
      turn_timeout_sec: input.turnTimeoutSec ?? 30,
      initial_mano: input.initialMano,
      seat_kinds: seatKinds,
      host_device: input.hostDevice,
    })
    .select("id, code").single();
  if (error) throw new Error(error.message);

  const { error: pErr } = await supabase.from("room_players").insert({
    room_id: room.id, seat: input.hostSeat,
    device_id: input.hostDevice, name: input.hostName, last_seen: nowIso(),
  });
  if (pErr) throw new Error(pErr.message);
  return { code: room.code as string, roomId: room.id as string };
}

const JoinRoomSchema = z.object({
  code: z.string().min(6).max(6),
  deviceId: z.string().min(1),
  name: z.string().min(1).max(40),
  preferredSeat: z.number().int().min(0).max(3).nullable().optional(),
});

async function joinRoom(input: z.infer<typeof JoinRoomSchema>) {
  const code = input.code.toUpperCase();
  const room = await fetchRoomByCode(code);
  if (!room) throw new Error("room_not_found");
  if (room.status === "finished" || room.status === "abandoned") throw new Error("room_closed");

  const players = await fetchPlayers(room.id);
  const mine = players.find((p) => p.device_id === input.deviceId);

  // Blindaje estricto: una vez la mesa está en juego, ningún RPC de unión
  // puede crear, mover ni robar asientos físicos. Si el dispositivo ya estaba
  // sentado, solo refrescamos su presencia; si es nuevo, lo tratamos como
  // espectador sin tocar room_players ni seat_kinds.
  if (room.status === "playing") {
    if (mine) {
      await supabase.from("room_players")
        .update({ name: input.name, last_seen: nowIso() })
        .eq("room_id", room.id).eq("seat", mine.seat);
      return { roomId: room.id, code: room.code, seat: mine.seat };
    }
    return { roomId: room.id, code: room.code, seat: null, isSpectator: true };
  }

  if (mine) {
    await supabase.from("room_players")
      .update({ name: input.name, last_seen: nowIso() })
      .eq("room_id", room.id).eq("seat", mine.seat);
    return { roomId: room.id, code: room.code, seat: mine.seat };
  }

  const occupied = new Set(players.map((p) => p.seat));
  const seatKinds = room.seat_kinds;
  let seat: number | null = null;
  if (input.preferredSeat != null && !occupied.has(input.preferredSeat) && seatKinds[input.preferredSeat] !== "bot") {
    seat = input.preferredSeat;
  } else {
    for (let i = 0; i < 4; i++) {
      if (occupied.has(i) || seatKinds[i] === "bot") continue;
      seat = i; break;
    }
  }
  if (seat == null) throw new Error("room_full");

  const { error } = await supabase.from("room_players").insert({
    room_id: room.id, seat, device_id: input.deviceId, name: input.name, last_seen: nowIso(),
  });
  if (error) throw new Error(error.message);
  if (seatKinds[seat] === "empty") {
    const next = [...seatKinds]; next[seat] = "human";
    await supabase.from("rooms").update({ seat_kinds: next }).eq("id", room.id);
  }
  return { roomId: room.id, code: room.code, seat };
}

const GetRoomSchema = z.object({
  code: z.string().min(6).max(6),
  deviceId: z.string().min(1).nullable().optional(),
});

async function getRoom(input: z.infer<typeof GetRoomSchema>) {
  const room = await fetchRoomByCode(input.code.toUpperCase());
  if (!room) throw new Error("room_not_found");
  const players = await fetchPlayers(room.id);
  const srv = room.match_state ? getSrv(room.match_state as MatchState) : undefined;
  const mySeat: PlayerId | null = input.deviceId
    ? ((players.find((p) => p.device_id === input.deviceId)?.seat as PlayerId | undefined) ?? null)
    : null;
  // Enmascara las manos de los demás asientos antes de devolverlo al cliente.
  if (room.match_state) {
    room.match_state = maskMatchStateForViewer(room.match_state as MatchState, mySeat) as unknown;
  }
  return { room: rowToRoomDTO(room), players: players.map((p) => playerRowToDTO(p, srv)), mySeat };
}

// RPC: devuelve la mano real (3 cartas) del asiento del `deviceId` solicitante.
const GetMyHandSchema = z.object({
  code: z.string().min(6).max(6),
  deviceId: z.string().min(1),
});
async function getMyHand(input: z.infer<typeof GetMyHandSchema>) {
  const room = await fetchRoomByCode(input.code.toUpperCase());
  if (!room) throw new Error("room_not_found");
  const seatRow = await supabase.from("room_players").select("seat")
    .eq("room_id", room.id).eq("device_id", input.deviceId).maybeSingle();
  if (seatRow.error) throw new Error(seatRow.error.message);
  if (!seatRow.data) return { hand: [] as unknown[], seat: null as PlayerId | null };
  const seat = seatRow.data.seat as PlayerId;
  if (!room.match_state) return { hand: [] as unknown[], seat };
  const hands = (room.match_state as MatchState).round?.hands ?? ({} as Record<PlayerId, unknown[]>);
  return { hand: (hands[seat] ?? []) as unknown[], seat };
}

// TTL d'inactivitat: si tots els humans d'una mesa fa més de STALE_ROOM_MS
// que no envien heartbeat (i la mesa no s'ha tocat tampoc), la considerem
// abandonada i la destruïm. Cobreix els casos en què el client no pot
// disparar `leaveRoom` (swipe-back, crash, tancament brusc...).
const STALE_ROOM_MS = 60_000;

async function cleanupStaleRooms() {
  const cutoff = new Date(Date.now() - STALE_ROOM_MS).toISOString();
  try {
    const { data: rooms } = await supabase
      .from("rooms")
      .select("id, status, updated_at, seat_kinds")
      .in("status", ["lobby", "playing"])
      .lt("updated_at", cutoff);
    if (!rooms || rooms.length === 0) return;
    const ids = (rooms as RoomRow[]).map((r) => r.id);
    const { data: prows } = await supabase
      .from("room_players")
      .select("room_id, seat, last_seen")
      .in("room_id", ids);
    const lastSeenByRoom = new Map<string, number>();
    for (const p of (prows ?? []) as PlayerRow[]) {
      const ts = new Date(p.last_seen).getTime();
      const cur = lastSeenByRoom.get(p.room_id) ?? 0;
      if (ts > cur) lastSeenByRoom.set(p.room_id, ts);
    }
    const cutoffMs = Date.now() - STALE_ROOM_MS;
    for (const r of rooms as RoomRow[]) {
      const lastSeen = lastSeenByRoom.get(r.id) ?? 0;
      // Cap heartbeat humà recent → destrueix la mesa fantasma.
      if (lastSeen < cutoffMs) {
        try {
          await destroyRoom(r.id);
          console.log("[cleanupStaleRooms] destroyed", { id: r.id, lastSeen });
        } catch (e) {
          console.warn("[cleanupStaleRooms] destroy failed", r.id, e);
        }
      }
    }
  } catch (e) {
    console.warn("[cleanupStaleRooms] failed", e);
  }
}

async function listLobbyRooms(_input: unknown) {
  // Best-effort: aprofitem cada llistat per fer neteja TTL.
  await cleanupStaleRooms();
  const { data, error } = await supabase.from("rooms").select("*")
    .in("status", ["lobby", "playing"]).order("updated_at", { ascending: false }).limit(200);
  if (error) throw new Error(error.message);

  const rooms = (data ?? []) as RoomRow[];
  if (rooms.length === 0) return { rooms: [] };
  const ids = rooms.map((r) => r.id);
  const { data: pdata, error: pErr } = await supabase.from("room_players").select("*").in("room_id", ids);
  if (pErr) throw new Error(pErr.message);
  const byRoom = new Map<string, PlayerRow[]>();
  for (const p of (pdata ?? []) as PlayerRow[]) {
    const list = byRoom.get(p.room_id) ?? [];
    list.push(p); byRoom.set(p.room_id, list);
  }
  return {
    rooms: rooms.map((r) => ({
      id: r.id, code: r.code, status: r.status,
      targetCames: r.target_cames, targetCama: r.target_cama,
      turnTimeoutSec: r.turn_timeout_sec, seatKinds: r.seat_kinds, hostDevice: r.host_device,
      players: (byRoom.get(r.id) ?? []).map((p) => ({
        seat: p.seat, name: p.name,
        deviceId: p.device_id,
        isOnline: Date.now() - new Date(p.last_seen).getTime() <= PRESENCE_ONLINE_MS,
        lastSeen: p.last_seen,
      })),
    })),
  };
}

const ListMyActiveSchema = z.object({ deviceId: z.string().min(1) });
async function listMyActiveRooms(input: z.infer<typeof ListMyActiveSchema>) {
  const { data: prows, error } = await supabase
    .from("room_players").select("room_id, seat").eq("device_id", input.deviceId);
  if (error) throw new Error(error.message);
  const ids = (prows ?? []).map((p: any) => p.room_id);
  if (ids.length === 0) return { rooms: [] };
  const { data: rrows, error: rErr } = await supabase
    .from("rooms").select("id, code, status, target_cames, updated_at")
    .in("id", ids).eq("status", "playing");
  if (rErr) throw new Error(rErr.message);
  const seatByRoom = new Map<string, number>();
  for (const p of (prows ?? []) as { room_id: string; seat: number }[]) {
    seatByRoom.set(p.room_id, p.seat);
  }
  return {
    rooms: (rrows ?? []).map((r: any) => ({
      id: r.id, code: r.code, status: r.status,
      targetCames: r.target_cames, updatedAt: r.updated_at,
      mySeat: seatByRoom.get(r.id) ?? null,
    })),
  };
}

const HeartbeatSchema = z.object({
  roomId: z.string().uuid(),
  deviceId: z.string().min(1),
});

async function heartbeat(input: z.infer<typeof HeartbeatSchema>) {
  const { error } = await supabase.from("room_players")
    .update({ last_seen: nowIso() })
    .eq("room_id", input.roomId).eq("device_id", input.deviceId);
  if (error) throw new Error(error.message);
  return { ok: true as const };
}

async function destroyRoom(roomId: string) {
  // Esborra dependents primer per evitar fallades de FK silencioses.
  await supabase.from("room_chat").delete().eq("room_id", roomId);
  await supabase.from("room_text_chat").delete().eq("room_id", roomId);
  await supabase.from("room_players").delete().eq("room_id", roomId);
  const { error } = await supabase.from("rooms").delete().eq("id", roomId);
  if (error) throw new Error(error.message);
}

async function leaveRoom(input: z.infer<typeof HeartbeatSchema>) {
  const room = await fetchRoomById(input.roomId);
  if (!room) return { ok: true as const, abandoned: false };

  const playersNow = await fetchPlayers(room.id);
  const humanPlayers = playersNow.filter(
    (p) => room.seat_kinds[p.seat] === "human",
  );
  const leaverIsSeatedHuman = humanPlayers.some(
    (p) => p.device_id === input.deviceId,
  );
  const remainingHumans = humanPlayers.filter(
    (p) => p.device_id !== input.deviceId,
  );

  // ─── Leaver Penalty ──────────────────────────────────────────
  // Si la partida està EN CURS i qui marxa estava assegut com a humà,
  // això compta com a abandonament. Sistema 100% independent del de
  // moderació per comportament/IA: usa register_leave i les seues
  // pròpies taules leaver_penalty_*.
  if (room.status === "playing" && leaverIsSeatedHuman) {
    try {
      await supabase.rpc("register_leave", {
        p_device_id: input.deviceId,
        p_room_id: room.id,
      });
    } catch (e) {
      console.warn("[leaveRoom] register_leave failed", e);
    }
  }
  // ────────────────────────────────────────────────────────────

  if (remainingHumans.length === 0) {
    console.log("[leaveRoom] destroying room — last human leaving", {
      roomId: room.id,
      code: room.code,
      seatKinds: room.seat_kinds,
      leaverDevice: input.deviceId,
    });
    await destroyRoom(room.id);
    return { ok: true as const, abandoned: true };
  }

  if (room.status === "playing") {
    if (!leaverIsSeatedHuman) {
      await supabase.from("room_players").delete()
        .eq("room_id", room.id).eq("device_id", input.deviceId);
    }
    return { ok: true as const, abandoned: false };
  }

  await supabase.from("room_players").delete()
    .eq("room_id", room.id).eq("device_id", input.deviceId);
  if (room.host_device === input.deviceId) {
    const newHost = remainingHumans[0]!;
    await supabase.from("rooms").update({ host_device: newHost.device_id }).eq("id", room.id);
  }
  return { ok: true as const, abandoned: false };
}

const SetSettingsSchema = z.object({
  roomId: z.string().uuid(),
  deviceId: z.string().min(1),
  targetCames: z.number().int().min(1).max(10).optional(),
  targetCama: z.number().int().refine((n) => n === 9 || n === 12).optional(),
  turnTimeoutSec: z.number().int().min(5).max(180).optional(),
});

async function setRoomSettings(input: z.infer<typeof SetSettingsSchema>) {
  const room = await fetchRoomById(input.roomId);
  if (!room) throw new Error("room_not_found");
  if (room.host_device !== input.deviceId) throw new Error("forbidden");
  if (room.status !== "lobby") throw new Error("not_in_lobby");
  const patch: Record<string, unknown> = {};
  if (input.targetCames != null) patch.target_cames = input.targetCames;
  if (input.targetCama != null) patch.target_cama = input.targetCama;
  if (input.turnTimeoutSec != null) patch.turn_timeout_sec = input.turnTimeoutSec;
  if (Object.keys(patch).length === 0) return { ok: true as const };
  const { error } = await supabase.from("rooms").update(patch).eq("id", room.id);
  if (error) throw new Error(error.message);
  return { ok: true as const };
}

const SetSeatKindSchema = z.object({
  roomId: z.string().uuid(),
  deviceId: z.string().min(1),
  seat: z.number().int().min(0).max(3),
  kind: z.enum(["human", "bot", "empty"]),
});

async function setSeatKind(input: z.infer<typeof SetSeatKindSchema>) {
  const room = await fetchRoomById(input.roomId);
  if (!room) throw new Error("room_not_found");
  if (room.host_device !== input.deviceId) throw new Error("forbidden");
  if (room.status !== "lobby") throw new Error("not_in_lobby");
  const players = await fetchPlayers(room.id);
  const occupied = players.find((p) => p.seat === input.seat);
  if (occupied && input.kind !== "human") throw new Error("seat_occupied_by_human");
  const next = [...room.seat_kinds]; next[input.seat] = input.kind;
  const { error } = await supabase.from("rooms").update({ seat_kinds: next }).eq("id", room.id);
  if (error) throw new Error(error.message);
  return { ok: true as const };
}

const UpdateNameSchema = z.object({
  roomId: z.string().uuid(), deviceId: z.string().min(1), name: z.string().min(1).max(40),
});
async function updatePlayerName(input: z.infer<typeof UpdateNameSchema>) {
  const { error } = await supabase.from("room_players")
    .update({ name: input.name })
    .eq("room_id", input.roomId).eq("device_id", input.deviceId);
  if (error) throw new Error(error.message);
  return { ok: true as const };
}

const AdminCloseSchema = z.object({ roomId: z.string().uuid(), password: z.string().min(1) });
async function adminCloseRoom(input: z.infer<typeof AdminCloseSchema>) {
  requireAdmin(input.password);
  await supabase.from("rooms").delete().eq("id", input.roomId);
  return { ok: true as const };
}

// Permet a l'amfitrió posar o eliminar la contrasenya de la mesa.
// password === null o "" => mesa pública.
const SetRoomPasswordSchema = z.object({
  roomId: z.string().uuid(),
  deviceId: z.string().min(1),
  password: z.string().max(64).nullable(),
});
async function setRoomPassword(input: z.infer<typeof SetRoomPasswordSchema>) {
  const room = await fetchRoomById(input.roomId);
  if (!room) throw new Error("room_not_found");
  if (room.host_device !== input.deviceId) throw new Error("forbidden");
  if (room.status !== "lobby") throw new Error("not_in_lobby");
  const trimmed = input.password ? input.password.trim() : "";
  const value = trimmed.length > 0 ? trimmed : null;
  const { error } = await supabase.from("rooms").update({ password: value }).eq("id", room.id);
  if (error) throw new Error(error.message);
  return { ok: true as const, hasPassword: value !== null };
}

// Verifica en viu si la contrasenya introduïda coincideix amb la de la mesa.
// No es guarda res al client; cada accés torna a passar per aquí.
const VerifyRoomPasswordSchema = z.object({
  code: z.string().min(1).max(16),
  password: z.string().max(64),
});
async function verifyRoomPassword(input: z.infer<typeof VerifyRoomPasswordSchema>) {
  const code = input.code.toUpperCase();
  const { data, error } = await supabase
    .from("rooms")
    .select("password")
    .eq("code", code)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) return { ok: false as const, reason: "not_found" as const };
  const stored = (data as { password?: string | null }).password ?? "";
  const expected = stored.trim();
  // Sala pública: qualsevol contrasenya és vàlida (no n'hi ha).
  if (!expected) return { ok: true as const };
  return { ok: input.password.trim() === expected };
}

const StartMatchSchema = z.object({
  roomId: z.string().uuid(), deviceId: z.string().min(1),
});

async function startMatch(input: z.infer<typeof StartMatchSchema>) {
  const room = await fetchRoomById(input.roomId);
  if (!room) throw new Error("room_not_found");
  if (room.host_device !== input.deviceId) throw new Error("forbidden");
  if (room.status !== "lobby") throw new Error("not_in_lobby");

  const players = await fetchPlayers(room.id);
  const occupied = new Set(players.map((p) => p.seat));
  for (let i = 0; i < 4; i++) {
    if (room.seat_kinds[i] === "human" && !occupied.has(i)) throw new Error("seat_empty:" + i);
    if (room.seat_kinds[i] === "empty") throw new Error("seat_empty:" + i);
  }

  // IMPORTANT: usem el motor real (`createMatch`) en comptes d'una
  // construcció ad-hoc, perquè `applyAction` / `legalActions` esperen
  // invariants estrictes (dealer derivat amb `nextPlayer`, claus de
  // `hands` tipades com `PlayerId`, etc.). Si el `match_state` no
  // compleix aquests invariants la primera acció peta i els clients
  // acaben fent `leaveRoom`, deixant la mesa buida.
  const initialMano = room.initial_mano as PlayerId;
  const firstDealer = ((initialMano + 3) % 4) as PlayerId;
  const matchState = createMatch({
    targetCama: room.target_cama,
    targetCames: room.target_cames,
    firstDealer,
  });

  await persistRoomState(room.id, matchState, {
    status: "playing",
    turn_started_at: nowIso(),
    paused_at: null,
    pending_proposal: null,
  });
  return { ok: true as const, roomId: room.id, mano: initialMano, turn: initialMano };
}


// ---------------------------------------------------------------------------
// joinAsSpectator — entrar a una mesa "en joc" sin ocupar asiento físico
// ---------------------------------------------------------------------------

const JoinSpectatorSchema = z.object({
  code: z.string().min(6).max(6),
  deviceId: z.string().min(1).optional(),
});

async function joinAsSpectator(input: z.infer<typeof JoinSpectatorSchema>) {
  const code = input.code.toUpperCase();
  const room = await fetchRoomByCode(code);
  if (!room) throw new Error("room_not_found");
  // Los espectadores NO se insertan en room_players para no ocupar
  // ninguno de los 4 asientos físicos del juego.
  return { roomId: room.id, code: room.code, seat: null, isSpectator: true };
}

// ---------------------------------------------------------------------------
// Chat
// ---------------------------------------------------------------------------

const SendChatPhraseSchema = z.object({
  roomId: z.string().uuid(), deviceId: z.string().min(1), phraseId: z.string().min(1).max(80),
});

async function findPlayerSeat(roomId: string, deviceId: string): Promise<number> {
  const { data, error } = await supabase.from("room_players").select("seat")
    .eq("room_id", roomId).eq("device_id", deviceId).maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new Error("not_in_room");
  return data.seat as number;
}

async function sendChatPhrase(input: z.infer<typeof SendChatPhraseSchema>) {
  const room = await fetchRoomById(input.roomId);
  if (!room) throw new Error("room_not_found");
  const seat = await findPlayerSeat(input.roomId, input.deviceId);
  const { error } = await supabase.from("room_chat").insert({
    room_id: input.roomId, seat, phrase_id: input.phraseId,
  });
  if (error) throw new Error(error.message);
  return { ok: true as const };
}

const SendTextMessageSchema = z.object({
  roomId: z.string().uuid(),
  deviceId: z.string().min(1),
  text: z.string().min(1).max(240),
  // Nombre para mensajes de espectador (no sentado). Se ignora si el device
  // ya tiene asiento en la sala.
  senderName: z.string().min(1).max(60).optional(),
});
/** Llama a la API gratuita de Moderación de OpenAI. Devuelve `flagged=true`
 *  si el texto cae en categorías peligrosas (hate, harassment, sexual,
 *  violence, self-harm…). Falla en silencio (permite el mensaje) si la API
 *  no responde para no romper el chat en caso de outage. */
async function moderateWithOpenAI(text: string): Promise<{ flagged: boolean; categories: string[] }> {
  const key = Deno.env.get("OPENAI_API_KEY");
  if (!key) return { flagged: false, categories: [] };
  try {
    const res = await fetch("https://api.openai.com/v1/moderations", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({ model: "omni-moderation-latest", input: text }),
    });
    if (!res.ok) return { flagged: false, categories: [] };
    const data = await res.json();
    const r = data?.results?.[0];
    if (!r) return { flagged: false, categories: [] };
    const cats: string[] = [];
    if (r.categories && typeof r.categories === "object") {
      for (const [k, v] of Object.entries(r.categories)) if (v === true) cats.push(k);
    }
    return { flagged: !!r.flagged, categories: cats };
  } catch (_e) {
    return { flagged: false, categories: [] };
  }
}

async function sendTextMessage(input: z.infer<typeof SendTextMessageSchema>) {
  const room = await fetchRoomById(input.roomId);
  if (!room) throw new Error("room_not_found");
  const text = input.text.trim();
  if (!text) throw new Error("empty_text");

  // Resuelve si el device está sentado. Si no, lo tratamos como espectador:
  // puede escribir en el chat, pero el resto de RPCs siguen exigiendo asiento.
  const { data: seated, error: pErr } = await supabase.from("room_players")
    .select("seat").eq("room_id", input.roomId).eq("device_id", input.deviceId).maybeSingle();
  if (pErr) throw new Error(pErr.message);

  const seat = seated ? (seated.seat as number) : null;
  const senderName = seat == null
    ? (input.senderName?.trim() || "Espectador").slice(0, 60)
    : null;

  // ─── ESTRATEGIA "BÚNKER DE LA IA" ──────────────────────────────
  // 1) Insertamos SIEMPRE el mensaje como visible: el chat fluye sin
  //    pausas y se censura cosméticamente en el cliente (filterProfanity).
  // 2) Por detrás, la IA evalúa el original y, si cruza la línea roja
  //    (racismo/amenazas/etc.) o si el emisor ya está en Shadow Ban
  //    (>=28 puntos en 30 días), marcamos status='blocked'. Realtime
  //    propaga el UPDATE y todos los clientes lo retiran de pantalla.
  const { data: inserted, error } = await supabase
    .from("room_text_chat")
    .insert({
      room_id: input.roomId, seat, device_id: input.deviceId, text, sender_name: senderName,
    })
    .select("id")
    .single();
  if (error) throw new Error(error.message);
  const messageId = (inserted as { id: number }).id;

  // Ejecutamos la moderación en segundo plano: no bloqueamos la
  // respuesta al cliente. El UPDATE de status llegará por Realtime.
  void evaluateAndMaybeBlock({
    roomId: input.roomId,
    deviceId: input.deviceId,
    seat,
    text,
    messageId,
  });

  return { ok: true as const, messageId };
}

// ─── CHAT DE SALA (lobby) — mateix búnker que el chat de mesa ──────────────
const SendSalaTextMessageSchema = z.object({
  salaSlug: z.string().min(1).max(60),
  deviceId: z.string().min(1),
  name: z.string().min(1).max(40),
  text: z.string().min(1).max(240),
});

async function sendSalaTextMessage(input: z.infer<typeof SendSalaTextMessageSchema>) {
  const text = input.text.trim();
  if (!text) throw new Error("empty_text");
  const name = input.name.trim().slice(0, 40) || "Jugador";

  // Inserta sempre el missatge (mateixa estratègia "búnker"): si la IA
  // detecta línia roja l'amaga després via status='blocked' (requereix
  // que la migració v5 hagi afegit la columna a `sala_chat`).
  const { data: inserted, error } = await supabase
    .from("sala_chat")
    .insert({
      sala_slug: input.salaSlug,
      device_id: input.deviceId,
      name,
      text,
    })
    .select("id")
    .single();
  if (error) throw new Error(error.message);
  const messageId = (inserted as { id: number }).id;

  void evaluateAndMaybeBlockSala({
    salaSlug: input.salaSlug,
    deviceId: input.deviceId,
    text,
    messageId,
  });

  return { ok: true as const, messageId };
}

async function evaluateAndMaybeBlockSala(args: {
  salaSlug: string;
  deviceId: string;
  text: string;
  messageId: number;
}): Promise<void> {
  try {
    const [local, mod] = await Promise.all([
      detectLocalProfanity(args.text),
      moderateWithOpenAI(args.text),
    ]);

    // Els flags del lobby s'emmagatzemen amb room_id=NULL i target_seat=NULL.
    // Alimenten EL MATEIX sistema de punts/Shadow Ban que el chat de mesa.
    await persistModerationFlags({
      source: "sala",
      roomId: null,
      seat: null,
      deviceId: args.deviceId,
      text: args.text,
      messageId: args.messageId,
      local,
      mod,
    });

    const crossesRedLine =
      mod.flagged && mod.categories.some((c) => RED_LINE_CATEGORIES.has(c));

    let inShadowBan = false;
    if (!crossesRedLine) {
      const sinceIso = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
      const { data: rows } = await supabase
        .from("room_chat_flags")
        .select("weight")
        .eq("target_device_id", args.deviceId)
        .eq("counted", true)
        .gte("created_at", sinceIso);
      const total = (rows ?? []).reduce(
        (acc: number, r: { weight: number | null }) => acc + (r.weight ?? 0),
        0,
      );
      inShadowBan = total >= SHADOW_BAN_POINTS;
    }

    if (crossesRedLine || inShadowBan) {
      const { error: blkErr } = await (supabase as any)
        .from("sala_chat")
        .update({ status: "blocked" })
        .eq("id", args.messageId);
      if (blkErr) console.error("[moderation] sala block update failed:", JSON.stringify(blkErr));
    }
  } catch (e) {
    console.error("[moderation] evaluate sala error:", (e as Error)?.message, (e as Error)?.stack);
  }
}

/** Categorías de OpenAI Moderation consideradas "línea roja" → bloqueo
 *  inmediato sin pasar por el sistema de puntos. */
const RED_LINE_CATEGORIES = new Set<string>([
  "hate",
  "hate/threatening",
  "harassment/threatening",
  "sexual/minors",
  "violence",
  "violence/graphic",
  "self-harm",
  "self-harm/intent",
  "self-harm/instructions",
]);

const SHADOW_BAN_POINTS = 28;

// ─── DETECCIÓN LOCAL DE LENGUAJE OFENSIVO (espejo de profanityFilter.ts) ──
// Mismas listas que el cliente para que el "búnker" siempre genere un flag
// en `room_chat_flags` aunque OpenAI no esté configurado o esté caído.
const MILD_INTERJECTIONS = new Set<string>([
  "joder", "jodete",
  "mierda", "mierdas",
  "coño", "cono",
  "merda", "merdes",
  "collons", "carall",
  "punyeta", "punyetes",
]);

const DEFAULT_BAD_WORDS_FALLBACK: string[] = [
  "puta", "putas", "puto", "putos",
  "gilipollas", "gilipuertas",
  "cabron", "cabrones", "cabrona",
  "hijoputa", "hijodeputa", "hdp",
  "mierda", "mierdas",
  "joder", "jodete",
  "coño", "cono",
  "polla", "pollas",
  "follar", "follate",
  "maricon", "maricones",
  "zorra", "zorras",
  "imbecil", "imbeciles",
  "idiota", "idiotas",
  "subnormal", "subnormales",
  "estupido", "estupida",
  "tonto", "tonta",
  "capullo", "capullos",
  "panoli",
  "retrasado", "retrasada",
  "fillputa", "fillsdeputa", "fillputes",
  "cabro", "cabrons",
  "merda", "merdes",
  "collons",
  "punyeta", "punyetes",
  "carall",
  "imbecils",
  "estupit",
  "ximple", "ximplos",
  "tarat", "tarats",
  "burro", "burros",
  "amaricat",
];

function stripDiacritics(s: string): string {
  return s.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

let _blacklistCache: { words: string[]; loadedAt: number } | null = null;
const BLACKLIST_TTL_MS = 5 * 60 * 1000;

async function getBlacklistWords(): Promise<string[]> {
  const now = Date.now();
  if (_blacklistCache && now - _blacklistCache.loadedAt < BLACKLIST_TTL_MS) {
    return _blacklistCache.words;
  }
  try {
    const { data } = await supabase.from("blacklist").select("word");
    const words = (data ?? [])
      .map((r: { word: string | null }) => (r?.word ?? "").trim())
      .filter((w: string) => w.length > 0);
    // Sempre UNIM blacklist DB + fallback hardcoded. Si la taula està buida
    // o no conté les paraules típiques, el fallback continua actiu.
    const seen = new Set<string>();
    const merged: string[] = [];
    for (const w of [...words, ...DEFAULT_BAD_WORDS_FALLBACK]) {
      const k = stripDiacritics(w.toLowerCase());
      if (k && !seen.has(k)) { seen.add(k); merged.push(w); }
    }
    _blacklistCache = { words: merged, loadedAt: now };
    return merged;
  } catch (e) {
    console.warn("[moderation] blacklist load failed, using fallback:", (e as Error)?.message);
    _blacklistCache = { words: DEFAULT_BAD_WORDS_FALLBACK, loadedAt: now };
    return DEFAULT_BAD_WORDS_FALLBACK;
  }
}

function buildWordPattern(word: string): RegExp {
  const norm = stripDiacritics(word.toLowerCase());
  const body = Array.from(norm).map((ch) => {
    if (!/[a-z]/.test(ch)) return ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return `${ch}+`;
  }).join("");
  return new RegExp(`(^|[^\\p{L}\\p{N}])(${body})(?=$|[^\\p{L}\\p{N}])`, "iu");
}

/** Detecta si el texto contiene palabras de la lista negra. Devuelve la
 *  severidad más alta encontrada: "severe" (insulto) o "mild" (interjección)
 *  o null si no hay coincidencias. */
async function detectLocalProfanity(
  text: string,
): Promise<{ severity: "severe" | "mild"; hit: string } | null> {
  if (!text) return null;
  const words = await getBlacklistWords();
  let mildHit: string | null = null;
  for (const raw of words) {
    const key = stripDiacritics(raw.trim().toLowerCase());
    if (!key) continue;
    if (buildWordPattern(key).test(text)) {
      if (!MILD_INTERJECTIONS.has(key)) {
        return { severity: "severe", hit: key };
      }
      if (!mildHit) mildHit = key;
    }
  }
  return mildHit ? { severity: "mild", hit: mildHit } : null;
}

async function evaluateAndMaybeBlock(args: {
  roomId: string;
  deviceId: string;
  seat: number | null;
  text: string;
  messageId: number;
}): Promise<void> {
  try {
    // 1) Detección LOCAL (blacklist DB + fallback). Se ejecuta SIEMPRE
    //    para que el sistema de puntos funcione aunque OpenAI no esté.
    // Local + OpenAI en paralelo (no nos hace falta secuencial: OpenAI no
    // bloquea al canal local).
    const [local, mod] = await Promise.all([
      detectLocalProfanity(args.text),
      moderateWithOpenAI(args.text),
    ]);
    await persistModerationFlags({
      source: "room",
      roomId: args.roomId,
      seat: args.seat,
      deviceId: args.deviceId,
      text: args.text,
      messageId: args.messageId,
      local,
      mod,
    });

    // Decisión de bloqueo:
    //   (a) línea roja directa, o
    //   (b) shadow-ban activo (>=28 puntos / 30 días en este device).
    const crossesRedLine =
      mod.flagged && mod.categories.some((c) => RED_LINE_CATEGORIES.has(c));

    let inShadowBan = false;
    if (!crossesRedLine) {
      const sinceIso = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
      const { data: rows } = await supabase
        .from("room_chat_flags")
        .select("weight")
        .eq("target_device_id", args.deviceId)
        .eq("counted", true)
        .gte("created_at", sinceIso);
      const total = (rows ?? []).reduce(
        (acc: number, r: { weight: number | null }) => acc + (r.weight ?? 0),
        0,
      );
      inShadowBan = total >= SHADOW_BAN_POINTS;
    }

    if (crossesRedLine || inShadowBan) {
      const { error: blkErr } = await supabase
        .from("room_text_chat")
        .update({ status: "blocked" })
        .eq("id", args.messageId);
      if (blkErr) console.error("[moderation] room block update failed:", JSON.stringify(blkErr));
    }
  } catch (e) {
    // Falla en silencio: el mensaje queda visible (mejor falso negativo
    // puntual que romper el chat por un outage del moderador).
    console.error("[moderation] evaluate error:", (e as Error)?.message, (e as Error)?.stack);
  }
}

/**
 * Inserta los flags en `room_chat_flags`. Reutilizado por chat de mesa y
 * chat de sala (lobby). Para la sala no hay seat ni room_id; usamos NULL
 * (requiere migración v5 que relaja las NOT NULL).
 */
async function persistModerationFlags(args: {
  source: "room" | "sala";
  roomId: string | null;
  seat: number | null;
  deviceId: string;
  text: string;
  messageId: number | null;
  local: { severity: "severe" | "mild"; hit: string } | null;
  mod: { flagged: boolean; categories: string[] };
}): Promise<void> {
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

  // Resol el codi de sala (ABCD12) per desar-lo al flag, així sobreviu
  // a esborrats/canvis posteriors a la taula `rooms`.
  let roomCode: string | null = null;
  if (args.roomId) {
    try {
      const { data } = await supabase
        .from("rooms")
        .select("code")
        .eq("id", args.roomId)
        .maybeSingle();
      roomCode = (data as { code: string | null } | null)?.code ?? null;
    } catch { /* noop */ }
  }

  if (args.local) {
    const reason = args.local.severity === "severe" ? "llenguatge" : "antiesportiu";
    const row: Record<string, unknown> = {
      room_id: args.roomId,
      room_code: roomCode,
      target_seat: args.seat,
      target_device_id: args.deviceId,
      reporter_device_id: "local-blacklist",
      message_id: args.messageId,
      message_text: args.text.slice(0, 500),
      reason,
      expires_at: expiresAt,
    };
    const { error } = await supabase.from("room_chat_flags").insert(row);
    if (error) {
      console.error(
        `[moderation] local flag insert failed (source=${args.source}, hit=${args.local.hit}):`,
        JSON.stringify(error),
        "row=", JSON.stringify(row),
      );
    } else {
      console.log(
        `[moderation] local flag stored (source=${args.source}, sev=${args.local.severity}, hit=${args.local.hit}, dev=${args.deviceId})`,
      );
    }
  }

  if (args.mod.flagged) {
    const row: Record<string, unknown> = {
      room_id: args.roomId,
      room_code: roomCode,
      target_seat: args.seat,
      target_device_id: args.deviceId,
      reporter_device_id: "openai-moderation",
      message_id: args.messageId,
      message_text: args.text.slice(0, 500),
      reason: "llenguatge",
      expires_at: expiresAt,
    };
    const { error } = await supabase.from("room_chat_flags").insert(row);
    if (error) {
      console.error(
        `[moderation] openai flag insert failed (source=${args.source}, cats=${args.mod.categories.join(",")}):`,
        JSON.stringify(error),
        "row=", JSON.stringify(row),
      );
    } else {
      console.log(
        `[moderation] openai flag stored (source=${args.source}, cats=${args.mod.categories.join(",")}, dev=${args.deviceId})`,
      );
    }
  }
}

// ===========================================================================
// MOTOR DE BOTS — humanizado (3 ticks por consulta + freno 1ª baza)
// ===========================================================================

/**
 * Replica `currentActor` del frontend. Prioriza pendientes de envit/truc
 * por equipo, y cae al `round.turn` para la fase de play.
 */
function currentActor(state: MatchState): PlayerId | null {
  const r = state.round;
  if (r.phase === "game-end" || r.phase === "round-end") return null;
  for (const p of [0, 1, 2, 3] as PlayerId[]) {
    if (legalActions(state, p).length === 0) continue;
    const team = p % 2 === 0 ? "nos" : "ells";
    if (
      (r.envitState.kind === "pending" && r.envitState.awaitingTeam === team) ||
      (r.trucState.kind === "pending" && r.trucState.awaitingTeam === team) ||
      r.turn === p
    ) {
      return p;
    }
  }
  return null;
}

/**
 * Side-channel del servidor en `match_state._srv`. Contiene:
 *   - nextBotAt: timestamp ms hasta el cual NO se debe actuar (espera humana)
 *   - consult: estado de la consulta bot↔bot en curso (3 fases)
 *   - waitKey: clave del freno de 7s ya consumido (para no repetirlo)
 */
type ConsultPhase = "question-shown" | "answer-shown";

interface ServerConsult {
  bot: PlayerId;
  partner: PlayerId;
  question: string;
  answer: string;
  advice: PartnerAdvice;
  phase: ConsultPhase;
  key: string;
}

interface ServerSide {
  nextBotAt?: number;
  consult?: ServerConsult;
  waitKey?: string;
  /** ISO timestamp de quan el servidor va detectar la primera caiguda de
   *  presència per a cada seient humà. null/absent = considerat online. */
  disconnectedSince?: Partial<Record<PlayerId, string | null>>;
  /** Compte de turns consecutius perduts per timeout per seient. */
  afkStrikes?: Partial<Record<PlayerId, number>>;
  /** Seients que han caigut en piloto automàtic (3+ strikes). */
  afkAutoPilot?: Partial<Record<PlayerId, boolean>>;
  /** Seients humans substituïts definitivament per bot. */
  botifiedSeats?: PlayerId[];
}

function getSrv(state: MatchState): ServerSide {
  return ((state as any)._srv as ServerSide | undefined) ?? {};
}
function withSrv(state: MatchState, srv: ServerSide | null): MatchState {
  const copy: any = { ...state };
  // Persistim sempre els camps de control de desconnexió/AFK encara que
  // qui crida només passi nextBotAt/consult/waitKey.
  const prev = getSrv(state);
  const persistent: ServerSide = {};
  if (prev.disconnectedSince) persistent.disconnectedSince = prev.disconnectedSince;
  if (prev.afkStrikes) persistent.afkStrikes = prev.afkStrikes;
  if (prev.afkAutoPilot) persistent.afkAutoPilot = prev.afkAutoPilot;
  if (prev.botifiedSeats) persistent.botifiedSeats = prev.botifiedSeats;
  const merged: ServerSide | null = srv ? { ...persistent, ...srv } : (Object.keys(persistent).length ? persistent : null);
  if (merged && Object.keys(merged).length > 0) copy._srv = merged;
  else delete copy._srv;
  return copy as MatchState;
}

function actorKey(state: MatchState, bot: PlayerId): string {
  const r = state.round;
  const trickIdx = r.tricks.length - 1;
  const playedInTrick = r.tricks[trickIdx]?.cards.length ?? 0;
  return `${state.history.length}-${state.cames}-${r.mano}-${trickIdx}-${playedInTrick}-${bot}`;
}

/**
 * ¿Es este bot el "segundo de la pareja" en la 1ª baza, sin envit en
 * curso ni resuelto? En ese caso debe esperar 7–10 s por si
 * su compañero le pide envit.
 */
function shouldApplyFirstTrickWait(state: MatchState, actor: PlayerId): boolean {
  const r = state.round;
  if (r.phase !== "playing" && r.phase !== "envit") return false;
  if (r.tricks.length !== 1) return false;
  if (r.envitState.kind !== "none" || r.envitResolved) return false;
  const playedInTrick = r.tricks[0]?.cards.length ?? 0;
  // "Último de la pareja" = el compañero ya tiró carta en esta baza.
  const partner = partnerOf(actor);
  const partnerPlayed = (r.tricks[0]?.cards ?? []).some(
    (tc: any) => tc.player === partner,
  );
  if (!partnerPlayed) return false;
  // Asegurar que el bot todavía no ha tirado en esta baza.
  const meAlreadyPlayed = (r.tricks[0]?.cards ?? []).some(
    (tc: any) => tc.player === actor,
  );
  if (meAlreadyPlayed) return false;
  // Sólo cuando el bot es 2º o 4º en orden de tirada (último de pareja).
  // Heurística: si su compañero ya jugó y él aún no, es último de pareja.
  return playedInTrick >= 1;
}

interface BotStepResult {
  state: MatchState;
  chats: { seat: PlayerId; phraseId: string }[];
  changed: boolean;
  /** Cuándo se debería volver a llamar (ms desde ahora). */
  nextInMs?: number;
}

/**
 * Aplica COMO MUCHO un paso humanizado del motor de bots.
 * Reglas:
 *  - phase "game-end" => nada.
 *  - phase "round-end" => esperar ROUND_END_DELAY_MS y arrancar siguiente.
 *  - Si nextBotAt > now => esperar (no actuar).
 *  - Actor humano => nada.
 *  - Consulta en curso:
 *      · phase "question-shown": ahora se emite la RESPUESTA y
 *        se programa la DECISIÓN para dentro de CONSULT_DECIDE_DELAY_MS.
 *      · phase "answer-shown": se aplica la decisión cacheada y se limpia.
 *  - Actor bot sin consulta:
 *      · Si procede consulta: emite PREGUNTA y programa la respuesta.
 *      · Si es 2º de pareja en 1ª baza sin envit: programa espera 7s.
 *      · Si no: decisión directa tras BOT_DELAY_MS.
 */
function stepOneBotAction(state: MatchState, seatKinds: SeatKind[]): BotStepResult {
  if (state.round.phase === "game-end") {
    return { state, chats: [], changed: false };
  }
  const srv = { ...getSrv(state) };
  const t = nowMs();

  if (state.round.phase === "round-end") {
    if (srv.nextBotAt && srv.nextBotAt > t) {
      return { state, chats: [], changed: false, nextInMs: srv.nextBotAt - t };
    }
    if (!srv.nextBotAt) {
      // Primera vez que vemos round-end: programar arranque.
      const next = withSrv(state, { ...srv, nextBotAt: t + ROUND_END_DELAY_MS });
      return { state: next, chats: [], changed: true, nextInMs: ROUND_END_DELAY_MS };
    }
    const nextState = startNextRound(state);
    return {
      state: withSrv(nextState, { nextBotAt: nowMs() + BOT_DELAY_MS }),
      chats: [],
      changed: true,
      nextInMs: BOT_DELAY_MS,
    };
  }

  // Freno de humanización
  if (srv.nextBotAt && srv.nextBotAt > t) {
    return { state, chats: [], changed: false, nextInMs: srv.nextBotAt - t };
  }

  const actor = currentActor(state);
  if (actor == null) return { state, chats: [], changed: false };
  const isBotActor = seatKinds[actor] === "bot" || !!srv.afkAutoPilot?.[actor];
  if (!isBotActor) {
    // Es humano activo: limpiamos cualquier consulta cacheada y esperas.
    if (srv.consult || srv.nextBotAt) {
      return { state: withSrv(state, {}), chats: [], changed: true };
    }
    return { state, chats: [], changed: false };
  }

  // --- CONSULTA EN CURSO ---
  if (srv.consult) {
    const c = srv.consult;
    const stillValid =
      c.bot === actor && c.key === actorKey(state, actor);
    if (!stillValid) {
      // Estado avanzó: descartar consulta y continuar.
      srv.consult = undefined;
    } else if (c.phase === "question-shown") {
      // TICK 2: emitir respuesta y programar decisión.
      const nextSrv: ServerSide = {
        ...srv,
        consult: { ...c, phase: "answer-shown" },
        nextBotAt: t + CONSULT_DECIDE_DELAY_MS,
      };
      return {
        state: withSrv(state, nextSrv),
        chats: [{ seat: c.partner, phraseId: c.answer }],
        changed: true,
        nextInMs: CONSULT_DECIDE_DELAY_MS,
      };
    } else if (c.phase === "answer-shown") {
      // TICK 3: aplicar decisión con el advice cacheado.
      const decision = botDecide(state, actor, c.advice);
      if (!decision) {
        return {
          state: withSrv(state, { nextBotAt: t + BOT_DELAY_MS }),
          chats: [],
          changed: true,
          nextInMs: BOT_DELAY_MS,
        };
      }
      let next = applyAction(state, actor, decision as Action);
      next = withSrv(next, { nextBotAt: nowMs() + BOT_DELAY_MS });
      return { state: next, chats: [], changed: true, nextInMs: BOT_DELAY_MS };
    }
  }

  // --- Bloqueo prioritario: antes de CUALQUIER consulta o decisión ---
  // El watchdog puede llamar repetidamente, pero nextBotAt mantiene el
  // bloqueo persistido en servidor hasta que transcurran los 7–10 s.
  if (shouldApplyFirstTrickWait(state, actor)) {
    const wKey = actorKey(state, actor);
    if (srv.waitKey !== wKey) {
      const waitMs = randomSecondPlayerWaitMs();
      const next = withSrv(state, {
        ...srv,
        nextBotAt: t + waitMs,
        waitKey: wKey,
      });
      return {
        state: next,
        chats: [],
        changed: true,
        nextInMs: waitMs,
      };
    }
  }

  // --- SIN CONSULTA: ¿procede iniciarla? ---
  const r = state.round;
  const partner = partnerOf(actor);
  const consultable =
    r.phase === "playing" &&
    r.turn === actor &&
    r.trucState.kind !== "pending" &&
    r.envitState.kind !== "pending" &&
    seatKinds[partner] === "bot";

  if (consultable && shouldConsultPartner(state, actor)) {
    const question = pickQuestion(state, actor);
    if (question) {
      const answer = partnerAnswerFor(state, partner, question);
      const advice = adviceFromAnswer(answer, question);
      const mark: ServerConsult = {
        bot: actor,
        partner,
        question,
        answer,
        advice,
        phase: "question-shown",
        key: actorKey(state, actor),
      };
      // TICK 1: emitir pregunta y programar respuesta.
      const next = withSrv(state, {
        consult: mark,
        nextBotAt: t + CONSULT_ANSWER_DELAY_MS,
        waitKey: srv.waitKey,
      });
      return {
        state: next,
        chats: [{ seat: actor, phraseId: question }],
        changed: true,
        nextInMs: CONSULT_ANSWER_DELAY_MS,
      };
    }
  }

  // --- Decisión directa ---
  const decision = botDecide(state, actor);
  if (!decision) return { state, chats: [], changed: false };
  const applied = applyAction(state, actor, decision as Action);
  const next = withSrv(applied, { nextBotAt: nowMs() + BOT_DELAY_MS });
  return { state: next, chats: [], changed: true, nextInMs: BOT_DELAY_MS };
}

async function persistBotStep(room: RoomRow, result: BotStepResult): Promise<void> {
  if (!result.changed) return;
  if (result.chats.length > 0) {
    const rows = result.chats.map((c) => ({
      room_id: room.id,
      seat: c.seat,
      phrase_id: c.phraseId,
    }));
    const { error: chatErr } = await supabase.from("room_chat").insert(rows);
    if (chatErr) throw new Error(chatErr.message);
  }
  const patch: Record<string, unknown> = { turn_started_at: nowIso() };
  if (result.state.round.phase === "game-end") patch.status = "finished";
  await persistRoomState(room.id, result.state, patch);
}

const SubmitActionSchema = z.object({
  roomId: z.string().uuid(),
  deviceId: z.string().min(1),
  action: z.object({
    type: z.enum(["play-card", "shout"]),
    cardId: z.string().optional(),
    covered: z.boolean().optional(),
    what: z.string().optional(),
  }).passthrough(),
});

async function submitAction(input: z.infer<typeof SubmitActionSchema>) {
  const room = await fetchRoomById(input.roomId);
  if (!room) throw new Error("room_not_found");
  if (room.status !== "playing") throw new Error("not_playing");
  if (!room.match_state) throw new Error("no_match_state");
  if (room.paused_at) throw new Error("paused");

  const seat = await findPlayerSeat(input.roomId, input.deviceId);
  const player = seat as PlayerId;

  let state = room.match_state as MatchState;
  // Nota: NO bloqueem per `currentActor` perquè la regla d'envit/truc
  // permet als dos membres de la pareja respondre de forma independent
  // i simultània (un "Vull" tanca; cal el "No vull" dels dos per rebutjar).
  // La validació real es fa via `legalActions(state, player)` més avall.
  if (legalActions(state, player).length === 0) {
    return { ok: false, stale: true } as const;
  }

  const legals = legalActions(state, player);
  const action = input.action as unknown as Action;
  const matches = legals.some((a) => {
    if (a.type !== action.type) return false;
    if (a.type === "play-card") return (a as any).cardId === (action as any).cardId;
    return (a as any).what === (action as any).what;
  });
  if (!matches) throw new Error("illegal_action");

  state = applyAction(state, player, action);
  // Acción humana: invalida consulta cacheada Y la espera de 7s
  // (porque podría haber dicho "envida" justo ahora). També reseteja
  // qualsevol falta d'inactivitat acumulada al seient.
  const prevSrv = getSrv(state);
  const newStrikes = { ...(prevSrv.afkStrikes ?? {}) };
  const newAuto = { ...(prevSrv.afkAutoPilot ?? {}) };
  const newDisc = { ...(prevSrv.disconnectedSince ?? {}) };
  if (newStrikes[player]) newStrikes[player] = 0;
  if (newAuto[player]) newAuto[player] = false;
  if (newDisc[player]) newDisc[player] = null;
  state = withSrv(state, {
    ...prevSrv,
    consult: undefined,
    waitKey: undefined,
    nextBotAt: nowMs() + BOT_DELAY_MS,
    afkStrikes: newStrikes,
    afkAutoPilot: newAuto,
    disconnectedSince: newDisc,
  });

  const patch: Record<string, unknown> = { turn_started_at: nowIso() };
  if (state.round.phase === "game-end") patch.status = "finished";

  await persistRoomState(room.id, state, patch);
  return { ok: true as const };
}

/**
 * Sincronitza l'estat de desconnexió de cada seient humà segons el seu
 * `last_seen`. Marca/desmarca `disconnectedSince` i, si supera 5 min sense
 * presència, substitueix el jugador per un bot DEFINITIVAMENT.
 */
async function syncDisconnectionAndBotify(
  room: RoomRow,
  players: PlayerRow[],
): Promise<{ state: MatchState; seatKinds: SeatKind[]; changed: boolean }> {
  let state = room.match_state as MatchState;
  const srv = { ...getSrv(state) };
  const disc: Partial<Record<PlayerId, string | null>> = { ...(srv.disconnectedSince ?? {}) };
  const strikes: Partial<Record<PlayerId, number>> = { ...(srv.afkStrikes ?? {}) };
  const autoPilot: Partial<Record<PlayerId, boolean>> = { ...(srv.afkAutoPilot ?? {}) };
  const botified: PlayerId[] = [...(srv.botifiedSeats ?? [])];
  const seatKinds = [...room.seat_kinds];
  let changed = false;
  let kindsChanged = false;
  const now = Date.now();

  for (const p of players) {
    const seat = p.seat as PlayerId;
    if (seatKinds[seat] !== "human") continue;
    if (botified.includes(seat)) continue;
    const ageMs = now - new Date(p.last_seen).getTime();
    const isOnline = ageMs <= PRESENCE_ONLINE_MS;
    const prevDisc = disc[seat] ?? null;

    if (isOnline) {
      if (prevDisc) {
        disc[seat] = null;
        // Recupera el control: reseteja faltes i piloto automàtic.
        if (strikes[seat]) strikes[seat] = 0;
        if (autoPilot[seat]) autoPilot[seat] = false;
        changed = true;
      }
    } else {
      if (!prevDisc) {
        disc[seat] = new Date(now - ageMs + PRESENCE_ONLINE_MS).toISOString();
        changed = true;
      } else {
        const offSince = new Date(prevDisc).getTime();
        if (now - offSince >= DISCONNECT_TO_BOT_MS) {
          // BOTIFICACIÓ DEFINITIVA
          seatKinds[seat] = "bot";
          kindsChanged = true;
          botified.push(seat);
          disc[seat] = null;
          strikes[seat] = 0;
          autoPilot[seat] = false;
          // Esborra la fila del jugador per alliberar el dispositiu (futures
          // reconnexions entraran com a espectador).
          await supabase.from("room_players").delete()
            .eq("room_id", room.id).eq("seat", seat);
          changed = true;
        }
      }
    }
  }

  if (changed) {
    state = withSrv(state, {
      ...getSrv(state),
      disconnectedSince: disc,
      afkStrikes: strikes,
      afkAutoPilot: autoPilot,
      botifiedSeats: botified,
    });
  }
  if (kindsChanged) {
    await supabase.from("rooms").update({ seat_kinds: seatKinds }).eq("id", room.id);
  }
  return { state, seatKinds, changed: changed || kindsChanged };
}

/**
 * Si l'actor és humà i ha esgotat el temps del seu torn, força una acció
 * automàtica (com si fos bot) i acumula una falta d'inactivitat. Si en
 * acumula AFK_AUTOPILOT_THRESHOLD, el seient passa a piloto automàtic.
 */
function enforceTurnTimeout(
  state: MatchState,
  seatKinds: SeatKind[],
  turnStartedAt: string | null,
  turnTimeoutSec: number,
): { state: MatchState; changed: boolean } {
  if (!turnStartedAt) return { state, changed: false };
  if (state.round.phase !== "playing" && state.round.phase !== "round-end") return { state, changed: false };
  const actor = currentActor(state);
  if (actor == null) return { state, changed: false };
  if (seatKinds[actor] !== "human") return { state, changed: false };
  const srv = getSrv(state);
  if (srv.afkAutoPilot?.[actor]) return { state, changed: false }; // ja el porta el motor de bots
  const startedMs = new Date(turnStartedAt).getTime();
  if (Date.now() - startedMs < turnTimeoutSec * 1000) return { state, changed: false };
  // Timeout: tirem com a bot.
  const decision = botDecide(state, actor);
  if (!decision) return { state, changed: false };
  const newStrikes = { ...(srv.afkStrikes ?? {}) };
  const cur = (newStrikes[actor] ?? 0) + 1;
  newStrikes[actor] = cur;
  const newAutoPilot = { ...(srv.afkAutoPilot ?? {}) };
  if (cur >= AFK_AUTOPILOT_THRESHOLD) newAutoPilot[actor] = true;
  let next = applyAction(state, actor, decision as Action);
  next = withSrv(next, {
    ...getSrv(next),
    afkStrikes: newStrikes,
    afkAutoPilot: newAutoPilot,
    nextBotAt: Date.now() + BOT_DELAY_MS,
  });
  return { state: next, changed: true };
}

async function advanceBots(input: z.infer<typeof HeartbeatSchema>) {
  const room = await fetchRoomById(input.roomId);
  if (!room) throw new Error("room_not_found");
  if (room.status !== "playing") return { ok: true as const };
  if (!room.match_state) return { ok: true as const };
  if (room.paused_at) return { ok: true as const };

  const players = await fetchPlayers(room.id);
  // 1) Sincronitza desconnexió i potencialment botifica.
  const sync = await syncDisconnectionAndBotify(room, players);
  let state = sync.state;
  const seatKinds = sync.seatKinds;
  let mutated = sync.changed;

  // 2) Aplica timeout d'AFK si toca (força tirada + suma falta).
  const afk = enforceTurnTimeout(state, seatKinds, room.turn_started_at, room.turn_timeout_sec);
  if (afk.changed) {
    state = afk.state;
    mutated = true;
  }

  // 3) Pas de bot habitual (inclou humans en piloto automàtic).
  const result = stepOneBotAction(state, seatKinds);
  if (result.changed) {
    await persistBotStep({ ...room, seat_kinds: seatKinds, match_state: state }, result);
  } else if (mutated) {
    const patch: Record<string, unknown> = {};
    if (afk.changed) patch.turn_started_at = nowIso();
    await persistRoomState(room.id, state, patch);
  }
  return { ok: true as const };
}

const MarkActivitySchema = z.object({
  roomId: z.string().uuid(),
  deviceId: z.string().min(1),
});

async function markActivity(input: z.infer<typeof MarkActivitySchema>) {
  // Refresca presència.
  await supabase.from("room_players")
    .update({ last_seen: nowIso() })
    .eq("room_id", input.roomId).eq("device_id", input.deviceId);
  const room = await fetchRoomById(input.roomId);
  if (!room || !room.match_state) return { ok: true as const };
  const players = await fetchPlayers(room.id);
  const me = players.find((p) => p.device_id === input.deviceId);
  if (!me) return { ok: true as const };
  const seat = me.seat as PlayerId;
  const state = room.match_state as MatchState;
  const srv = getSrv(state);
  const strikes = { ...(srv.afkStrikes ?? {}) };
  const autoPilot = { ...(srv.afkAutoPilot ?? {}) };
  const disc = { ...(srv.disconnectedSince ?? {}) };
  let changed = false;
  if (strikes[seat]) { strikes[seat] = 0; changed = true; }
  if (autoPilot[seat]) { autoPilot[seat] = false; changed = true; }
  if (disc[seat]) { disc[seat] = null; changed = true; }
  if (changed) {
    const next = withSrv(state, {
      ...srv,
      afkStrikes: strikes,
      afkAutoPilot: autoPilot,
      disconnectedSince: disc,
    });
    await persistRoomState(room.id, next);
  }
  return { ok: true as const };
}

// ===========================================================================
// VOTACIÓN DEMOCRÁTICA — pause / resume / restart
// ===========================================================================

type ProposalKind = "pause" | "restart" | "resume";
type VoteValue = "accepted" | "rejected" | "pending";

interface PendingProposal {
  kind: ProposalKind;
  proposerSeat: PlayerId;
  proposerName: string;
  createdAt: string;
  expiresAt: string;
  votes: Record<string, VoteValue>; // key = deviceId
}

async function humanDevicesFor(room: RoomRow): Promise<{ deviceId: string; seat: PlayerId; name: string }[]> {
  const players = await fetchPlayers(room.id);
  return players
    .filter((p) => room.seat_kinds[p.seat] === "human")
    .map((p) => ({ deviceId: p.device_id, seat: p.seat as PlayerId, name: p.name }));
}

function proposalExpired(prop: PendingProposal): boolean {
  return new Date(prop.expiresAt).getTime() < nowMs();
}

function proposalResolved(prop: PendingProposal): "executed" | "rejected" | "pending" {
  const votes = Object.values(prop.votes);
  if (votes.some((v) => v === "rejected")) return "rejected";
  if (votes.every((v) => v === "accepted")) return "executed";
  return "pending";
}

async function executeProposal(room: RoomRow, kind: ProposalKind): Promise<void> {
  if (kind === "pause") {
    await supabase.from("rooms").update({
      paused_at: nowIso(),
      pending_proposal: null,
    }).eq("id", room.id);
  } else if (kind === "resume") {
    await supabase.from("rooms").update({
      paused_at: null,
      pending_proposal: null,
      turn_started_at: nowIso(),
    }).eq("id", room.id);
  } else if (kind === "restart") {
    const initialMano = room.initial_mano as PlayerId;
    const fresh = createMatch({
      targetCama: room.target_cama,
      targetCames: room.target_cames,
      firstDealer: ((initialMano + 3) % 4) as PlayerId,
    });
    await persistRoomState(room.id, fresh, {
      paused_at: null,
      pending_proposal: null,
      turn_started_at: nowIso(),
      status: "playing",
    });
  }
}

const SetPausedSchema = z.object({
  roomId: z.string().uuid(),
  deviceId: z.string().min(1),
  paused: z.boolean(),
});

async function setPaused(input: z.infer<typeof SetPausedSchema>) {
  const room = await fetchRoomById(input.roomId);
  if (!room) throw new Error("room_not_found");
  // En modo solo bots+1 humano la pausa es inmediata.
  const humans = await humanDevicesFor(room);
  if (humans.length <= 1) {
    await supabase.from("rooms").update({
      paused_at: input.paused ? nowIso() : null,
      turn_started_at: input.paused ? room.turn_started_at : nowIso(),
    }).eq("id", room.id);
    return { ok: true as const, paused: input.paused };
  }
  // Con varios humanos requiere proposeAction.
  throw new Error("requires_proposal");
}

const ProposeSchema = z.object({
  roomId: z.string().uuid(),
  deviceId: z.string().min(1),
  kind: z.enum(["pause", "restart", "resume"]),
});

async function proposeAction(input: z.infer<typeof ProposeSchema>) {
  const room = await fetchRoomById(input.roomId);
  if (!room) throw new Error("room_not_found");
  const players = await fetchPlayers(room.id);
  const me = players.find((p) => p.device_id === input.deviceId);
  if (!me) throw new Error("not_in_room");

  // Sanity vs estado actual
  if (input.kind === "pause" && room.paused_at) throw new Error("already_paused");
  if (input.kind === "resume" && !room.paused_at) throw new Error("not_paused");

  const existing = room.pending_proposal as PendingProposal | null;
  if (existing && !proposalExpired(existing)) {
    throw new Error("proposal_already_active");
  }

  const humans = await humanDevicesFor(room);
  // Sólo el proponente automáticamente "accepted"; el resto "pending".
  const votes: Record<string, VoteValue> = {};
  for (const h of humans) {
    votes[h.deviceId] = h.deviceId === input.deviceId ? "accepted" : "pending";
  }

  // Si es el único humano, se ejecuta inmediatamente.
  if (humans.length <= 1) {
    await executeProposal(room, input.kind);
    return { ok: true as const };
  }

  const proposal: PendingProposal = {
    kind: input.kind,
    proposerSeat: me.seat as PlayerId,
    proposerName: me.name,
    createdAt: nowIso(),
    expiresAt: new Date(nowMs() + PROPOSAL_TTL_MS).toISOString(),
    votes,
  };
  const { error } = await supabase.from("rooms").update({
    pending_proposal: proposal,
  }).eq("id", room.id);
  if (error) throw new Error(error.message);
  return { ok: true as const, proposal };
}

const RespondSchema = z.object({
  roomId: z.string().uuid(),
  deviceId: z.string().min(1),
  accept: z.boolean(),
});

async function respondProposal(input: z.infer<typeof RespondSchema>) {
  const room = await fetchRoomById(input.roomId);
  if (!room) throw new Error("room_not_found");
  const prop = room.pending_proposal as PendingProposal | null;
  if (!prop) throw new Error("no_proposal");
  if (proposalExpired(prop)) {
    await supabase.from("rooms").update({ pending_proposal: null }).eq("id", room.id);
    throw new Error("proposal_expired");
  }
  if (!(input.deviceId in prop.votes)) throw new Error("not_a_voter");

  const updated: PendingProposal = {
    ...prop,
    votes: {
      ...prop.votes,
      [input.deviceId]: input.accept ? "accepted" : "rejected",
    },
  };
  const status = proposalResolved(updated);

  if (status === "executed") {
    await executeProposal(room, updated.kind);
    return { ok: true as const, status: "executed" as const };
  }
  if (status === "rejected") {
    await supabase.from("rooms").update({ pending_proposal: null }).eq("id", room.id);
    return { ok: true as const, status: "rejected" as const };
  }
  await supabase.from("rooms").update({ pending_proposal: updated }).eq("id", room.id);
  return { ok: true as const, status: "pending" as const, proposal: updated };
}

const CancelSchema = z.object({ roomId: z.string().uuid() });
async function cancelProposal(input: z.infer<typeof CancelSchema>) {
  await supabase.from("rooms").update({ pending_proposal: null }).eq("id", input.roomId);
  return { ok: true as const };
}

const RematchStaySchema = z.object({
  roomId: z.string().uuid(),
  deviceId: z.string().min(1),
});
async function rematchStay(input: z.infer<typeof RematchStaySchema>) {
  const room = await fetchRoomById(input.roomId);
  if (!room) throw new Error("room_not_found");
  const humans = await humanDevicesFor(room);
  if (humans.length <= 1) {
    await executeProposal(room, "restart");
    return { ok: true as const, status: "playing" as const };
  }
  // Con varios humanos: usar proposeAction("restart") desde el cliente.
  throw new Error("requires_proposal");
}

// ---------------------------------------------------------------------------
// Stubs (no implementados aún)
// ---------------------------------------------------------------------------
const notImplemented = async () => { throw new Error("not_implemented"); };

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------
type Handler = (data: unknown) => Promise<unknown>;
function withSchema<S extends z.ZodTypeAny>(
  schema: S, fn: (input: z.infer<S>) => Promise<unknown>,
): Handler {
  return async (raw) => {
    const parsed = schema.safeParse(raw);
    if (!parsed.success) {
      throw new Error("invalid_input:" + JSON.stringify(parsed.error.flatten().fieldErrors));
    }
    return fn(parsed.data);
  };
}

const handlers: Record<string, Handler> = {
  ping: async () => ({ ok: true as const, version: "phase-5-humanized-bots+voting" }),
  createRoom: withSchema(CreateRoomSchema, createRoom),
  joinRoom: withSchema(JoinRoomSchema, joinRoom),
  joinAsSpectator: withSchema(JoinSpectatorSchema, joinAsSpectator),
  getRoom: withSchema(GetRoomSchema, getRoom),
  getMyHand: withSchema(GetMyHandSchema, getMyHand),
  listLobbyRooms: listLobbyRooms as Handler,
  listMyActiveRooms: withSchema(ListMyActiveSchema, listMyActiveRooms),
  heartbeat: withSchema(HeartbeatSchema, heartbeat),
  leaveRoom: withSchema(HeartbeatSchema, leaveRoom),
  setRoomSettings: withSchema(SetSettingsSchema, setRoomSettings),
  setSeatKind: withSchema(SetSeatKindSchema, setSeatKind),
  updatePlayerName: withSchema(UpdateNameSchema, updatePlayerName),
  adminCloseRoom: withSchema(AdminCloseSchema, adminCloseRoom),
  setRoomPassword: withSchema(SetRoomPasswordSchema, setRoomPassword),
  verifyRoomPassword: withSchema(VerifyRoomPasswordSchema, verifyRoomPassword),
  sendChatPhrase: withSchema(SendChatPhraseSchema, sendChatPhrase),
  sendTextMessage: withSchema(SendTextMessageSchema, sendTextMessage),
  sendSalaTextMessage: withSchema(SendSalaTextMessageSchema, sendSalaTextMessage),
  flagPlayerInChat: notImplemented,
  adminListChatFlags: notImplemented,
  adminDecideChatFlag: notImplemented,
  adminListChatFlagAudit: notImplemented,
  startMatch: withSchema(StartMatchSchema, startMatch),
  submitAction: withSchema(SubmitActionSchema, submitAction),
  advanceBots: withSchema(HeartbeatSchema, advanceBots),
  markActivity: withSchema(MarkActivitySchema, markActivity),
  setPaused: withSchema(SetPausedSchema, setPaused),
  rematchStay: withSchema(RematchStaySchema, rematchStay),
  proposeAction: withSchema(ProposeSchema, proposeAction),
  respondProposal: withSchema(RespondSchema, respondProposal),
  cancelProposal: withSchema(CancelSchema, cancelProposal),
};

function resolveFn(fn: string): string {
  const normalized = fn.replace(/[-_\s]/g, "").toLowerCase();
  if (normalized === "startmatch") return "startMatch";
  if (normalized === "joinroom" || normalized === "joinchair" || normalized === "sitdown") return "joinRoom";
  return fn;
}

const RequestSchema = z.object({
  fn: z.string().min(1),
  data: z.unknown().optional(),
});

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: makeCorsHeaders(req) });
  }
  if (req.method !== "POST") return withCors(json({ error: "method_not_allowed" }, 405), req);
  let body: unknown;
  try { body = await req.json(); } catch { return withCors(json({ error: "invalid_json" }, 400), req); }
  const parsed = RequestSchema.safeParse(body);
  if (!parsed.success) return withCors(json({ error: "invalid_body" }, 400), req);
  const { fn, data } = parsed.data;
  const handler = handlers[resolveFn(fn)];
  if (!handler) return withCors(json({ error: `unknown_fn:${fn}` }, 400), req);
  try {
    const result = await handler(data);
    return withCors(json(result ?? { ok: true }), req);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const status = msg === "not_implemented" ? 501
      : msg === "forbidden" ? 403
      : msg === "room_not_found" ? 404
      : 400;
    return withCors(json({ error: msg }, status), req);
  }
});