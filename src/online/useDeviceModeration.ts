import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";

export interface DeviceModerationState {
  deviceId: string | null;
  userId: string | null;
  reportCount: number;
  banCount: number;
  bannedUntil: number | null; // ms epoch
  permanentBan: boolean;
  lastNotice: string | null;
  lastNoticeAt: number | null;
  isBanned: boolean;
  loaded: boolean;
}

interface DbRow {
  report_count: number | null;
  ban_count: number | null;
  banned_until: string | null;
  permanent_ban: boolean | null;
  last_notice: string | null;
  last_notice_at: string | null;
}

const empty: Omit<DeviceModerationState, "deviceId" | "userId"> = {
  reportCount: 0,
  banCount: 0,
  bannedUntil: null,
  permanentBan: false,
  lastNotice: null,
  lastNoticeAt: null,
  isBanned: false,
  loaded: false,
};

function rowState(r: DbRow | null): Omit<DeviceModerationState, "deviceId" | "userId"> {
  if (!r) return { ...empty, loaded: true };
  const bannedUntil = r.banned_until ? new Date(r.banned_until).getTime() : null;
  const permanent = r.permanent_ban === true;
  const isBanned = permanent || (bannedUntil !== null && bannedUntil > Date.now());
  return {
    reportCount: r.report_count ?? 0,
    banCount: r.ban_count ?? 0,
    bannedUntil,
    permanentBan: permanent,
    lastNotice: r.last_notice,
    lastNoticeAt: r.last_notice_at ? new Date(r.last_notice_at).getTime() : null,
    isBanned,
    loaded: true,
  };
}

/** Combina la fila de dispositivo y la de cuenta tomando lo más restrictivo. */
function merge(
  device: Omit<DeviceModerationState, "deviceId" | "userId">,
  account: Omit<DeviceModerationState, "deviceId" | "userId">,
): Omit<DeviceModerationState, "deviceId" | "userId"> {
  const permanentBan = device.permanentBan || account.permanentBan;
  const bannedUntil =
    device.bannedUntil !== null && account.bannedUntil !== null
      ? Math.max(device.bannedUntil, account.bannedUntil)
      : device.bannedUntil ?? account.bannedUntil;
  const isBanned = permanentBan || (bannedUntil !== null && bannedUntil > Date.now());
  // El aviso más reciente entre ambos
  const useAccount =
    (account.lastNoticeAt ?? 0) >= (device.lastNoticeAt ?? 0) && account.lastNotice;
  return {
    reportCount: Math.max(device.reportCount, account.reportCount),
    banCount: Math.max(device.banCount, account.banCount),
    bannedUntil,
    permanentBan,
    lastNotice: useAccount ? account.lastNotice : device.lastNotice,
    lastNoticeAt: useAccount ? account.lastNoticeAt : device.lastNoticeAt,
    isBanned,
    loaded: device.loaded && account.loaded,
  };
}

/** Subscribe a la moderación del dispositivo Y de la cuenta autenticada. */
export function useDeviceModeration(
  deviceId: string | null,
  userId: string | null = null,
): DeviceModerationState {
  const [deviceState, setDeviceState] = useState(empty);
  const [accountState, setAccountState] = useState({ ...empty, loaded: true });

  // ---- device_moderation ----
  useEffect(() => {
    if (!deviceId) {
      setDeviceState({ ...empty, loaded: true });
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
        .from("device_moderation")
        .select("*")
        .eq("device_id", deviceId)
        .maybeSingle();
      if (!cancelled) setDeviceState(rowState(data ?? null));
    };
    void load();

    const channel = supabase.channel(
      `device-moderation-${deviceId}-${Math.random().toString(36).slice(2)}`,
    );
    channel.on(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      "postgres_changes" as any,
      {
        event: "*",
        schema: "public",
        table: "device_moderation",
        filter: `device_id=eq.${deviceId}`,
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (payload: any) => {
        if (cancelled) return;
        setDeviceState(rowState((payload?.new ?? null) as DbRow | null));
      },
    );
    channel.subscribe();

    return () => {
      cancelled = true;
      try { supabase.removeChannel(channel); } catch { /* noop */ }
    };
  }, [deviceId]);

  // ---- account_moderation ----
  useEffect(() => {
    if (!userId) {
      setAccountState({ ...empty, loaded: true });
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
        .from("account_moderation")
        .select("*")
        .eq("user_id", userId)
        .maybeSingle();
      if (!cancelled) setAccountState(rowState(data ?? null));
    };
    void load();

    const channel = supabase.channel(
      `account-moderation-${userId}-${Math.random().toString(36).slice(2)}`,
    );
    channel.on(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      "postgres_changes" as any,
      {
        event: "*",
        schema: "public",
        table: "account_moderation",
        filter: `user_id=eq.${userId}`,
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (payload: any) => {
        if (cancelled) return;
        setAccountState(rowState((payload?.new ?? null) as DbRow | null));
      },
    );
    channel.subscribe();

    return () => {
      cancelled = true;
      try { supabase.removeChannel(channel); } catch { /* noop */ }
    };
  }, [userId]);

  // Refresca isBanned cuando vencen las 24h
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => setTick((n) => (n + 1) % 1_000_000), 1000);
    return () => window.clearInterval(id);
  }, []);

  const merged = merge(deviceState, accountState);
  return { deviceId, userId, ...merged };
}