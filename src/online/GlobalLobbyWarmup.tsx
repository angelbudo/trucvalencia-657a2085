import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useLobbyPresence } from "@/online/useLobbyPresence";
import { LOBBY_ROOMS_QUERY_KEY, useLobbyRoomsLive } from "@/online/useLobbyRoomsLive";
import { listLobbyRooms } from "@/online/rooms.functions";
import { usePlayerIdentity } from "@/hooks/usePlayerIdentity";
import { useAuth } from "@/hooks/useAuth";
import { useAvatarsByDevice } from "@/online/useAvatarsByDevice";
import { warmupFriendIds, useFriendUserIds } from "@/lib/friends";
import { getRoomPlayerProfileUserId } from "@/online/types";

/**
 * Manté calents els canals i la caché del lobby durant tota la vida de l'app:
 *
 *  - Publica la presència del jugador al canal global `lobby:presence` des de
 *    que l'app munta (no només quan entra a Sales/Lobby).
 *  - Pre-carrega les mesas amb TanStack Query i les manté sincronitzades
 *    amb canvis Realtime de `rooms` i `room_players`.
 *  - Pre-carrega la llista d'amics de l'usuari logat (cache global a `friends.ts`).
 *  - Pre-resol els avatars de tots els jugadors visibles (presents + asseguts)
 *    perquè la pantalla de Sales pinte de manera instantània sense lag.
 */
export function GlobalLobbyWarmup() {
  const queryClient = useQueryClient();
  const { deviceId, name, hasName, ready } = usePlayerIdentity();
  const { user, ready: authReady } = useAuth();

  // 1) Publica la presència del jugador globalment (només si tenim deviceId).
  const onlinePlayers = useLobbyPresence({
    deviceId,
    name,
    roomCode: null,
    enabled: ready && hasName && !!deviceId,
    userId: user?.id ?? null,
  });

  // 2) Pre-carrega i manté viva la llista de mesas globalment.
  useEffect(() => {
    queryClient.prefetchQuery({
      queryKey: LOBBY_ROOMS_QUERY_KEY,
      queryFn: async () => {
        const { rooms } = await listLobbyRooms({ data: {} });
        return rooms;
      },
      staleTime: 15_000,
    });

    const invalidate = () => {
      queryClient.invalidateQueries({ queryKey: LOBBY_ROOMS_QUERY_KEY });
    };
    const channel = supabase
      .channel("lobby-rooms-warmup")
      .on("postgres_changes", { event: "*", schema: "public", table: "rooms" }, invalidate)
      .on("postgres_changes", { event: "*", schema: "public", table: "room_players" }, invalidate)
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, [queryClient]);

  // 3) Pre-carrega la llista d'amics tan aviat com sapiem l'usuari, i la
  //    deixa enganxada al hook (que ja s'auto-actualitza via Realtime).
  useFriendUserIds();
  useEffect(() => {
    if (!authReady) return;
    const uid = user?.id;
    if (!uid) return;
    (async () => {
      try {
        await warmupFriendIds(uid);
      } catch (e) {
        console.warn("[warmup] friends warmup failed", e);
      }
    })();
  }, [authReady, user?.id]);

  // 4) Pre-resol els avatars de tots els jugadors visibles als llistats de
  //    Sales/Lobby. Es nodreix de la presència en viu + les mesas en cache.
  //    `useAvatarsByDevice` escriu a `avatarCache` (mòdul global), de manera
  //    que quan Sales munta el seu propi hook, el render és instantani.
  const { rooms } = useLobbyRoomsLive();
  const deviceToUser: Record<string, string | null> = {};
  for (const r of rooms ?? []) {
    for (const p of r.players ?? []) {
      if (p.deviceId) deviceToUser[p.deviceId] = getRoomPlayerProfileUserId(p) ?? null;
    }
  }
  for (const p of onlinePlayers) {
    deviceToUser[p.deviceId] = p.userId ?? null;
  }
  const profileUserIds = Array.from(
    new Set(Object.values(deviceToUser).filter((id): id is string => !!id)),
  );
  const avatarsRefreshKey = Object.entries(deviceToUser)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([d, u]) => `${d}:${u ?? ""}`)
    .join("|");
  useAvatarsByDevice(profileUserIds, deviceToUser, avatarsRefreshKey);

  return null;
}