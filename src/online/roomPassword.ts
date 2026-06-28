// Helpers for password-protected rooms.
//
// IMPORTANT: per requisits de privacitat, NO es guarda mai cap rastre
// de contrasenyes introduïdes ni de l'estat de validació al client
// (ni localStorage, ni sessionStorage, ni cap variable global). Cada
// intent d'entrar a una mesa privada ha de tornar a demanar la
// contrasenya i validar-la en viu contra la base de dades a través de
// l'Edge Function `rooms-rpc`.

import { supabase } from "@/integrations/supabase/client";

/** Indica si una mesa té contrasenya (sense exposar quina). */
export async function isRoomPrivate(code: string): Promise<boolean> {
  const { data, error } = await (supabase as any)
    .from("rooms")
    .select("password")
    .eq("code", code.toUpperCase())
    .maybeSingle();
  if (error || !data) return false;
  const pwd = (data as { password?: string | null }).password;
  return !!(pwd && pwd.trim());
}

/**
 * Llegeix la contrasenya actual de la mesa (text pla) — només per a la UI
 * de l'amfitrió que ha d'editar-la. No s'ha de fer servir per validar
 * l'accés des del client: per a això, `verifyRoomPassword` ho valida en
 * viu contra la base de dades via Edge Function.
 */
export async function fetchRoomPassword(code: string): Promise<string | null> {
  const { data, error } = await (supabase as any)
    .from("rooms")
    .select("password")
    .eq("code", code.toUpperCase())
    .maybeSingle();
  if (error || !data) return null;
  const pwd = (data as { password?: string | null }).password;
  return pwd && pwd.trim() ? pwd : null;
}

/**
 * Valida en viu la contrasenya contra la base de dades via Edge Function.
 * No persisteix res al client.
 */
export async function verifyRoomPassword(code: string, password: string): Promise<boolean> {
  const { data, error } = await (supabase as any).functions.invoke("rooms-rpc", {
    body: { fn: "verifyRoomPassword", data: { code: code.toUpperCase(), password } },
  });
  if (error) {
    const ctx: any = (error as any).context;
    if (ctx && typeof ctx.json === "function") {
      try { await ctx.json(); } catch { /* noop */ }
    }
    return false;
  }
  if (data && typeof data === "object") {
    return !!(data as { ok?: boolean }).ok;
  }
  return false;
}

export async function setRoomPassword(roomId: string, deviceId: string, password: string | null) {
  const value = password && password.trim() ? password.trim() : null;
  const { data, error } = await (supabase as any).functions.invoke("rooms-rpc", {
    body: { fn: "setRoomPassword", data: { roomId, deviceId, password: value } },
  });
  if (error) {
    const ctx: any = (error as any).context;
    if (ctx && typeof ctx.json === "function") {
      try {
        const j = await ctx.json();
        if (j?.error) throw new Error(j.error);
      } catch (e) {
        if (e instanceof Error && e.message && e.message !== "Unexpected end of JSON input") throw e;
      }
    }
    throw new Error(error.message || "No s'ha pogut desar la contrasenya");
  }
  if (data && typeof data === "object" && "error" in data && (data as any).error) {
    throw new Error((data as any).error);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Compat shims: anteriorment la sessió cachejava la validació al sessionStorage.
// Ara són no-ops perquè volem demanar SEMPRE la contrasenya. Es mantenen els
// símbols per no trencar imports antics que encara puguin existir.

export function markRoomValidated(_code: string) { /* intencionalment buit */ }
export function isRoomValidated(_code: string): boolean { return false; }
export function clearRoomValidated(_code: string) { /* intencionalment buit */ }

// Neteja preventiva de qualsevol entrada antiga de sessió que pogués
// haver quedat de versions anteriors (clau: `room_pwd_ok:*`).
try {
  if (typeof window !== "undefined" && window.sessionStorage) {
    const ss = window.sessionStorage;
    const toDel: string[] = [];
    for (let i = 0; i < ss.length; i++) {
      const k = ss.key(i);
      if (k && k.startsWith("room_pwd_ok:")) toDel.push(k);
    }
    for (const k of toDel) ss.removeItem(k);
  }
} catch { /* noop */ }