// Canal Realtime Presence per sala. Cada client (jugador o espectador)
// publica la seva identitat en `room:<roomId>` perquè la resta puga llistar
// qui està mirant la partida en directe (espectadors) sense haver de
// persistir res a la base de dades.
import { useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { backoffDelay } from "@/online/realtimeReconnect";

export interface RoomPresenceMember {
  deviceId: string;
  name: string;
  userId?: string | null;
  /** true si l'usuari està al canal però NO té asiento al room_players. */
  isSpectator: boolean;
}

interface PresenceMeta {
  deviceId: string;
  name: string;
  userId?: string | null;
  isSpectator: boolean;
  joinedAt: number;
}

/**
 * Subscriu el client al canal `room:<roomId>` i publica la seva identitat.
 * Retorna la llista de membres (humans) presents.
 *
 * Disseny anti-bucle:
 *  - La subscripció al canal es fa UNA SOLA VEGADA per `roomId` / `deviceId`
 *    (effect amb deps estables). No es re-subscriu quan canvien metadades
 *    com `name`, `userId` o `isSpectator`.
 *  - Les metadades dinàmiques s'actualitzen via un `useRef` + un effect
 *    separat que NOMÉS crida `ch.track(...)` sobre el canal ja subscrit.
 *    Així obrir el xat o re-renderitzar la mesa no causa flicker de presència.
 */
export function useRoomPresence({
  roomId,
  deviceId,
  name,
  userId = null,
  isSpectator,
  enabled = true,
}: {
  roomId: string | null;
  deviceId: string;
  name: string;
  userId?: string | null;
  isSpectator: boolean;
  enabled?: boolean;
}): RoomPresenceMember[] {
  const [members, setMembers] = useState<RoomPresenceMember[]>([]);

  // Ref amb les metadades dinàmiques actuals; el subscribe només llig d'ací.
  const metaRef = useRef<PresenceMeta>({
    deviceId,
    name,
    userId,
    isSpectator,
    joinedAt: Date.now(),
  });
  // Canal actiu (per re-track des de l'effect de metadades sense re-subscriure).
  const channelRef = useRef<ReturnType<typeof supabase.channel> | null>(null);
  const subscribedRef = useRef(false);

  // Manté metaRef al dia sense re-disparar la subscripció.
  metaRef.current = {
    deviceId,
    name,
    userId,
    isSpectator,
    joinedAt: metaRef.current.joinedAt, // preservem joinedAt original
  };

  useEffect(() => {
    if (!enabled || !roomId || !deviceId || !name) {
      setMembers([]);
      return;
    }
    let cancelled = false;
    const channelName = `room:${roomId}`;
    let attempts = 0;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

    const clearReconnect = () => {
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
    };

    const teardown = () => {
      const ch = channelRef.current;
      if (ch) {
        try { ch.untrack(); } catch { /* ignore */ }
        try { supabase.removeChannel(ch); } catch { /* ignore */ }
        channelRef.current = null;
      }
      subscribedRef.current = false;
    };

    const scheduleReconnect = () => {
      if (cancelled || reconnectTimer) return;
      const delay = backoffDelay(attempts++);
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        if (cancelled) return;
        teardown();
        connect();
      }, delay);
    };

    const connect = () => {
      if (cancelled) return;
      // joinedAt fresc per a aquesta connexió (no per re-renders).
      metaRef.current = { ...metaRef.current, joinedAt: Date.now() };
      const ch = supabase.channel(channelName, {
        config: { presence: { key: deviceId } },
      });
      channelRef.current = ch;
      subscribedRef.current = false;

      const sync = () => {
        if (cancelled) return;
        const state = ch.presenceState<PresenceMeta>();
        const seen = new Map<string, RoomPresenceMember>();
        for (const [key, metas] of Object.entries(state)) {
          const meta = metas[0];
          if (!meta || !meta.name) continue;
          seen.set(key, {
            deviceId: meta.deviceId ?? key,
            name: meta.name,
            userId: meta.userId ?? null,
            isSpectator: !!meta.isSpectator,
          });
        }
        setMembers(Array.from(seen.values()));
      };

      ch.on("presence", { event: "sync" }, sync)
        .on("presence", { event: "join" }, sync)
        .on("presence", { event: "leave" }, sync)
        .subscribe(async (status) => {
          if (cancelled) return;
          if (status === "SUBSCRIBED") {
            attempts = 0;
            subscribedRef.current = true;
            try {
              await ch.track({ ...metaRef.current } satisfies PresenceMeta);
            } catch {
              /* ignore */
            }
          } else if (
            status === "CLOSED" ||
            status === "CHANNEL_ERROR" ||
            status === "TIMED_OUT"
          ) {
            subscribedRef.current = false;
            scheduleReconnect();
          }
        });
    };

    connect();

    const onWake = () => {
      if (cancelled) return;
      // Force a clean resubscribe to recover from frozen WebSockets on mobile.
      clearReconnect();
      attempts = 0;
      teardown();
      connect();
    };
    const onVisible = () => {
      if (typeof document !== "undefined" && document.visibilityState === "visible") {
        onWake();
      }
    };
    if (typeof window !== "undefined") {
      window.addEventListener("online", onWake);
      window.addEventListener("focus", onWake);
      document.addEventListener("visibilitychange", onVisible);
    }

    return () => {
      cancelled = true;
      clearReconnect();
      teardown();
      if (typeof window !== "undefined") {
        window.removeEventListener("online", onWake);
        window.removeEventListener("focus", onWake);
        document.removeEventListener("visibilitychange", onVisible);
      }
    };
    // Dependencies INTENCIONADAMENT estables: només roomId/deviceId/enabled.
    // Les metadades dinàmiques (name, userId, isSpectator) s'actualitzen
    // al canal ja subscrit via l'effect següent, sense re-subscriure.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomId, deviceId, enabled]);

  // Re-track quan canvien metadades dinàmiques (nom, isSpectator, userId)
  // — però NOMÉS sobre el canal ja subscrit. Mai crea un canal nou ací.
  useEffect(() => {
    if (!enabled || !roomId || !deviceId || !name) return;
    const ch = channelRef.current;
    if (!ch || !subscribedRef.current) return;
    void ch
      .track({ deviceId, name, userId, isSpectator, joinedAt: metaRef.current.joinedAt } satisfies PresenceMeta)
      .catch(() => { /* ignore */ });
  }, [roomId, deviceId, name, userId, isSpectator, enabled]);

  return useMemo(() => members, [members]);
}