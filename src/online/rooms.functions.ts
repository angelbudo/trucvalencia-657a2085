// Client-side wrapper for rooms server functions.
// Calls the `rooms-rpc` edge function with { fn, data } body.
import { supabase } from "@/integrations/supabase/client";
import type { PlayerId } from "@/game/types";
import type { Action } from "@/game/types";
import type { RoomFullDTO, SeatKind } from "./types";
import { getRoomPlayerProfileUserId } from "./types";
import type { ChatPhraseId } from "@/game/phrases";
import { reportRpcError, reportRpcOk } from "./diagnostics";
import { waitForStableRpcTransport } from "./realtimeReconnect";

function isNotImplementedError(message: string) {
  return message === "not_implemented" || message.includes("not_implemented");
}

async function rpc<T>(fn: string, data: unknown): Promise<T> {
  try {
    await waitForStableRpcTransport(() => supabase.realtime.connectionState());
    const { data: result, error } = await supabase.functions.invoke("rooms-rpc", {
      body: { fn, data },
    });
    if (error) {
      // Try to extract message from edge function response body
      const ctx: any = (error as any).context;
      if (ctx && typeof ctx.json === "function") {
        try {
          const j = await ctx.json();
          if (j?.error) throw new Error(j.error);
        } catch (e) {
          if (e instanceof Error && e.message && e.message !== "Unexpected end of JSON input") throw e;
        }
      }
      throw new Error(error.message || "Error de connexió");
    }
    if (result && typeof result === "object" && "error" in result && (result as any).error) {
      throw new Error((result as any).error);
    }
    reportRpcOk();
    return result as T;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (fn === "listMyActiveRooms" && isNotImplementedError(msg)) {
      reportRpcError(
        `rpc:${fn}`,
        "rooms-rpc desplegada todavía es la Fase 1; se omite la lista de partidas activas hasta redeploy.",
      );
      return { rooms: [] } as T;
    }
    if (fn === "listLobbyRooms" && isNotImplementedError(msg)) {
      reportRpcError(
        `rpc:${fn}`,
        "rooms-rpc desplegada todavía es la Fase 1; se muestra el lobby vacío hasta redeploy.",
      );
      return { rooms: [] } as T;
    }
    reportRpcError(`rpc:${fn}`, msg);
    throw e;
  }
}

async function currentAuthUserId(): Promise<string | null> {
  try {
    const { data: sessionData } = await supabase.auth.getSession();
    if (sessionData.session?.user?.id) return sessionData.session.user.id;
    const { data, error } = await supabase.auth.getUser();
    if (error) return null;
    return data.user?.id ?? null;
  } catch {
    return null;
  }
}

function withProfileUserId<T extends object>(data: T, userId: string | null): T & { userId?: string; profileUserId?: string; profile_user_id?: string } {
  return userId ? { ...data, userId, profileUserId: userId, profile_user_id: userId } : data;
}

async function persistRoomPlayerProfileUserId(roomId: string | null | undefined, deviceId: string | null | undefined, userId: string | null) {
  if (!roomId || !deviceId || !userId) return;
  try {
    const { error } = await (supabase as any)
      .from("room_players")
      .update({ profile_user_id: userId } as never)
      .eq("room_id", roomId)
      .eq("device_id", deviceId);
    if (error) {
      console.warn("[rooms] persistRoomPlayerProfileUserId failed", {
        roomId,
        deviceId,
        userId,
        error: error.message,
      });
      reportRpcError("persistProfileUserId", error.message);
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn("[rooms] persistRoomPlayerProfileUserId threw", msg);
    reportRpcError("persistProfileUserId", msg);
  }
}

async function enrichRoomPlayersWithProfileUserIds(room: RoomFullDTO): Promise<RoomFullDTO> {
  let players = room.players;

  try {
    const { data } = await (supabase as any)
      .from("room_players")
      .select("device_id,profile_user_id")
      .eq("room_id", room.room.id);
    if (data && data.length > 0) {
      const byDevice = new Map(
        (data as Array<{ device_id: string; profile_user_id?: string | null }>)
          .map((row) => [row.device_id, row.profile_user_id ?? null]),
      );
      players = players.map((player) => {
        const userId = getRoomPlayerProfileUserId(player) ?? byDevice.get(player.deviceId) ?? null;
        return userId ? { ...player, userId, profileUserId: userId } : player;
      });
    }
  } catch {
    /* El backend antiguo puede no tener aún profile_user_id/user_id en room_players. */
  }

  const unresolvedDeviceIds = players
    .filter((p) => p.deviceId && !getRoomPlayerProfileUserId(p))
    .map((p) => p.deviceId);
  const uniqueDeviceIds = Array.from(new Set(unresolvedDeviceIds));
  if (uniqueDeviceIds.length === 0) return { ...room, players };

  try {
    const { data } = await supabase
      .from("account_links")
      .select("device_id,user_id")
      .in("device_id", uniqueDeviceIds);
    if (!data || data.length === 0) return { ...room, players };
    const byDevice = new Map(data.map((row) => [row.device_id, row.user_id]));
    return {
      ...room,
      players: players.map((player) => {
        const userId = getRoomPlayerProfileUserId(player) ?? byDevice.get(player.deviceId) ?? null;
        return userId ? { ...player, userId, profileUserId: userId } : player;
      }),
    };
  } catch {
    return { ...room, players };
  }
}

async function enrichLobbyRoomsWithProfileUserIds<T extends { rooms: LobbyRoomDTO[] }>(payload: T): Promise<T> {
  if (payload.rooms.length === 0) return payload;

  // Step 1: Fetch room_players for all visible rooms to pick up device_id +
  // profile_user_id by (room_id, seat). The lobby RPC currently returns only
  // {seat, name, isOnline}, so without this lookup we cannot resolve avatars.
  type RoomPlayerRow = {
    room_id: string;
    seat: number;
    device_id: string | null;
    profile_user_id?: string | null;
  };
  const bySeat = new Map<string, { deviceId: string | null; userId: string | null }>();
  try {
    const { data } = await (supabase as any)
      .from("room_players")
      .select("room_id,seat,device_id,profile_user_id")
      .in("room_id", payload.rooms.map((r) => r.id));
    if (data) {
      for (const row of data as RoomPlayerRow[]) {
        bySeat.set(`${row.room_id}:${row.seat}`, {
          deviceId: row.device_id,
          userId: row.profile_user_id ?? null,
        });
      }
    }
  } catch {
    /* table not accessible — fall through */
  }

  let rooms = payload.rooms.map((room) => ({
    ...room,
    players: room.players.map((player) => {
      const existing = getRoomPlayerProfileUserId(player);
      const lookup = bySeat.get(`${room.id}:${player.seat}`);
      const deviceId = player.deviceId ?? lookup?.deviceId ?? undefined;
      const userId = existing ?? lookup?.userId ?? null;
      const next = { ...player };
      if (deviceId && !next.deviceId) next.deviceId = deviceId;
      if (userId) {
        next.userId = userId;
        next.profileUserId = userId;
      }
      return next;
    }),
  }));

  // Step 2: For any human player still missing profile_user_id but with a
  // known device_id, fall back to account_links.
  const ids = new Set<string>();
  for (const room of rooms) {
    for (const player of room.players) {
      if (player.deviceId && !getRoomPlayerProfileUserId(player)) ids.add(player.deviceId);
    }
  }
  if (ids.size === 0) return { ...payload, rooms };
  try {
    const { data } = await supabase
      .from("account_links")
      .select("device_id,user_id")
      .in("device_id", Array.from(ids));
    if (!data || data.length === 0) return { ...payload, rooms };
    const byDevice = new Map(data.filter((row) => row.device_id).map((row) => [row.device_id!, row.user_id]));
    rooms = rooms.map((room) => ({
      ...room,
      players: room.players.map((player) => {
        const userId = getRoomPlayerProfileUserId(player) ?? (player.deviceId ? byDevice.get(player.deviceId) : null) ?? null;
        return userId ? { ...player, userId, profileUserId: userId } : player;
      }),
    }));
  } catch {
    /* ignore */
  }
  return { ...payload, rooms };
}

/**
 * The original TanStack Start `serverFn` exposed handlers as
 * `someFn({ data: {...} })`. We replicate that signature here so that the
 * existing call sites do not need to change.
 */
function makeFn<I, O>(fn: string) {
  return ({ data }: { data: I }) => rpc<O>(fn, data);
}

export interface CreateRoomInput {
  hostDevice: string;
  hostName: string;
  userId?: string | null;
  profileUserId?: string | null;
  targetCames: number;
  targetCama?: number;
  turnTimeoutSec?: number;
  initialMano: PlayerId;
  seatKinds: SeatKind[];
  hostSeat: PlayerId;
  /** Optional slug to scope the generated room code to a specific sala. */
  salaSlug?: string;
  /** Optional explicit 6-char code to use (must be free). If taken or invalid,
   *  the server falls back to generating one within `salaSlug`. */
  requestedCode?: string;
}
export const createRoom = async ({ data }: { data: CreateRoomInput }) => {
  const userId = data.userId ?? data.profileUserId ?? await currentAuthUserId();
  const result = await rpc<{ code: string; roomId: string }>("createRoom", withProfileUserId(data, userId));
  await persistRoomPlayerProfileUserId(result.roomId, data.hostDevice, userId);
  return result;
};

export interface SetRoomSettingsInput {
  roomId: string;
  deviceId: string;
  targetCames?: number;
  targetCama?: number;
  turnTimeoutSec?: number;
}
export const setRoomSettings = makeFn<SetRoomSettingsInput, { ok: true }>("setRoomSettings");

export interface JoinRoomInput {
  code: string;
  deviceId: string;
  name: string;
  userId?: string | null;
  profileUserId?: string | null;
  preferredSeat?: PlayerId | null;
}
export const joinRoom = async ({ data }: { data: JoinRoomInput }) => {
  const userId = data.userId ?? data.profileUserId ?? await currentAuthUserId();
  const result = await rpc<{ roomId: string; code: string; seat: PlayerId | null; isSpectator?: true }>("joinRoom", withProfileUserId(data, userId));
  if (result.seat != null) await persistRoomPlayerProfileUserId(result.roomId, data.deviceId, userId);
  return result;
};

export interface JoinAsSpectatorInput {
  code: string;
  deviceId?: string;
}
export const joinAsSpectator = makeFn<
  JoinAsSpectatorInput,
  { roomId: string; code: string; seat: null; isSpectator: true }
>("joinAsSpectator");

export interface GetRoomInput {
  code: string;
  deviceId?: string | null;
}
export const getRoom = async ({ data }: { data: GetRoomInput }) => enrichRoomPlayersWithProfileUserIds(
  await rpc<RoomFullDTO>("getRoom", data),
);

// Devuelve la mano REAL del asiento del `deviceId` solicitante. La edge
// function valida en servidor que el deviceId corresponda al asiento.
export interface GetMyHandInput {
  code: string;
  deviceId: string;
}
export interface GetMyHandResult {
  hand: Array<{ id: string; suit: string; rank: number }>;
  seat: PlayerId | null;
}
export const getMyHand = ({ data }: { data: GetMyHandInput }) =>
  rpc<GetMyHandResult>("getMyHand", data);

export interface GetAllHandsDebugInput { code: string }
export interface GetAllHandsDebugResult {
  hands: Record<PlayerId, Array<{ id: string; suit: string; rank: number }>>;
}
export const getAllHandsDebug = ({ data }: { data: GetAllHandsDebugInput }) =>
  rpc<GetAllHandsDebugResult>("getAllHandsDebug", data);

export interface StartMatchInput {
  roomId: string;
  deviceId: string;
}
export const startMatch = makeFn<StartMatchInput, { ok: true }>("startMatch");

export interface SubmitActionInput {
  roomId: string;
  deviceId: string;
  action: Action;
}
export const submitAction = makeFn<SubmitActionInput, { ok: boolean; stale?: boolean }>("submitAction");

export interface UpdatePlayerNameInput {
  roomId: string;
  deviceId: string;
  name: string;
}
export const updatePlayerName = makeFn<UpdatePlayerNameInput, { ok: true }>("updatePlayerName");

export interface HeartbeatInput {
  roomId: string;
  deviceId: string;
}
export const heartbeat = makeFn<HeartbeatInput, { ok: true }>("heartbeat");
export const advanceBots = makeFn<HeartbeatInput, { ok: true }>("advanceBots");
export const markActivity = makeFn<HeartbeatInput, { ok: true }>("markActivity");

export interface SetSeatKindInput {
  roomId: string;
  deviceId: string;
  seat: PlayerId;
  kind: SeatKind;
  userId?: string | null;
  profileUserId?: string | null;
}
export const setSeatKind = async ({ data }: { data: SetSeatKindInput }) => {
  const userId = data.userId ?? data.profileUserId ?? await currentAuthUserId();
  const result = await rpc<{ ok: true }>("setSeatKind", withProfileUserId(data, userId));
  if (data.kind === "human") {
    await persistRoomPlayerProfileUserId(data.roomId, data.deviceId, userId);
  }
  return result;
};

export interface LeaveRoomInput {
  roomId: string;
  deviceId: string;
}
export const leaveRoom = makeFn<LeaveRoomInput, { ok: true; abandoned?: boolean }>("leaveRoom");

export interface RematchStayInput {
  roomId: string;
  deviceId: string;
}
export const rematchStay = makeFn<RematchStayInput, { ok: true; status: "playing" | "lobby" }>("rematchStay");

export interface LobbyRoomDTO {
  id: string;
  code: string;
  status: "lobby" | "playing" | "finished" | "abandoned";
  targetCames: number;
  targetCama: number;
  turnTimeoutSec: number;
  seatKinds: SeatKind[];
  hostDevice: string;
  players: {
    seat: PlayerId;
    name: string;
    isOnline: boolean;
    deviceId?: string;
    userId?: string | null;
    profileUserId?: string | null;
    user_id?: string | null;
    profile_user_id?: string | null;
  }[];
}
export const listLobbyRooms = async ({ data }: { data: Record<string, never> }) => enrichLobbyRoomsWithProfileUserIds(
  await rpc<{ rooms: LobbyRoomDTO[] }>("listLobbyRooms", data),
);

export interface SendChatPhraseInput {
  roomId: string;
  deviceId: string;
  phraseId: ChatPhraseId;
}
export const sendChatPhrase = makeFn<SendChatPhraseInput, { ok: true }>("sendChatPhrase");

export interface SendTextMessageInput {
  roomId: string;
  deviceId: string;
  text: string;
  /** Nom a mostrar quan el remitent és un espectador (no està assegut). */
  senderName?: string;
}
export const sendTextMessage = makeFn<SendTextMessageInput, { ok: true }>("sendTextMessage");

export interface FlagPlayerInChatInput {
  roomId: string;
  deviceId: string;
  targetSeat: PlayerId;
  reason?: string | null;
  messageId?: number | null;
  messageText?: string | null;
}
export interface FlagPlayerInChatResult {
  ok: true;
  expiresAt: string;
  muteMinutes: number;
  reporterCount: number;
}
export const flagPlayerInChat = makeFn<FlagPlayerInChatInput, FlagPlayerInChatResult>(
  "flagPlayerInChat",
);

export type ChatFlagStatus = "pending" | "approved" | "dismissed";

export interface AdminChatFlagDTO {
  id: number;
  roomId: string;
  roomCode: string;
  targetSeat: PlayerId;
  targetName: string;
  targetDeviceId: string;
  reporterDeviceId: string;
  reporterName: string;
  reason: string | null;
  messageId: number | null;
  messageText: string | null;
  status: ChatFlagStatus;
  createdAt: string;
  expiresAt: string;
  decidedAt: string | null;
  decidedBy: string | null;
}

export interface AdminListChatFlagsInput {
  password: string;
  status?: ChatFlagStatus | "all";
}
export const adminListChatFlags = makeFn<
  AdminListChatFlagsInput,
  { ok: true; flags: AdminChatFlagDTO[] }
>("adminListChatFlags");

export interface AdminDecideChatFlagInput {
  password: string;
  flagId: number;
  decision: ChatFlagStatus;
  moderatorTag?: string;
  /** Optional moderator note recorded in the audit log (max 500 chars). */
  note?: string;
}
export const adminDecideChatFlag = makeFn<
  AdminDecideChatFlagInput,
  { ok: true; flag: unknown; auditError: string | null }
>("adminDecideChatFlag");

export interface AdminChatFlagAuditEntryDTO {
  id: number;
  flagId: number;
  roomId: string;
  targetSeat: number;
  targetDeviceId: string;
  reporterDeviceId: string;
  messageId: number | null;
  messageText: string | null;
  reason: string | null;
  decision: ChatFlagStatus;
  moderatorTag: string;
  flagCreatedAt: string;
  flagExpiresAt: string;
  decidedAt: string;
}
export interface AdminListChatFlagAuditInput {
  password: string;
  flagId?: number;
  roomId?: string;
  limit?: number;
}
export const adminListChatFlagAudit = makeFn<
  AdminListChatFlagAuditInput,
  { ok: true; entries: AdminChatFlagAuditEntryDTO[] }
>("adminListChatFlagAudit");

export interface AdminCloseRoomInput {
  roomId: string;
  password: string;
}
export const adminCloseRoom = makeFn<AdminCloseRoomInput, { ok: true }>("adminCloseRoom");

export interface MyActiveRoomDTO {
  id: string;
  code: string;
  status: "playing";
  targetCames: number;
  updatedAt: string;
  mySeat: PlayerId | null;
}
export const listMyActiveRooms = makeFn<{ deviceId: string }, { rooms: MyActiveRoomDTO[] }>(
  "listMyActiveRooms",
);

export interface SetPausedInput {
  roomId: string;
  deviceId: string;
  paused: boolean;
}
export const setPaused = makeFn<SetPausedInput, { ok: true; paused: boolean }>("setPaused");

export type ProposalKind = "pause" | "restart" | "resume";
export interface PendingProposal {
  kind: ProposalKind;
  proposerSeat: PlayerId;
  proposerName: string;
  createdAt: string;
  expiresAt: string;
  votes: Record<string, "accepted" | "rejected" | "pending">;
}
export interface ProposeActionInput {
  roomId: string;
  deviceId: string;
  kind: ProposalKind;
}
export const proposeAction = makeFn<
  ProposeActionInput,
  { ok: true; proposal?: PendingProposal }
>("proposeAction");

export interface RespondProposalInput {
  roomId: string;
  deviceId: string;
  accept: boolean;
}
export const respondProposal = makeFn<
  RespondProposalInput,
  { ok: true; status: "executed" | "rejected" | "pending"; proposal?: PendingProposal }
>("respondProposal");

export interface CancelProposalInput {
  roomId: string;
}
export const cancelProposal = makeFn<CancelProposalInput, { ok: true }>("cancelProposal");