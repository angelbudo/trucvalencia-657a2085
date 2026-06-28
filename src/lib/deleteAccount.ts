/**
 * Client wrapper for the `delete-account` edge function.
 *
 * Compleix dos requisits:
 *  1. Google Play Store (User Data deletion, exigit des de 2024).
 *  2. Dret de supressió RGPD (art. 17).
 *
 * S'usa des de:
 *  - `Ajustes.tsx` → botó "Esborrar les meues dades" dins de l'app.
 *  - `EsborrarDades.tsx` → pàgina pública /esborrar-dades, l'enllaç que
 *    declarem a la fitxa de Google Play (data deletion URL).
 */
import { supabase } from "@/integrations/supabase/client";

export interface DeleteAccountResult {
  ok: true;
  dryRun?: boolean;
  deleted: Record<string, number>;
  anonymized: Record<string, number>;
}

export async function requestAccountDeletion(args: {
  deviceId: string;
  dryRun?: boolean;
}): Promise<DeleteAccountResult> {
  const { deviceId, dryRun = false } = args;
  if (!deviceId) throw new Error("deviceId requerit");

  // Dry-run: compte directament contra la BD (no depèn de cap Edge Function).
  if (dryRun) {
    const countFor = async (
      table: "player_profiles" | "room_players" | "sala_chat" | "room_text_chat",
    ): Promise<number> => {
      const { count, error } = await supabase
        .from(table)
        .select("device_id", { count: "exact", head: true })
        .eq("device_id", deviceId);
      if (error) return 0;
      return count ?? 0;
    };
    const [pp, rp, sc, rtc] = await Promise.all([
      countFor("player_profiles"),
      countFor("room_players"),
      countFor("sala_chat"),
      countFor("room_text_chat"),
    ]);
    return {
      ok: true,
      dryRun: true,
      deleted: {
        player_profiles: pp,
        room_players: rp,
        sala_chat: sc,
      },
      anonymized: {
        room_text_chat: rtc,
      },
    };
  }

  // Esborrat directe contra la BD (sense Edge Function). Les polítiques RLS
  // han de permetre a l'usuari esborrar les seues pròpies files (per device_id
  // o auth.uid()). Comptem primer per retornar quantitats fiables.
  const countFor = async (
    table: "player_profiles" | "room_players" | "sala_chat" | "room_text_chat",
  ): Promise<number> => {
    const { count, error } = await supabase
      .from(table)
      .select("device_id", { count: "exact", head: true })
      .eq("device_id", deviceId);
    if (error) return 0;
    return count ?? 0;
  };
  const [ppCount, rpCount, scCount, rtcCount] = await Promise.all([
    countFor("player_profiles"),
    countFor("room_players"),
    countFor("sala_chat"),
    countFor("room_text_chat"),
  ]);

  // DELETE directes filtrats per device_id.
  const deletes = await Promise.all([
    supabase.from("player_profiles").delete().eq("device_id", deviceId),
    supabase.from("room_players").delete().eq("device_id", deviceId),
    supabase.from("sala_chat").delete().eq("device_id", deviceId),
  ]);
  for (const r of deletes) {
    if (r.error) throw new Error(r.error.message);
  }

  // Anonimitzem el chat de partida: mantenim el text, substituïm el device_id
  // per un valor sentinella (la columna no admet NULL).
  const { error: anonErr } = await supabase
    .from("room_text_chat")
    .update({ device_id: "anonymized" })
    .eq("device_id", deviceId);
  if (anonErr) throw new Error(anonErr.message);

  // Si l'usuari està autenticat, tanquem sessió.
  try {
    const { data: sess } = await supabase.auth.getSession();
    if (sess.session) await supabase.auth.signOut();
  } catch { /* noop */ }

  return {
    ok: true,
    deleted: {
      player_profiles: ppCount,
      room_players: rpCount,
      sala_chat: scCount,
    },
    anonymized: {
      room_text_chat: rtcCount,
    },
  };
}

/** Esborra completament les dades locals (localStorage) del dispositiu.
 *  Es crida després d'un esborrat servidor exitós dins de l'app per deixar
 *  el dispositiu en estat "primera obertura". */
export function wipeLocalDeviceData(): void {
  if (typeof window === "undefined") return;
  try {
    // Esborrem totes les claus de l'app (prefixades amb "truc:").
    const keys: string[] = [];
    for (let i = 0; i < window.localStorage.length; i++) {
      const k = window.localStorage.key(i);
      if (k && k.startsWith("truc:")) keys.push(k);
    }
    for (const k of keys) window.localStorage.removeItem(k);
  } catch {
    /* noop — entorns sense localStorage (mode privat estricte) */
  }
}