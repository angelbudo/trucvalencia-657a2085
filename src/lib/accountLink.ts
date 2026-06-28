import { supabase } from "@/integrations/supabase/client";

const DEVICE_KEY = "truc:device-id";

/**
 * Llegeix el device_id local actual (no en crea un de nou).
 */
export function getLocalDeviceId(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(DEVICE_KEY);
  } catch {
    return null;
  }
}

/**
 * Sobreescriu el device_id local. S'utilitza quan iniciem sessió en un
 * dispositiu nou i recuperem el device_id original associat al compte.
 */
export function setLocalDeviceId(id: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(DEVICE_KEY, id);
  } catch {
    /* noop */
  }
}

export type AccountLinkSyncResult = {
  changed: boolean;
  verified: boolean;
  /** Detall de la discrepància, si n'hi ha. */
  mismatch?: {
    reason: "missing-row" | "device-mismatch" | "no-local-device" | "verify-error";
    localDeviceId: string | null;
    remoteDeviceId: string | null;
    userId: string;
    message?: string;
  };
};

/**
 * Després d'iniciar sessió:
 *  - Si el compte ja té un device_id associat → l'adoptem localment
 *    (recuperem el progrés).
 *  - Si no en té (primer login) → guardem el device_id local actual.
 *
 * Després escriu, fa una RE-LECTURA de verificació per confirmar que
 * `account_links.device_id` per `user_id` coincideix amb el `device_id`
 * que hi ha a localStorage. Si hi ha discrepància, es registra un log
 * a consola (`[accountLink] mismatch …`) per facilitar el debug.
 */
export async function syncAccountLinkAfterLogin(): Promise<AccountLinkSyncResult> {
  const {
    data: { user },
  } = await supabase.auth.getUser();

  // Guarda estricta: mai intentar upsert si no hi ha usuari autenticat verificat
  if (!user?.id) {
    return { changed: false, verified: false };
  }

  const local = getLocalDeviceId();

  const { data: row } = await supabase
    .from("account_links")
    .select("device_id")
    .eq("user_id", user.id)
    .maybeSingle();

  let changed = false;

  // Cas 1: el compte ja tenia un device_id → recuperem-lo si difereix
  if (row?.device_id) {
    if (row.device_id !== local) {
      setLocalDeviceId(row.device_id);
      changed = true;
    }
  } else if (local) {
    // Cas 2: primer login → guardem el device_id local actual al compte
    await supabase
      .from("account_links")
      .upsert(
        { user_id: user.id, email: user.email ?? "", device_id: local },
        { onConflict: "user_id" },
      );

    // També forcem que el display_name del perfil siga el nom de jugador
    // guardat localment al dispositiu (i no el derivat del correu).
    try {
      const localName =
        typeof window !== "undefined"
          ? (window.localStorage.getItem("truc:player-name") || "").trim().slice(0, 24)
          : "";
      if (localName) {
        await supabase
          .from("profiles")
          .update({ display_name: localName })
          .eq("user_id", user.id);
      }
    } catch {
      /* noop */
    }
  }

  // ─── Verificació post-sync ────────────────────────────────────────────
  const expected = getLocalDeviceId();
  try {
    const { data: verifyRow, error: verifyErr } = await supabase
      .from("account_links")
      .select("device_id")
      .eq("user_id", user.id)
      .maybeSingle();

    if (verifyErr) {
      const mismatch = {
        reason: "verify-error" as const,
        localDeviceId: expected,
        remoteDeviceId: null,
        userId: user.id,
        message: verifyErr.message,
      };
      console.warn("[accountLink] verify error", mismatch);
      return { changed, verified: false, mismatch };
    }

    if (!verifyRow) {
      const mismatch = {
        reason: "missing-row" as const,
        localDeviceId: expected,
        remoteDeviceId: null,
        userId: user.id,
      };
      console.warn("[accountLink] mismatch: no account_links row", mismatch);
      return { changed, verified: false, mismatch };
    }

    if (!expected) {
      const mismatch = {
        reason: "no-local-device" as const,
        localDeviceId: null,
        remoteDeviceId: verifyRow.device_id ?? null,
        userId: user.id,
      };
      console.warn("[accountLink] mismatch: no local device_id", mismatch);
      return { changed, verified: false, mismatch };
    }

    if (verifyRow.device_id !== expected) {
      const mismatch = {
        reason: "device-mismatch" as const,
        localDeviceId: expected,
        remoteDeviceId: verifyRow.device_id ?? null,
        userId: user.id,
      };
      console.warn("[accountLink] mismatch: device_id divergent", mismatch);
      return { changed, verified: false, mismatch };
    }

    // ─── Sync player_profiles.user_id ─────────────────────────────────────
    // Vincula el perfil del dispositiu actual amb el compte autenticat
    // perquè la moderació puga aplicar-se per user_id encara que canvie
    // de dispositiu. Best-effort: si la columna no existeix o falla RLS,
    // no bloquegem el login.
    if (expected) {
      try {
        await (supabase.from("player_profiles") as any)
          .update({ user_id: user.id })
          .eq("device_id", expected);
      } catch (e) {
        console.warn("[accountLink] no s'ha pogut actualitzar player_profiles.user_id", e);
      }
    }

    console.info("[accountLink] verified ok", {
      userId: user.id,
      deviceId: expected,
      changed,
    });
    return { changed, verified: true };
  } catch (e) {
    const mismatch = {
      reason: "verify-error" as const,
      localDeviceId: expected,
      remoteDeviceId: null,
      userId: user.id,
      message: e instanceof Error ? e.message : String(e),
    };
    console.warn("[accountLink] verify threw", mismatch);
    return { changed, verified: false, mismatch };
  }
}