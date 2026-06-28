import { Button } from "@/components/ui/button";
import { RoomCodeLabel } from "@/online/RoomCodeLabel";
import { Mail, User } from "lucide-react";
import type { OnlinePlayer } from "./useLobbyPresence";
import { useT } from "@/i18n/useT";
import { PlayerProfileDialog } from "./PlayerProfileDialog";
import { usePlayerMiniStats } from "./usePlayerMiniStats";
import { PlayerMiniStatsRow } from "./PlayerMiniStats";
import { useFriendIdentityMatcher } from "@/lib/friends";
import { FriendBadge } from "@/components/FriendBadge";

interface Props {
  players: OnlinePlayer[];
  myDeviceId: string;
  /** Si es passa, el botó "Invitar" està disponible i crida aquesta funció. */
  onInvite?: (player: OnlinePlayer) => void;
  /** Filtrar jugadors que ja estan en aquesta taula (no es mostren com a invitables). */
  excludeDeviceIds?: string[];
  title?: string;
  emptyLabel?: string;
  /** Sense contorn ni fons de fusta. */
  bare?: boolean;
}

export function OnlinePlayersList({
  players,
  myDeviceId,
  onInvite,
  excludeDeviceIds = [],
  title = "Jugadors connectats",
  emptyLabel = "No hi ha ningú més connectat",
  bare = false,
}: Props) {
  const t = useT();
  const others = players.filter(
    (p) => p.deviceId !== myDeviceId && !excludeDeviceIds.includes(p.deviceId),
  );
  const { getResolvedUserId, isFriend } = useFriendIdentityMatcher(others);
  const getFriendRank = (player: OnlinePlayer) => (isFriend(player) ? 1 : 0);
  others.sort((a, b) => {
    const af = getFriendRank(a);
    const bf = getFriendRank(b);
    if (af !== bf) return bf - af;
    return a.name.localeCompare(b.name);
  });
  const { getStats } = usePlayerMiniStats(
    others.map((p) => ({ deviceId: p.deviceId, userId: getResolvedUserId(p) })),
  );

  const sectionClass = bare
    ? "p-1 flex flex-col gap-2"
    : "wood-surface border-2 border-primary/40 rounded-2xl p-3 flex flex-col gap-2";

  return (
    <section className={sectionClass}>
      {title ? (
        <div className="text-[14px] font-display tracking-widest uppercase text-primary/85 text-center leading-tight">
          {title} <span className="text-[14px] text-muted-foreground">({others.length})</span>
        </div>
      ) : null}
      {others.length === 0 ? (
        <p className="text-[11px] text-muted-foreground text-center py-2">{emptyLabel}</p>
      ) : (
        <ul className="flex flex-col gap-1.5 max-h-48 overflow-y-auto">
          {others.map((p) => {
            const busy = !!p.roomCode;
            const resolvedUserId = getResolvedUserId(p);
            const stats = getStats({ deviceId: p.deviceId, userId: resolvedUserId });
            const showFriendBadge = isFriend(p);
            return (
              <li
                key={p.deviceId}
                className="flex items-center gap-1.5 px-2 py-1.5 rounded-lg bg-background/30 border border-primary/20 min-w-0"
              >
                {showFriendBadge ? (
                  <FriendBadge variant="chat" className="shrink-0" />
                ) : (
                  <User className="w-3.5 h-3.5 text-primary/70 shrink-0" />
                )}
                <PlayerProfileDialog
                  userId={resolvedUserId ?? undefined}
                  deviceId={resolvedUserId ? undefined : p.deviceId}
                  fallbackName={p.name}
                  trigger={
                    <button
                      type="button"
                      className="text-[14px] text-foreground hover:underline focus:outline-none focus:underline text-left shrink-0 whitespace-nowrap"
                    >
                      {p.name}
                    </button>
                  }
                />
                <PlayerMiniStatsRow stats={stats} className="shrink-0" />
                {busy ? (
                  <RoomCodeLabel
                    code={p.roomCode ?? ""}
                    className="text-[13px] text-muted-foreground ml-auto w-[78px] text-center shrink-0"
                  />
                ) : onInvite ? (
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 py-0 px-2 text-[13px] border-primary/40 text-primary hover:bg-primary/10 shrink-0 ml-auto w-[78px]"
                    onClick={() => onInvite(p)}
                  >
                    <Mail className="w-3 h-3 mr-1" /> Invitar
                  </Button>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}