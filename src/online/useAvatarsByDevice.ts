import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";

/**
 * Caché global d'avatars per a evitar parpalleigs quan es navega entre
 * pantalles que mostren els mateixos jugadors (Sales, Lobby, Sala, Partida).
 * La caché persisteix durant tota la vida de l'app i s'actualitza en segon pla.
 */
const avatarCache = new Map<string, string | null>();

/**
 * Resol avatar_url públic per a un conjunt de device_ids via RPC.
 * Reutilitzat per pantalles que mostren seients (Sala, Lobby, etc.).
 */
export function useAvatarsByDevice(
  profileUserIds: string[],
  userIdsByDevice: Record<string, string | null> = {},
  refreshKey = "",
): Record<string, string | null> {
  // Inicialització síncrona des de la caché global per a render instantani.
  const [map, setMap] = useState<Record<string, string | null>>(() => {
    const initial: Record<string, string | null> = {};
    for (const deviceId of Object.keys(userIdsByDevice)) {
      if (avatarCache.has(deviceId)) initial[deviceId] = avatarCache.get(deviceId) ?? null;
    }
    return initial;
  });
  const key = Array.from(new Set(profileUserIds.filter(Boolean)))
    .sort()
    .join("|") + `::${refreshKey}::` + Object.entries(userIdsByDevice)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([deviceId, userId]) => `${deviceId}:${userId ?? ""}`)
      .join("|");
  useEffect(() => {
    const ids = Array.from(new Set(profileUserIds.filter(Boolean)));
    const devices = Object.keys(userIdsByDevice).filter(Boolean);
    if (ids.length === 0 && devices.length === 0) {
      // No netejem la caché; mantenim el render anterior.
      return;
    }
    let alive = true;
    (async () => {
      // Comença des de la caché global perquè el primer render no pegue salts.
      const next: Record<string, string | null> = {};
      for (const deviceId of devices) {
        if (avatarCache.has(deviceId)) next[deviceId] = avatarCache.get(deviceId) ?? null;
      }
      // 1) Try to fetch by actual device IDs (the RPC joins to profiles by device).
      if (devices.length > 0) {
        try {
          const { data, error } = await supabase.rpc("get_public_avatars_by_devices", {
            p_device_ids: devices,
          });
          if (!error && data) {
            for (const row of data as Array<{ device_id: string; avatar_url: string | null }>) {
              next[row.device_id] = row.avatar_url ?? null;
            }
          }
        } catch (e) {
          console.warn("[avatars] bulk fetch failed", e);
        }
      }
      // 2) Fallback: per-profile lookup for any device that still has no avatar
      //    but does have a known profile_user_id.
      await Promise.all(Object.entries(userIdsByDevice).map(async ([deviceId, userId]) => {
        if (next[deviceId] || !userId) return;
        try {
          const { data: profile } = await supabase.rpc("get_public_player_profile_by_user_id", {
            p_user_id: userId,
          });
          const row = Array.isArray(profile) ? profile[0] : profile;
          next[deviceId] = (row as { avatar_url?: string | null } | null)?.avatar_url ?? null;
        } catch {
          next[deviceId] = null;
        }
      }));
      for (const deviceId of devices) next[deviceId] = next[deviceId] ?? null;

      // Actualitza la caché global perquè altres pantalles puguen reutilitzar-la.
      for (const [deviceId, url] of Object.entries(next)) avatarCache.set(deviceId, url);

      if (alive) setMap((prev) => ({ ...prev, ...next }));
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return map;
}