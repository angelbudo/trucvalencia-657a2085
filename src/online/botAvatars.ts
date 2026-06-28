import type { PlayerId } from "@/game/types";
import type { SeatKind } from "./types";

/** Total bot avatars stored in the `bot-avatars` bucket as Bot1.jpg…Bot20.jpg. */
export const BOT_AVATAR_COUNT = 20;

const BUCKET_BASE =
  ((import.meta.env.VITE_SUPABASE_URL as string | undefined) ??
    "https://sgonrrtqdcwyajsmufhs.supabase.co") +
  "/storage/v1/object/public/bot-avatars";

/** URL pública d'un avatar concret (1..BOT_AVATAR_COUNT). */
export function botAvatarUrl(idx: number): string {
  const n = ((((idx - 1) % BOT_AVATAR_COUNT) + BOT_AVATAR_COUNT) % BOT_AVATAR_COUNT) + 1;
  return `${BUCKET_BASE}/Bot${n}.jpg`;
}

/** Hash determinista d'una cadena → enter no negatiu. */
function hashString(s: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/**
 * Assignació determinista d'avatars als seients tipus `bot` d'una sala.
 * - Mateix `roomId` + `seatKinds` ⇒ mateix mapatge en tots els clients.
 * - Mai no repeteix avatars entre bots de la mateixa mesa (fins a 20).
 */
export function getBotAvatarsBySeat(
  roomId: string,
  seatKinds: ReadonlyArray<SeatKind> | null | undefined,
): Record<PlayerId, string | null> {
  const out: Record<PlayerId, string | null> = { 0: null, 1: null, 2: null, 3: null };
  if (!seatKinds) return out;
  const used = new Set<number>();
  const seats: PlayerId[] = [0, 1, 2, 3];
  for (const seat of seats) {
    if (seatKinds[seat] !== "bot") continue;
    const start = hashString(`${roomId}:${seat}`) % BOT_AVATAR_COUNT;
    let pick = start;
    for (let i = 0; i < BOT_AVATAR_COUNT; i++) {
      const candidate = (start + i) % BOT_AVATAR_COUNT;
      if (!used.has(candidate)) {
        pick = candidate;
        break;
      }
    }
    used.add(pick);
    out[seat] = botAvatarUrl(pick + 1);
  }
  return out;
}