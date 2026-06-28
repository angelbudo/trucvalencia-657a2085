import { useMemo } from "react";
import { MatchState, PlayerId, nextPlayer, teamOf } from "@/game/types";
import { cn } from "@/lib/utils";
import { HelpCircle } from "lucide-react";
import { PresenceDot } from "@/online/PresenceDot";
import type { PresenceStatus } from "@/online/presence";
import { useT } from "@/i18n/useT";
import { PlayerProfileDialog } from "@/online/PlayerProfileDialog";
import { normalizeUserId, useFriendUserIds } from "@/lib/friends";
import { FriendBadge } from "@/components/FriendBadge";

const POSITION_KEY: Record<PlayerId, string> = {
  0: "common.you",
  1: "seat.right_rival",
  2: "common.partner",
  3: "seat.left_rival",
};

interface PlayerSeatProps {
  player: PlayerId;
  match: MatchState;
  position: "bottom" | "top" | "left" | "right";
  name?: string;
  cardCount?: number;
  isPendingResponder?: boolean;
  presence?: PresenceStatus | null;
  presenceLastSeen?: string | null;
  avatarUrl?: string | null;
  secondsLeft?: number | null;
  profileUserId?: string | null;
  profileDeviceId?: string | null;
  isSelf?: boolean;
  forceShowTimer?: boolean;
}

/**
 * Indicador de jugador unificat (online + local). Disposició vertical
 * estricta: temporitzador a dalt, avatar al mig (gran, amb borde d'equip),
 * nom a sota. Sense recuadre exterior.
 */
export function PlayerSeat({
  player,
  match,
  position,
  name,
  isPendingResponder,
  presence,
  presenceLastSeen,
  avatarUrl,
  secondsLeft,
  profileUserId,
  profileDeviceId,
  isSelf = false,
  forceShowTimer = false,
}: PlayerSeatProps) {
  const t = useT();
  const friendIds = useFriendUserIds();
  const realUserId = normalizeUserId(profileUserId);
  const showFriendBadge = useMemo(() => {
    if (!realUserId || friendIds.size === 0) return false;
    return friendIds.has(realUserId);
  }, [realUserId, friendIds]);
  const isTurn = match.round.turn === player;
  const team = teamOf(player);
  const isMa = nextPlayer(match.dealer) === player;
  // Icona "mà": al costat de l'avatar; el costat depèn de la posició visual
  // del seient per a que quede cap a l'interior de la mesa.
  const maIconSide: "left" | "right" = position === "right" ? "left" : "right";
  const maIcon = isMa ? (
    <span
      className={cn(
        "absolute top-1/2 -translate-y-1/2 text-base leading-none pointer-events-none z-20",
        maIconSide === "left" ? "right-full -mr-[7px]" : "left-full -ml-[7px]",
      )}
      aria-label="Mà"
      role="img"
    >
      ✋
    </span>
  ) : null;

  const displayName = name ?? t(POSITION_KEY[player]);
  const showTimer = (isTurn || forceShowTimer) && secondsLeft != null;

  const canOpenProfile = !!(profileUserId || profileDeviceId);

  const avatarCircle = (
    <div className="relative w-16 h-16 shrink-0 overflow-visible">
      {maIcon}
      <div
        className={cn(
          "relative w-16 h-16 rounded-full flex items-center justify-center font-display font-bold text-2xl overflow-hidden border-4 transition-all",
          team === "nos" ? "border-team-nos" : "border-team-ells",
          avatarUrl
            ? "bg-background/30"
            : team === "nos"
              ? "bg-team-nos text-white"
              : "bg-team-ells text-white",
          isTurn && "ring-2 ring-primary shadow-[0_0_18px_hsl(var(--primary)/0.55)] animate-pulse-gold",
          isPendingResponder && "ring-2 ring-primary/70",
          presence === "offline" && "opacity-60",
          canOpenProfile && "cursor-pointer hover:brightness-110",
        )}
      >
        {avatarUrl ? (
          <img src={avatarUrl} alt="" className="w-full h-full object-cover" draggable={false} />
        ) : (
          displayName[0]
        )}
      </div>
      {presence && (
        <PresenceDot
          status={presence}
          lastSeen={presenceLastSeen ?? null}
          size={12}
          className="absolute -bottom-0.5 -right-0.5 z-10"
        />
      )}
      {showFriendBadge && (
        <FriendBadge
          variant="seat"
          className="absolute -top-2 -left-2 z-50 pointer-events-none"
          title={t("friends.is_friend") || "Amic"}
        />
      )}
      {isPendingResponder && (
        <div
          className="absolute -top-2 -right-2 w-6 h-6 rounded-full bg-primary text-primary-foreground flex items-center justify-center shadow-md animate-bounce z-20"
          title="Pendent de respondre"
          aria-label="Pendent de respondre"
        >
          <HelpCircle className="w-4 h-4" strokeWidth={2.5} />
        </div>
      )}
    </div>
  );

  const body = (
    <div className="flex flex-col items-center gap-[2px] select-none">
      {/* Temporitzador SEMPRE a dalt */}
      <span
        className={cn(
          "text-[11px] font-mono tabular-nums leading-none h-4 flex items-center justify-center",
          showTimer ? "px-1.5 rounded-md bg-background" : "px-1.5",
          showTimer && secondsLeft! <= 10 ? "text-destructive font-semibold" : "text-muted-foreground",
          showTimer && secondsLeft! < 5 && "font-bold",
        )}
        aria-hidden={!showTimer}
      >
        {showTimer ? `${secondsLeft}s` : "\u00A0"}
      </span>
      {avatarCircle}
      {/* Nom SEMPRE a sota */}
      <span
        className={cn(
          "text-xs font-semibold whitespace-nowrap leading-tight text-center max-w-[110px] truncate px-1.5 py-0.5 rounded-md bg-background text-foreground",
        )}
      >
        {displayName}
      </span>
    </div>
  );

  if (!canOpenProfile) return body;
  return (
    <PlayerProfileDialog
      userId={profileUserId ?? undefined}
      deviceId={profileUserId ? undefined : (profileDeviceId ?? undefined)}
      fallbackName={displayName}
      trigger={
        <button
          type="button"
          className="appearance-none bg-transparent p-0 border-0 text-left focus:outline-none"
        >
          {body}
        </button>
      }
    />
  );
}