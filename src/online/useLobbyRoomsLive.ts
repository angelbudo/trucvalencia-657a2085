import { useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { listLobbyRooms, type LobbyRoomDTO } from "@/online/rooms.functions";

export const LOBBY_ROOMS_QUERY_KEY = ["lobby-rooms"] as const;

/**
 * Hook compartit que retorna la llista de mesas del lobby/sales amb:
 *  - Caché global (TanStack Query): la pantalla mostra a l'instant les
 *    últimes dades conegudes en canviar de ruta, sense parpalleig.
 *  - Suscripció Realtime contínua a `rooms` i `room_players`: qualsevol
 *    canvi a la BD invalida la query i es refà al moment.
 *
 * Tots els consumidors comparteixen la mateixa queryKey, de manera que un sol
 * fetch alimenta totes les pantalles que llisten mesas.
 */
export function useLobbyRoomsLive(): {
  rooms: LobbyRoomDTO[];
  loading: boolean;
  error: string | null;
  refresh: () => Promise<unknown>;
} {
  const queryClient = useQueryClient();

  const query = useQuery({
    queryKey: LOBBY_ROOMS_QUERY_KEY,
    queryFn: async () => {
      const { rooms } = await listLobbyRooms({ data: {} });
      return rooms;
    },
    // Mantenim les dades "fresques" un moment per evitar refetchs redundants
    // entre pantalles; el canal Realtime ja s'encarrega d'invalidar quan
    // qualsevol cosa canvi a la BD.
    staleTime: 15_000,
    gcTime: 5 * 60_000,
    refetchOnWindowFocus: true,
    placeholderData: (prev) => prev,
  });

  useEffect(() => {
    const invalidate = () => {
      queryClient.invalidateQueries({ queryKey: LOBBY_ROOMS_QUERY_KEY });
    };
    const channelName = `lobby-rooms-global:${Math.random().toString(36).slice(2)}`;
    const channel = supabase
      .channel(channelName)
      .on("postgres_changes", { event: "*", schema: "public", table: "rooms" }, invalidate)
      .on("postgres_changes", { event: "*", schema: "public", table: "room_players" }, invalidate)
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, [queryClient]);

  return {
    rooms: query.data ?? [],
    loading: query.isLoading && !query.data,
    error: query.error instanceof Error ? query.error.message : null,
    // Refresc profund: força un refetch immediat (no només marca com stale),
    // de manera que el botó de "Refrescar" sempre va a la BD i espera la
    // resposta abans de resoldre la promesa.
    refresh: () => queryClient.refetchQueries({ queryKey: LOBBY_ROOMS_QUERY_KEY }),
  };
}