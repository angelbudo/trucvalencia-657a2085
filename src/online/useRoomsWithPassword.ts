import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";

/**
 * Retorna un Set<string> amb els IDs de meses que tenen contrasenya
 * (rooms.password no null/buit). S'actualitza en realtime cada cop que
 * canvia la taula `rooms`.
 */
export function useRoomsWithPassword(): Set<string> {
  const [ids, setIds] = useState<Set<string>>(new Set());

  useEffect(() => {
    let cancelled = false;
    const fetchAll = async () => {
      const { data, error } = await (supabase as any)
        .from("rooms")
        .select("id, password")
        .not("password", "is", null);
      if (cancelled || error || !data) return;
      const next = new Set<string>();
      for (const r of data as Array<{ id: string; password: string | null }>) {
        if (r.password && r.password.trim()) next.add(r.id);
      }
      setIds(next);
    };
    void fetchAll();

    const channel = supabase
      .channel("rooms-passwords")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "rooms" },
        () => { void fetchAll(); },
      )
      .subscribe();

    return () => {
      cancelled = true;
      supabase.removeChannel(channel);
    };
  }, []);

  return ids;
}