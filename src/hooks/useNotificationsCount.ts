import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { useFriends } from "@/lib/friends";

const db = supabase as any;
const LAST_SEEN_KEY = "broadcasts:lastSeenAt";

export function useNotificationsCount() {
  const { user, ready } = useAuth();
  const friends = useFriends();
  const [unreadMsgs, setUnreadMsgs] = useState(0);
  const [newBroadcasts, setNewBroadcasts] = useState(0);

  useEffect(() => {
    if (!ready) return;
    if (!user?.id) { setUnreadMsgs(0); setNewBroadcasts(0); return; }

    let alive = true;

    const load = async () => {
      const lastSeen = localStorage.getItem(LAST_SEEN_KEY) ?? "1970-01-01T00:00:00Z";
      const [m, b] = await Promise.all([
        db.from("user_messages").select("id", { count: "exact", head: true })
          .eq("receiver_id", user.id).is("read_at", null),
        db.from("admin_broadcasts").select("id", { count: "exact", head: true })
          .gt("created_at", lastSeen),
      ]);
      if (!alive) return;
      setUnreadMsgs(m.count ?? 0);
      setNewBroadcasts(b.count ?? 0);
    };

    void load();

    const ch = supabase
      .channel(`notif:${user.id}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "user_messages", filter: `receiver_id=eq.${user.id}` }, () => void load())
      .on("postgres_changes", { event: "*", schema: "public", table: "admin_broadcasts" }, () => void load())
      .subscribe();

    const onStorage = (e: StorageEvent) => { if (e.key === LAST_SEEN_KEY) void load(); };
    window.addEventListener("storage", onStorage);

    return () => { alive = false; supabase.removeChannel(ch); window.removeEventListener("storage", onStorage); };
  }, [user?.id, ready]);

  const friendReqs = friends.incoming.length;
  return unreadMsgs + newBroadcasts + friendReqs;
}

export function markBroadcastsSeen() {
  localStorage.setItem(LAST_SEEN_KEY, new Date().toISOString());
  window.dispatchEvent(new StorageEvent("storage", { key: LAST_SEEN_KEY }));
}