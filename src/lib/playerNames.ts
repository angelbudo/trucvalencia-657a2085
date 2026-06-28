// Helper: lookup the latest "Nom de Jugador" chosen for play (stored on
// room_players.name) for a list of user_ids or device_ids. Falls back to
// empty Map silently if RLS blocks the read — callers should default to
// the profile display_name in that case.
import { supabase } from "@/integrations/supabase/client";

export async function fetchPlayerNamesByUserIds(userIds: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const ids = Array.from(new Set(userIds.filter(Boolean)));
  if (ids.length === 0) return out;
  try {
    const { data, error } = await (supabase as any)
      .from("room_players")
      .select("name, profile_user_id, last_seen")
      .in("profile_user_id", ids)
      .order("last_seen", { ascending: false });
    if (error || !data) return out;
    for (const row of data as Array<{ name: string; profile_user_id: string | null }>) {
      if (!row.profile_user_id) continue;
      if (!out.has(row.profile_user_id) && row.name) out.set(row.profile_user_id, row.name);
    }
  } catch { /* noop */ }
  return out;
}

export async function fetchPlayerNamesByDevices(deviceIds: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const ids = Array.from(new Set(deviceIds.filter(Boolean)));
  if (ids.length === 0) return out;
  try {
    const { data, error } = await (supabase as any)
      .from("room_players")
      .select("name, device_id, last_seen")
      .in("device_id", ids)
      .order("last_seen", { ascending: false });
    if (error || !data) return out;
    for (const row of data as Array<{ name: string; device_id: string }>) {
      if (!out.has(row.device_id) && row.name) out.set(row.device_id, row.name);
    }
  } catch { /* noop */ }
  return out;
}