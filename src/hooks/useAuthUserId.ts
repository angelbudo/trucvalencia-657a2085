import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";

/** Devuelve el user_id del usuario autenticado (o null) y se mantiene en
 *  sincronía con cambios de sesión (login / logout en otra pestaña, etc.). */
export function useAuthUserId(): string | null {
  const [userId, setUserId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      try {
        const { data } = await supabase.auth.getUser();
        if (!cancelled) setUserId(data.user?.id ?? null);
      } catch {
        if (!cancelled) setUserId(null);
      }
    })();

    const { data: sub } = supabase.auth.onAuthStateChange((_evt, session) => {
      setUserId(session?.user?.id ?? null);
    });

    return () => {
      cancelled = true;
      try { sub.subscription.unsubscribe(); } catch { /* noop */ }
    };
  }, []);

  return userId;
}