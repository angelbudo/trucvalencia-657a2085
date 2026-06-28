import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";

export interface LeaverPenaltyState {
  deviceId: string | null;
  userId: string | null;
  leaveCount: number;
  banCount: number;
  bannedUntil: number | null;
  isBanned: boolean;
  loaded: boolean;
}

interface DbRow {
  leave_count: number | null;
  ban_count: number | null;
  banned_until: string | null;
}

const empty = {
  leaveCount: 0,
  banCount: 0,
  bannedUntil: null as number | null,
  isBanned: false,
  loaded: false,
};

function rowState(r: DbRow | null): typeof empty {
  if (!r) return { ...empty, loaded: true };
  const bannedUntil = r.banned_until ? new Date(r.banned_until).getTime() : null;
  return {
    leaveCount: r.leave_count ?? 0,
    banCount: r.ban_count ?? 0,
    bannedUntil,
    isBanned: bannedUntil !== null && bannedUntil > Date.now(),
    loaded: true,
  };
}

function merge(a: typeof empty, b: typeof empty): typeof empty {
  const bannedUntil =
    a.bannedUntil !== null && b.bannedUntil !== null
      ? Math.max(a.bannedUntil, b.bannedUntil)
      : a.bannedUntil ?? b.bannedUntil;
  return {
    leaveCount: Math.max(a.leaveCount, b.leaveCount),
    banCount: Math.max(a.banCount, b.banCount),
    bannedUntil,
    isBanned: bannedUntil !== null && bannedUntil > Date.now(),
    loaded: a.loaded && b.loaded,
  };
}

/** Subscribe a leaver_penalty_device i leaver_penalty_account. */
export function useLeaverPenalty(
  deviceId: string | null,
  userId: string | null = null,
): LeaverPenaltyState {
  const [device, setDevice] = useState(empty);
  const [account, setAccount] = useState({ ...empty, loaded: true });

  // Dispatch un decay oportunista al carregar (idempotent).
  useEffect(() => {
    if (!deviceId && !userId) return;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    void (supabase as any).rpc("refresh_leaver_decay", {
      p_device_id: deviceId,
      p_user_id: userId,
    });
  }, [deviceId, userId]);

  // ---- leaver_penalty_device ----
  useEffect(() => {
    if (!deviceId) {
      setDevice({ ...empty, loaded: true });
      return;
    }
    let cancelled = false;
    const load = async () => {
      const { data } = await (supabase as unknown as {
        from: (t: string) => {
          select: (s: string) => {
            eq: (k: string, v: string) => {
              maybeSingle: () => Promise<{ data: DbRow | null }>;
            };
          };
        };
      })
        .from("leaver_penalty_device")
        .select("*")
        .eq("device_id", deviceId)
        .maybeSingle();
      if (!cancelled) setDevice(rowState(data ?? null));
    };
    void load();

    const channel = supabase.channel(
      `leaver-device-${deviceId}-${Math.random().toString(36).slice(2)}`,
    );
    channel.on(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      "postgres_changes" as any,
      {
        event: "*",
        schema: "public",
        table: "leaver_penalty_device",
        filter: `device_id=eq.${deviceId}`,
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (payload: any) => {
        if (cancelled) return;
        setDevice(rowState((payload?.new ?? null) as DbRow | null));
      },
    );
    channel.subscribe();

    return () => {
      cancelled = true;
      try { supabase.removeChannel(channel); } catch { /* noop */ }
    };
  }, [deviceId]);

  // ---- leaver_penalty_account ----
  useEffect(() => {
    if (!userId) {
      setAccount({ ...empty, loaded: true });
      return;
    }
    let cancelled = false;
    const load = async () => {
      const { data } = await (supabase as unknown as {
        from: (t: string) => {
          select: (s: string) => {
            eq: (k: string, v: string) => {
              maybeSingle: () => Promise<{ data: DbRow | null }>;
            };
          };
        };
      })
        .from("leaver_penalty_account")
        .select("*")
        .eq("user_id", userId)
        .maybeSingle();
      if (!cancelled) setAccount(rowState(data ?? null));
    };
    void load();

    const channel = supabase.channel(
      `leaver-account-${userId}-${Math.random().toString(36).slice(2)}`,
    );
    channel.on(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      "postgres_changes" as any,
      {
        event: "*",
        schema: "public",
        table: "leaver_penalty_account",
        filter: `user_id=eq.${userId}`,
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (payload: any) => {
        if (cancelled) return;
        setAccount(rowState((payload?.new ?? null) as DbRow | null));
      },
    );
    channel.subscribe();

    return () => {
      cancelled = true;
      try { supabase.removeChannel(channel); } catch { /* noop */ }
    };
  }, [userId]);

  // Tick per refrescar isBanned quan venç el rellotge
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => setTick((n) => (n + 1) % 1_000_000), 1000);
    return () => window.clearInterval(id);
  }, []);

  const merged = merge(device, account);
  return { deviceId, userId, ...merged };
}