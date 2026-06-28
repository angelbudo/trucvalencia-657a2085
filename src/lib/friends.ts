import { useEffect, useState, useCallback, useMemo, useRef } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import type { ProfileRow, UserStats } from "@/lib/playerStats";

/**
 * Friend system backed by the manually-created `public.friends` table:
 *   columns: user_id (requester), friend_id (recipient), status ('pending'|'accepted'), created_at
 *
 * Conventions:
 *  - INSERT always with status='pending' (requester = user_id, recipient = friend_id)
 *  - Outgoing requests: user_id = me AND status = 'pending'
 *  - Incoming requests: friend_id = me AND status = 'pending'
 *  - Accepted friendship: status = 'accepted' AND (user_id = me OR friend_id = me)
 *  - Accept: UPDATE status='accepted' WHERE user_id=other AND friend_id=me
 *  - Reject / cancel / unfriend: DELETE the matching row(s)
 */

export interface FriendRow {
  user_id: string;
  friend_id: string;
  status: "pending" | "accepted";
  created_at?: string;
}

export interface FriendshipLike {
  /** Synthetic id: `${user_id}:${friend_id}` */
  id: string;
  user_id: string;
  friend_id: string;
  status: "pending" | "accepted";
}

export interface FriendEntry {
  friendship: FriendshipLike;
  /** L'altre usuari (no jo) */
  other: ProfileRow;
  stats: UserStats | null;
  online: boolean;
}

const ONLINE_CHANNEL = "app:online-users";

/**
 * Singleton ref-counted subscriber per la taula `friends`.
 *
 * Si múltiples components (Perfil, PlayerProfileDialog flotant, accés a la
 * mesa…) creen alhora `supabase.channel("friends:<uid>")`, Supabase reusa
 * el topic i el segon `.on('postgres_changes', ...)` llança l'error:
 *   "Cannot add 'postgres_changes' callbacks ... after subscribe()".
 *
 * Aquí mantenim un únic canal per user.id i un Set de listeners. Cada
 * consumidor rep una funció de neteja que el desregistra; quan no en queda
 * cap, eliminem el canal de Supabase.
 */
type FriendsListener = () => void;
interface FriendsSub {
  channel: ReturnType<typeof supabase.channel>;
  listeners: Set<FriendsListener>;
}
const friendsSubs = new Map<string, FriendsSub>();

function subscribeFriendsRealtime(userId: string, listener: FriendsListener): () => void {
  let entry = friendsSubs.get(userId);
  if (!entry) {
    const listeners = new Set<FriendsListener>();
    const channel = supabase
      .channel(`friends:${userId}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "friends" }, () => {
        listeners.forEach((cb) => {
          try {
            cb();
          } catch {
            /* ignore */
          }
        });
      })
      .subscribe();
    entry = { channel, listeners };
    friendsSubs.set(userId, entry);
  }
  entry.listeners.add(listener);
  return () => {
    const cur = friendsSubs.get(userId);
    if (!cur) return;
    cur.listeners.delete(listener);
    if (cur.listeners.size === 0) {
      try {
        supabase.removeChannel(cur.channel);
      } catch {
        /* ignore */
      }
      friendsSubs.delete(userId);
    }
  };
}

/**
 * Singleton ref-counted del canal de presència global `app:online-users`.
 *
 * Diversos components munten `useOnlineUsers` alhora (Perfil, diàleg flotant
 * de perfil, accés a la mesa…). Com que supabase-js deduplica
 * `supabase.channel(name)` per topic, el segon hook intentaria afegir
 * `.on('presence', ...)` DESPRÉS del `.subscribe()` del primer, llançant:
 *   "cannot add 'presence' callbacks for realtime:app:online-users after subscribe()".
 *
 * Solució: un únic canal compartit + listeners multiplexats. Tots els
 * `.on('presence', ...)` es registren ABANS del `.subscribe()`.
 */
type OnlineListener = (ids: Set<string>) => void;
interface OnlineSub {
  channel: ReturnType<typeof supabase.channel>;
  listeners: Set<OnlineListener>;
  snapshot: Set<string>;
  trackedUserId: string | null;
  subscribed: boolean;
}
const globalOnlineKey = "__trucOnlineUsersPresence";

function getOnlineSub(): OnlineSub | null {
  return (
    (globalThis as typeof globalThis & Record<string, OnlineSub | null>)[globalOnlineKey] ?? null
  );
}

function setOnlineSub(sub: OnlineSub | null) {
  (globalThis as typeof globalThis & Record<string, OnlineSub | null>)[globalOnlineKey] = sub;
}

function emitOnlineSub(sub: OnlineSub) {
  sub.listeners.forEach((cb) => {
    try {
      cb(sub.snapshot);
    } catch {
      /* ignore */
    }
  });
}

function syncOnlineSub(sub: OnlineSub) {
  const state = sub.channel.presenceState<{ user_id?: string }>();
  const ids = new Set<string>();
  for (const [key, metas] of Object.entries(state)) {
    for (const meta of metas) {
      const userId = typeof meta?.user_id === "string" ? meta.user_id : key;
      if (userId) ids.add(userId);
    }
  }
  sub.snapshot = ids;
  emitOnlineSub(sub);
}

function subscribeOnlineUsers(userId: string, listener: OnlineListener): () => void {
  let onlineSub = getOnlineSub();
  if (!onlineSub) {
    const channel = supabase.channel(ONLINE_CHANNEL, {
      config: { presence: { key: `client:${Math.random().toString(36).slice(2)}` } },
    });
    const sub: OnlineSub = {
      channel,
      listeners: new Set(),
      snapshot: new Set(),
      trackedUserId: null,
      subscribed: false,
    };
    setOnlineSub(sub);
    // IMPORTANT: tots els callbacks `.on('presence', ...)` van ABANS de `.subscribe()`.
    channel
      .on("presence", { event: "sync" }, () => syncOnlineSub(sub))
      .on("presence", { event: "join" }, () => syncOnlineSub(sub))
      .on("presence", { event: "leave" }, () => syncOnlineSub(sub));
    channel.subscribe(async (status) => {
      if (status === "SUBSCRIBED") {
        sub.subscribed = true;
        if (sub.trackedUserId) {
          try {
            await channel.track({ user_id: sub.trackedUserId, t: Date.now() });
          } catch {
            /* ignore */
          }
        }
      } else if (status === "CLOSED" || status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
        sub.subscribed = false;
      }
    });
    onlineSub = sub;
  }
  const sub = onlineSub;
  sub.trackedUserId = userId;
  if (sub.subscribed) {
    void sub.channel.track({ user_id: userId, t: Date.now() }).catch(() => undefined);
  }
  sub.listeners.add(listener);
  listener(sub.snapshot);
  return () => {
    const cur = getOnlineSub();
    if (!cur) return;
    cur.listeners.delete(listener);
    if (cur.listeners.size === 0) {
      cur.trackedUserId = null;
      cur.snapshot = new Set();
      try {
        cur.channel.untrack();
      } catch {
        /* ignore */
      }
    }
  };
}

/** Hook que es subscriu a un canal de presència global per saber quins users estan connectats. */
export function useOnlineUsers(): {
  isOnline: (userId: string) => boolean;
  onlineSet: Set<string>;
} {
  const { user } = useAuth();
  const [onlineSet, setOnlineSet] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (!user) {
      setOnlineSet(new Set());
      return;
    }
    const unsubscribe = subscribeOnlineUsers(user.id, (ids) => setOnlineSet(new Set(ids)));
    return unsubscribe;
  }, [user]);

  return {
    onlineSet,
    isOnline: (uid: string) => onlineSet.has(uid),
  };
}

function synthId(r: { user_id: string; friend_id: string }) {
  return `${r.user_id}:${r.friend_id}`;
}

export function normalizeUserId(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function useFriends() {
  const { user, ready } = useAuth();
  const [accepted, setAccepted] = useState<FriendEntry[]>([]);
  const [incoming, setIncoming] = useState<FriendEntry[]>([]);
  const [outgoing, setOutgoing] = useState<FriendEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const { onlineSet } = useOnlineUsers();
  const reloadRef = useRef<() => void>(() => {});

  const reload = useCallback(async () => {
    if (!user) {
      setAccepted([]);
      setIncoming([]);
      setOutgoing([]);
      return;
    }
    setLoading(true);
    try {
      const [acceptedFromMe, acceptedToMe, incomingRes, outgoingRes] = await Promise.all([
        (supabase as any)
          .from("friends")
          .select("user_id, friend_id, status, created_at")
          .eq("user_id", user.id)
          .eq("status", "accepted"),
        (supabase as any)
          .from("friends")
          .select("user_id, friend_id, status, created_at")
          .eq("friend_id", user.id)
          .eq("status", "accepted"),
        (supabase as any)
          .from("friends")
          .select("user_id, friend_id, status, created_at")
          .eq("friend_id", user.id)
          .eq("status", "pending"),
        (supabase as any)
          .from("friends")
          .select("user_id, friend_id, status, created_at")
          .eq("user_id", user.id)
          .eq("status", "pending"),
      ]);
      const queryError =
        acceptedFromMe.error ?? acceptedToMe.error ?? incomingRes.error ?? outgoingRes.error;
      if (queryError) throw new Error(queryError.message);
      const acceptedRows = [
        ...(acceptedFromMe.data ?? []),
        ...(acceptedToMe.data ?? []),
      ] as FriendRow[];
      const incomingRows = (incomingRes.data ?? []) as FriendRow[];
      const outgoingRows = (outgoingRes.data ?? []) as FriendRow[];
      const deduped = new Map<string, FriendRow>();
      [...acceptedRows, ...incomingRows, ...outgoingRows].forEach((r) =>
        deduped.set(synthId(r), r),
      );
      const friends = Array.from(deduped.values());
      const otherIds = Array.from(
        new Set(friends.map((r) => (r.user_id === user.id ? r.friend_id : r.user_id))),
      );
      let profiles: ProfileRow[] = [];
      let stats: UserStats[] = [];
      if (otherIds.length > 0) {
        const [pRes, sRes] = await Promise.all([
          supabase.from("profiles").select("*").in("user_id", otherIds),
          supabase.from("user_stats").select("*").in("user_id", otherIds),
        ]);
        profiles = (pRes.data ?? []) as ProfileRow[];
        stats = (sRes.data ?? []) as UserStats[];
      }
      const byUser = new Map(profiles.map((p) => [p.user_id, p]));
      const statsByUser = new Map(stats.map((s) => [s.user_id, s]));

      const buildEntry = (r: FriendRow): FriendEntry | null => {
        const otherId = r.user_id === user.id ? r.friend_id : r.user_id;
        const other = byUser.get(otherId) ?? {
          user_id: otherId,
          display_name: "Jugador",
          friend_code: "",
          username: null,
          avatar_url: null,
          email: null,
        };
        return {
          friendship: {
            id: synthId(r),
            user_id: r.user_id,
            friend_id: r.friend_id,
            status: r.status,
          },
          other,
          stats: statsByUser.get(otherId) ?? null,
          online: onlineSet.has(otherId),
        };
      };
      const entriesById = new Map(
        (friends.map(buildEntry).filter(Boolean) as FriendEntry[]).map((entry) => [
          entry.friendship.id,
          entry,
        ]),
      );
      setAccepted(
        acceptedRows.map((r) => entriesById.get(synthId(r))).filter(Boolean) as FriendEntry[],
      );
      setIncoming(
        incomingRows.map((r) => entriesById.get(synthId(r))).filter(Boolean) as FriendEntry[],
      );
      setOutgoing(
        outgoingRows.map((r) => entriesById.get(synthId(r))).filter(Boolean) as FriendEntry[],
      );
    } catch (e) {
      console.error("[friends] reload failed", e);
      setAccepted([]);
      setIncoming([]);
      setOutgoing([]);
    } finally {
      setLoading(false);
    }
  }, [user, onlineSet]);

  reloadRef.current = reload;

  useEffect(() => {
    if (ready) void reload();
  }, [ready, reload]);

  // Realtime: refresca quan hi ha canvis a friends.
  // Usa un singleton ref-counted per evitar múltiples canals amb el mateix
  // topic (que provoca l'error "Cannot add 'postgres_changes' callbacks ...
  // after subscribe()" quan diversos components monten useFriends alhora:
  // Perfil, PlayerProfileDialog flotant, accés a la mesa, etc.).
  useEffect(() => {
    if (!user) return;
    const unsubscribe = subscribeFriendsRealtime(user.id, () => {
      reloadRef.current?.();
    });
    return unsubscribe;
  }, [user]);

  return { accepted, incoming, outgoing, loading, reload };
}

async function loadFriendIds(userId: string): Promise<Set<string>> {
  const currentUserId = normalizeUserId(userId);
  if (!currentUserId) return new Set();
  const { data, error } = await (supabase as any)
    .from("friends")
    .select("user_id, friend_id, status")
    .eq("status", "accepted")
    .or(`user_id.eq.${currentUserId},friend_id.eq.${currentUserId}`);
  if (error) throw new Error(error.message);
  const ids = new Set<string>();
  for (const row of (data ?? []) as FriendRow[]) {
    const leftId = normalizeUserId(row.user_id);
    const rightId = normalizeUserId(row.friend_id);
    if (!leftId || !rightId) continue;
    ids.add(leftId === currentUserId ? rightId : leftId);
  }
  // (log retirat per evitar soroll a la consola en cada refetch/realtime)
  return ids;
}

// Caché global de friendIds per `userId`. Es manté viva durant tota la sessió
// perquè qualsevol pantalla que munte `useFriendUserIds` (Sales, Lobby, Sala,
// PlayerProfileDialog…) pinte instantàniament sense esperar la primera query.
// L'omple el `GlobalLobbyWarmup` poc després de l'arrencada via `useFriendsWarmup`
// i s'actualitza per Realtime (subscribeFriendsRealtime).
const friendIdsCache = new Map<string, Set<string>>();
type FriendIdsListener = (ids: Set<string>) => void;
const friendIdsListeners = new Map<string, Set<FriendIdsListener>>();

function emitFriendIds(userId: string, ids: Set<string>) {
  const subs = friendIdsListeners.get(userId);
  if (!subs) return;
  subs.forEach((cb) => { try { cb(ids); } catch { /* ignore */ } });
}

export function useFriendUserIds(): Set<string> {
  const { user, ready } = useAuth();
  const [ids, setIds] = useState<Set<string>>(() => {
    const uid = normalizeUserId(user?.id);
    return uid ? (friendIdsCache.get(uid) ?? new Set()) : new Set();
  });

  useEffect(() => {
    if (!ready) return;
    const currentUserId = normalizeUserId(user?.id);
    if (!currentUserId) {
      setIds(new Set());
      return;
    }

    // Render inicial des de la caché (sense esperar al fetch).
    const cached = friendIdsCache.get(currentUserId);
    if (cached) setIds(cached);

    let alive = true;
    const refresh = async () => {
      try {
        const next = await loadFriendIds(currentUserId);
        if (!alive) return;
        friendIdsCache.set(currentUserId, next);
        emitFriendIds(currentUserId, next);
        setIds(next);
      } catch (e) {
        console.error("[friends] loadFriendIds failed", e);
        if (!alive) return;
        setIds(new Set());
      }
    };

    // Si no hi havia caché, fes el primer fetch; si hi era, refresca en background.
    void refresh();

    // Subscriu-te a actualitzacions globals (altres mounts del mateix hook).
    let listeners = friendIdsListeners.get(currentUserId);
    if (!listeners) {
      listeners = new Set();
      friendIdsListeners.set(currentUserId, listeners);
    }
    const onIds: FriendIdsListener = (next) => setIds(next);
    listeners.add(onIds);

    const unsubscribe = subscribeFriendsRealtime(currentUserId, () => {
      void refresh();
    });

    return () => {
      alive = false;
      listeners?.delete(onIds);
      unsubscribe();
    };
  }, [ready, user?.id]);

  return ids;
}

/**
 * Variant sense React: omple la caché global de friendIds. Pensat per fer
 * pre-càrrega global (per exemple des de `GlobalLobbyWarmup`).
 */
export async function warmupFriendIds(userId: string): Promise<Set<string>> {
  const uid = normalizeUserId(userId);
  if (!uid) return new Set();
  const next = await loadFriendIds(uid);
  friendIdsCache.set(uid, next);
  emitFriendIds(uid, next);
  return next;
}


export interface FriendIdentity {
  deviceId?: string | null;
  userId?: string | null;
}

const deviceUserIdCache = new Map<string, string | null>();
const deviceUserIdInflight = new Map<string, Promise<string | null>>();

async function loadUserIdByDevice(deviceId: string): Promise<string | null> {
  const normalizedDeviceId = normalizeUserId(deviceId);
  if (!normalizedDeviceId) return null;
  if (deviceUserIdCache.has(normalizedDeviceId)) {
    return deviceUserIdCache.get(normalizedDeviceId) ?? null;
  }
  const inflight = deviceUserIdInflight.get(normalizedDeviceId);
  if (inflight) return inflight;

  const request = (async () => {
    try {
      const { data, error } = await supabase.rpc("get_public_player_profile_by_device", {
        p_device_id: normalizedDeviceId,
      });
      if (error || !data || (Array.isArray(data) && data.length === 0)) return null;
      const row = Array.isArray(data) ? data[0] : data;
      return normalizeUserId((row as { user_id?: string | null } | null)?.user_id ?? null);
    } catch {
      return null;
    }
  })();

  deviceUserIdInflight.set(normalizedDeviceId, request);
  const resolved = await request;
  deviceUserIdCache.set(normalizedDeviceId, resolved);
  deviceUserIdInflight.delete(normalizedDeviceId);
  return resolved;
}

export function useFriendIdentityMatcher(identities: FriendIdentity[]) {
  const friendIds = useFriendUserIds();
  const [deviceUserIds, setDeviceUserIds] = useState<Record<string, string | null>>({});
  const deviceKey = useMemo(
    () =>
      Array.from(
        new Set(
          identities
            .map((identity) => normalizeUserId(identity.deviceId))
            .filter((id): id is string => !!id),
        ),
      )
        .sort()
        .join("|"),
    [identities],
  );

  useEffect(() => {
    const deviceIds = deviceKey ? deviceKey.split("|") : [];
    if (deviceIds.length === 0) {
      setDeviceUserIds({});
      return;
    }
    let alive = true;
    void (async () => {
      const entries = await Promise.all(
        deviceIds.map(async (deviceId) => [deviceId, await loadUserIdByDevice(deviceId)] as const),
      );
      if (!alive) return;
      setDeviceUserIds(Object.fromEntries(entries));
    })();
    return () => {
      alive = false;
    };
  }, [deviceKey]);

  const getResolvedUserId = useCallback(
    (identity: FriendIdentity): string | null => {
      const directUserId = normalizeUserId(identity.userId);
      if (directUserId) return directUserId;
      const deviceId = normalizeUserId(identity.deviceId);
      return deviceId ? normalizeUserId(deviceUserIds[deviceId]) : null;
    },
    [deviceUserIds],
  );

  const isFriend = useCallback(
    (identity: FriendIdentity): boolean => {
      const resolvedUserId = getResolvedUserId(identity);
      return !!resolvedUserId && friendIds.has(resolvedUserId);
    },
    [friendIds, getResolvedUserId],
  );

  return { friendIds, getResolvedUserId, isFriend };
}

/** Returns the current friendship status between the signed-in user and another user, or null. */
export async function getFriendStatusWith(
  otherUserId: string,
): Promise<
  { status: "accepted" } | { status: "pending"; direction: "outgoing" | "incoming" } | null
> {
  const { data: auth } = await supabase.auth.getUser();
  const uid = auth.user?.id;
  if (!uid || uid === otherUserId) return null;
  const [outgoingRes, incomingRes] = await Promise.all([
    (supabase as any)
      .from("friends")
      .select("user_id, friend_id, status")
      .eq("user_id", uid)
      .eq("friend_id", otherUserId),
    (supabase as any)
      .from("friends")
      .select("user_id, friend_id, status")
      .eq("user_id", otherUserId)
      .eq("friend_id", uid),
  ]);
  const queryError = outgoingRes.error ?? incomingRes.error;
  if (queryError) throw new Error(queryError.message);
  const rows = [...(outgoingRes.data ?? []), ...(incomingRes.data ?? [])] as FriendRow[];
  if (rows.length === 0) return null;
  const acc = rows.find((r) => r.status === "accepted");
  if (acc) return { status: "accepted" };
  const pend = rows.find((r) => r.status === "pending");
  if (pend) {
    return { status: "pending", direction: pend.user_id === uid ? "outgoing" : "incoming" };
  }
  return null;
}

/**
 * Sends a friend request. Inserts into `friends` with status='pending'.
 */
export async function addFriendDirect(friendUserId: string) {
  const { data: auth } = await supabase.auth.getUser();
  const uid = auth.user?.id;
  if (!uid) throw new Error("Has d'iniciar sessió per afegir amics");
  if (uid === friendUserId) throw new Error("No pots afegir-te a tu mateix");
  // Avoid duplicate when a relation already exists in either direction
  const existing = await getFriendStatusWith(friendUserId);
  if (existing?.status === "accepted") throw new Error("Ja és amic");
  if (existing?.status === "pending") {
    throw new Error(
      existing.direction === "outgoing"
        ? "Sol·licitud ja enviada"
        : "Tens una sol·licitud pendent d'aquest usuari",
    );
  }
  const { error } = await (supabase as any)
    .from("friends")
    .insert({ user_id: uid, friend_id: friendUserId, status: "pending" });
  if (error) {
    if (error.code === "23505" || /duplicate|unique/i.test(error.message)) {
      throw new Error("Sol·licitud ja existent");
    }
    console.error("[friends] addFriendDirect failed", error);
    throw new Error(error.message || "Error enviant sol·licitud");
  }
}

export async function addFriendByCodeDirect(code: string) {
  const c = code.trim().toUpperCase();
  const { data, error } = await supabase
    .from("profiles")
    .select("user_id")
    .eq("friend_code", c)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data?.user_id) throw new Error("Usuari no trobat");
  await addFriendDirect(data.user_id);
}

export async function addFriendByUsernameDirect(username: string) {
  const v = username.trim();
  const { data, error } = await supabase
    .from("profiles")
    .select("user_id")
    .ilike("username", v)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data?.user_id) throw new Error("Usuari no trobat");
  await addFriendDirect(data.user_id);
}

/**
 * Respon una sol·licitud entrant.
 *  - accept=true  → UPDATE status='accepted'
 *  - accept=false → DELETE row
 *
 * `friendshipId` is the synthetic id `${user_id}:${friend_id}` produced by useFriends.
 */
export async function respondFriendRequest(friendshipId: string, accept: boolean) {
  const [requesterId, recipientId] = friendshipId.split(":");
  if (!requesterId || !recipientId) throw new Error("Sol·licitud no vàlida");
  const { data: auth } = await supabase.auth.getUser();
  const uid = auth.user?.id;
  if (!uid) throw new Error("Has d'iniciar sessió");
  if (uid !== recipientId) throw new Error("No pots respondre a aquesta sol·licitud");

  if (accept) {
    const { error } = await (supabase as any)
      .from("friends")
      .update({ status: "accepted" })
      .eq("user_id", requesterId)
      .eq("friend_id", recipientId);
    if (error) throw new Error(error.message);
  } else {
    const { error } = await (supabase as any)
      .from("friends")
      .delete()
      .eq("user_id", requesterId)
      .eq("friend_id", recipientId);
    if (error) throw new Error(error.message);
  }
}

/**
 * Elimina qualsevol relació (acceptada o sol·licitud enviada) amb l'altre usuari.
 */
export async function removeFriend(friendUserId: string) {
  const { data: auth } = await supabase.auth.getUser();
  const uid = auth.user?.id;
  if (!uid) throw new Error("Has d'iniciar sessió");
  const { error } = await (supabase as any)
    .from("friends")
    .delete()
    .or(
      `and(user_id.eq.${uid},friend_id.eq.${friendUserId}),and(user_id.eq.${friendUserId},friend_id.eq.${uid})`,
    );
  if (error) throw new Error(error.message);
}