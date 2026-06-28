import { useEffect, useState, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";

export interface UserStats {
  user_id: string;
  wins: number;
  losses: number;
  abandoned: number;
  current_streak: number;
  max_streak: number;
  xp: number;
  level: number;
}

export interface ProfileRow {
  user_id: string;
  display_name: string;
  friend_code: string;
  username: string | null;
  avatar_url: string | null;
  email: string | null;
}

/** XP necessària per pujar de `level` a `level+1` (acumulada des de l'inici de level). */
export function xpForNextLevel(level: number): number {
  return level * 100;
}

/** XP acumulada total per arribar a un determinat nivell des de zero. */
export function xpThresholdForLevel(level: number): number {
  if (level <= 1) return 0;
  // suma 1*100 + 2*100 + ... + (level-1)*100
  return (100 * (level - 1) * level) / 2;
}

export function progressInLevel(xp: number, level: number): { current: number; max: number; pct: number } {
  const base = xpThresholdForLevel(level);
  const max = xpForNextLevel(level);
  const current = Math.max(0, xp - base);
  const pct = max > 0 ? Math.min(100, Math.round((current / max) * 100)) : 0;
  return { current, max, pct };
}

/** Crida la RPC del backend per registrar el resultat d'una partida. */
export async function recordMatchResult(
  won: boolean,
  humanOpponents: number,
  botOpponents: number,
): Promise<UserStats | null> {
  try {
    const { data, error } = await supabase.rpc("record_match_result", {
      p_won: won,
      p_human_opponents: humanOpponents,
      p_bot_opponents: botOpponents,
    });
    if (error) {
      console.warn("[recordMatchResult]", error.message);
      return null;
    }
    return data as UserStats;
  } catch (e) {
    console.warn("[recordMatchResult]", e);
    return null;
  }
}

// In-memory + persisted cache so the profile/avatar render instantly on the
// next mount (Pantalla Principal, Perfil…) without an async round-trip.
const PROFILE_CACHE_KEY = "truc:my-profile-cache:v1";
const STATS_CACHE_KEY = "truc:my-stats-cache:v1";
let cachedProfile: ProfileRow | null = null;
let cachedStats: UserStats | null = null;
let cachedUserId: string | null = null;

function readLS<T>(key: string): T | null {
  try {
    if (typeof window === "undefined") return null;
    const raw = window.localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch { return null; }
}
function writeLS(key: string, value: unknown) {
  try {
    if (typeof window === "undefined") return;
    if (value == null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, JSON.stringify(value));
  } catch { /* noop */ }
}

// Hydrate caches synchronously on module load so the very first render of
// any component that uses `useMyProfile` already has data.
if (typeof window !== "undefined") {
  cachedProfile = cachedProfile ?? readLS<ProfileRow>(PROFILE_CACHE_KEY);
  cachedStats = cachedStats ?? readLS<UserStats>(STATS_CACHE_KEY);
  cachedUserId = cachedProfile?.user_id ?? null;
}

/** Permet a altres mòduls llegir el perfil cacheat sense React. */
export function getCachedProfile(): ProfileRow | null { return cachedProfile; }

export function useMyProfile() {
  const { user, ready } = useAuth();
  const [profile, setProfile] = useState<ProfileRow | null>(() =>
    cachedProfile && (!user || cachedProfile.user_id === user.id) ? cachedProfile : null,
  );
  const [stats, setStats] = useState<UserStats | null>(() =>
    cachedStats && (!user || cachedStats.user_id === user.id) ? cachedStats : null,
  );
  const [loading, setLoading] = useState(false);

  const reload = useCallback(async () => {
    if (!user) {
      cachedProfile = null; cachedStats = null; cachedUserId = null;
      writeLS(PROFILE_CACHE_KEY, null); writeLS(STATS_CACHE_KEY, null);
      setProfile(null); setStats(null); return;
    }
    setLoading(true);
    try {
      const [{ data: p }, { data: s }] = await Promise.all([
        supabase.from("profiles").select("*").eq("user_id", user.id).maybeSingle(),
        supabase.from("user_stats").select("*").eq("user_id", user.id).maybeSingle(),
      ]);
      const prof = (p as ProfileRow | null) ?? null;
      const st = (s as UserStats | null) ?? null;
      cachedProfile = prof; cachedStats = st; cachedUserId = user.id;
      writeLS(PROFILE_CACHE_KEY, prof);
      writeLS(STATS_CACHE_KEY, st);
      setProfile(prof);
      setStats(st);
    } finally {
      setLoading(false);
    }
  }, [user]);

  useEffect(() => {
    if (!ready) return;
    // Si el cache és d'un altre usuari, neteja immediatament.
    if (user && cachedUserId && cachedUserId !== user.id) {
      cachedProfile = null; cachedStats = null;
      setProfile(null); setStats(null);
    }
    void reload();
  }, [ready, reload, user]);

  return { profile, stats, loading, reload, user, ready };
}