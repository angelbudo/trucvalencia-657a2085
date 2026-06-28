import { useEffect, useState, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";

export type InboxMessage = {
  id: string;
  sender_id: string | null;
  receiver_id: string;
  subject: string | null;
  content: string;
  created_at: string;
  read_at?: string | null;
  sender_display_name?: string | null;
  sender_username?: string | null;
};

export type AdminBroadcast = {
  id: string;
  subject: string | null;
  content: string;
  created_at: string;
};

type InboxSnapshot = {
  userId: string;
  messages: InboxMessage[];
  broadcasts: AdminBroadcast[];
  loadedAt: number;
};

const INBOX_CACHE_KEY = "truc:inbox-cache:v1";
let cachedInbox: InboxSnapshot | null = null;
let inflight: Promise<InboxSnapshot> | null = null;
const listeners = new Set<(snap: InboxSnapshot) => void>();

function readLS(): InboxSnapshot | null {
  try {
    if (typeof window === "undefined") return null;
    const raw = window.localStorage.getItem(INBOX_CACHE_KEY);
    return raw ? (JSON.parse(raw) as InboxSnapshot) : null;
  } catch { return null; }
}
function writeLS(snap: InboxSnapshot | null) {
  try {
    if (typeof window === "undefined") return;
    if (snap == null) window.localStorage.removeItem(INBOX_CACHE_KEY);
    else window.localStorage.setItem(INBOX_CACHE_KEY, JSON.stringify(snap));
  } catch { /* noop */ }
}

if (typeof window !== "undefined") {
  cachedInbox = cachedInbox ?? readLS();
}

/** Format remitent: "Display Name (username)" amb fallbacks. */
export function formatSender(displayName?: string | null, username?: string | null): string {
  const dn = (displayName ?? "").trim();
  const un = (username ?? "").trim();
  if (dn && un) return `${dn} (${un})`;
  if (dn) return dn;
  if (un) return un;
  return "Jugador";
}

async function fetchInbox(userId: string): Promise<InboxSnapshot> {
  const db = supabase as any;
  const [m, b] = await Promise.all([
    db.from("user_messages")
      .select("*")
      .eq("receiver_id", userId)
      .order("created_at", { ascending: false }),
    db.from("admin_broadcasts")
      .select("*")
      .order("created_at", { ascending: false }),
  ]);
  const rawMessages: InboxMessage[] = (m.data ?? []) as InboxMessage[];
  const senderIds = Array.from(
    new Set(rawMessages.map((x) => x.sender_id).filter((x): x is string => !!x)),
  );
  let profileMap = new Map<string, { display_name: string | null; username: string | null }>();
  if (senderIds.length > 0) {
    const { data: profs } = await db
      .from("profiles")
      .select("user_id, display_name, username")
      .in("user_id", senderIds);
    for (const p of (profs ?? []) as Array<{ user_id: string; display_name: string | null; username: string | null }>) {
      profileMap.set(p.user_id, { display_name: p.display_name, username: p.username });
    }
  }
  const messages = rawMessages.map((x) => {
    const p = x.sender_id ? profileMap.get(x.sender_id) : null;
    return {
      ...x,
      sender_display_name: p?.display_name ?? null,
      sender_username: p?.username ?? null,
    };
  });
  const snap: InboxSnapshot = {
    userId,
    messages,
    broadcasts: (b.data ?? []) as AdminBroadcast[],
    loadedAt: Date.now(),
  };
  cachedInbox = snap;
  writeLS(snap);
  for (const fn of listeners) fn(snap);
  return snap;
}

/** Carrega la bandeja d'entrada en segon pla. Idempotent: deduplica peticions. */
export function prefetchInbox(userId: string): Promise<InboxSnapshot> {
  if (inflight) return inflight;
  inflight = fetchInbox(userId).finally(() => { inflight = null; });
  return inflight;
}

export function getCachedInbox(userId: string): InboxSnapshot | null {
  if (cachedInbox && cachedInbox.userId === userId) return cachedInbox;
  return null;
}

export function useInbox(userId: string | null | undefined) {
  const [snap, setSnap] = useState<InboxSnapshot | null>(() =>
    userId ? getCachedInbox(userId) : null,
  );
  const [loading, setLoading] = useState<boolean>(() => !snap);

  const reload = useCallback(async () => {
    if (!userId) { setSnap(null); return; }
    setLoading(true);
    try {
      const next = await prefetchInbox(userId);
      setSnap(next);
    } finally {
      setLoading(false);
    }
  }, [userId]);

  useEffect(() => {
    if (!userId) return;
    const fn = (next: InboxSnapshot) => {
      if (next.userId === userId) setSnap(next);
    };
    listeners.add(fn);
    void reload();
    // Realtime: refresh inbox the instant a new message arrives or a broadcast is posted.
    const db = supabase as any;
    const channel = db
      .channel(`inbox-${userId}-${Math.random().toString(36).slice(2, 8)}`)
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "user_messages", filter: `receiver_id=eq.${userId}` },
        () => { void reload(); },
      )
      .on(
        "postgres_changes",
        { event: "DELETE", schema: "public", table: "user_messages", filter: `receiver_id=eq.${userId}` },
        () => { void reload(); },
      )
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "admin_broadcasts" },
        () => { void reload(); },
      )
      .subscribe();
    return () => {
      listeners.delete(fn);
      try { db.removeChannel(channel); } catch { /* ignore */ }
    };
  }, [userId, reload]);

  return {
    messages: snap?.messages ?? [],
    broadcasts: snap?.broadcasts ?? [],
    loading: loading && !snap,
    reload,
  };
}