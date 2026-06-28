import { useCallback, useEffect, useState } from "react";

/** Mute LOCAL por sessionStorage. Oculta los mensajes de chat de un device
 *  durante la sesión actual del usuario. No persiste entre sesiones, no
 *  toca Supabase, no afecta al rival. */

const STORAGE_KEY = "truc.localMutedDevices";
const EVENT = "truc:localMuteChanged";

function load(): Set<string> {
  if (typeof window === "undefined") return new Set();
  try {
    const raw = window.sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return new Set();
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return new Set();
    return new Set(arr.filter((x) => typeof x === "string"));
  } catch {
    return new Set();
  }
}

function save(set: Set<string>) {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify([...set]));
    window.dispatchEvent(new CustomEvent(EVENT));
  } catch { /* ignore */ }
}

export function useLocalMute() {
  const [muted, setMuted] = useState<Set<string>>(() => load());

  useEffect(() => {
    const onChange = () => setMuted(load());
    if (typeof window === "undefined") return;
    window.addEventListener(EVENT, onChange);
    window.addEventListener("storage", onChange);
    return () => {
      window.removeEventListener(EVENT, onChange);
      window.removeEventListener("storage", onChange);
    };
  }, []);

  const toggle = useCallback((deviceId: string | null | undefined) => {
    if (!deviceId) return;
    const next = new Set(load());
    if (next.has(deviceId)) next.delete(deviceId);
    else next.add(deviceId);
    save(next);
    setMuted(next);
  }, []);

  const isMuted = useCallback(
    (deviceId: string | null | undefined) => !!deviceId && muted.has(deviceId),
    [muted],
  );

  return { muted, toggle, isMuted };
}