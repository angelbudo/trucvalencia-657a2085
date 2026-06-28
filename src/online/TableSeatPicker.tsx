import { Bot, User, UserPlus, Crown, KeyRound } from "lucide-react";
import { cn } from "@/lib/utils";
import type { PlayerId } from "@/game/types";
import type { SeatKind } from "./types";
import { PresenceDot } from "./PresenceDot";
import { getPresenceStatus, type PresenceStatus } from "./presence";
import { useT } from "@/i18n/useT";
import { PlayerProfileDialog } from "@/online/PlayerProfileDialog";
import { normalizeUserId, useFriendUserIds } from "@/lib/friends";
import { FriendBadge } from "@/components/FriendBadge";

/**
 * Vista d'una taula ovalada amb 4 muñequitos al voltant per triar
 * seient (estil Messenger). Sud i Nord queden enfrontats; Oest i Est
 * són els companys creuats.
 */

export type SeatOccupant =
  | {
      kind: "me";
      name: string;
      avatarUrl?: string | null;
      /** Identitat per obrir el perfil públic propi al clicar la bombolla. */
      userId?: string | null;
      deviceId?: string | null;
    }
  | {
      kind: "human";
      name: string;
      online?: boolean;
      /** Timestamp ISO del darrer heartbeat — permet derivar away/offline. */
      lastSeen?: string | null;
      avatarUrl?: string | null;
      /** Identitat per obrir el perfil públic al clicar la bombolla. */
      userId?: string | null;
      deviceId?: string | null;
    }
  | { kind: "bot"; avatarUrl?: string | null }
  | { kind: "empty"; private?: boolean };

export interface SeatInfo {
  seat: PlayerId;
  kind: SeatKind;
  occupant: SeatOccupant;
  /** Si és l'amfitrió (s'hi pinta una corona). */
  isHost?: boolean;
  /** Es pot clicar per accionar la callback (triar / alternar). */
  selectable?: boolean;
}

interface TableSeatPickerProps {
  seats: SeatInfo[]; // exactament 4, indexats per PlayerId
  onSeatClick?: (seat: PlayerId) => void;
  /** Marca el seient amb halo de "el teu". */
  highlightSeat?: PlayerId | null;
  /** Mostra etiquetes de teams (Nosaltres / Ells) sota cada seient. */
  showTeams?: boolean;
  /** Augmenta 2px només els textos propis de la taula/seients. */
  textSize?: "normal" | "large";
  /** Device del visitant: si coincideix amb l'occupant d'un seient, el clic
   *  sobre aquest seient no obre el diàleg de perfil sinó que executa
   *  `onSeatClick` (per a reentrada ràpida a la pròpia mesa). */
  myDeviceId?: string | null;
}

// Mapatge de seient lògic (0 sud, 1 oest, 2 nord, 3 est) a posició a la mesa.
// Volem 2 enfrontats (sud-nord) i 2 creuats als laterals (oest-est),
// igual que la taula real de la partida.
const POSITION_CLASSES: Record<PlayerId, string> = {
  0: "absolute left-1/2 -translate-x-1/2 bottom-0",
  1: "absolute left-0 top-1/2 -translate-y-1/2",
  2: "absolute left-1/2 -translate-x-1/2 top-0",
  3: "absolute right-0 top-1/2 -translate-y-1/2",
};

const TEAM_LABEL: Record<PlayerId, string> = {
  0: "Nosaltres",
  1: "Ells",
  2: "Nosaltres",
  3: "Ells",
};

export function TableSeatPicker({
  seats,
  onSeatClick,
  highlightSeat = null,
  showTeams = true,
  textSize = "normal",
  myDeviceId = null,
}: TableSeatPickerProps) {
  const friendIds = useFriendUserIds();

  return (
    <div className="relative w-full aspect-[4/3] max-w-sm mx-auto">
      {/* Taula ovalada */}
      <div className="absolute inset-x-[18%] inset-y-[22%] rounded-[50%] wood-surface border-2 border-primary/40 card-shadow" />
      <div className="absolute inset-x-[24%] inset-y-[28%] rounded-[50%] felt-surface border border-primary/25 overflow-hidden">
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
          <span className="font-display font-black italic text-primary/25 text-2xl uppercase tracking-widest select-none">
            Truc
          </span>
        </div>
      </div>

      {/* Seients */}
      {seats.map((s) => {
        // Excepció estricta: si l'occupant del seient és el propi visitant
        // (mateix deviceId), el clic SEMPRE executa `onSeatClick` — mai obre
        // el perfil flotant — per permetre re-entrada a la pròpia mesa.
        const isOwnOccupant =
          !!myDeviceId &&
          (s.occupant.kind === "human" || s.occupant.kind === "me") &&
          (s.occupant as { deviceId?: string | null }).deviceId === myDeviceId;
        const forceClickable = isOwnOccupant && !!onSeatClick;
        const clickable = s.selectable || forceClickable;
        return (
          <SeatBubble
            key={s.seat}
            info={s}
            highlighted={highlightSeat === s.seat}
            onClick={clickable ? () => onSeatClick?.(s.seat) : undefined}
            showTeam={showTeams}
            textSize={textSize}
            friendIds={friendIds}
            suppressProfile={isOwnOccupant}
          />
        );
      })}
    </div>
  );
}


function SeatBubble({
  info,
  highlighted,
  onClick,
  showTeam,
  textSize,
  friendIds,
  suppressProfile = false,
}: {
  info: SeatInfo;
  highlighted: boolean;
  onClick?: () => void;
  showTeam: boolean;
  textSize: "normal" | "large";
  friendIds: Set<string>;
  suppressProfile?: boolean;
}) {

  const { occupant, seat } = info;
  const team = seat % 2 === 0 ? "nos" : "ells";

  const ring =
    occupant.kind === "me"
      ? "border-primary bg-primary/20 text-primary shadow-[0_0_18px_hsl(var(--primary)/0.45)]"
      : occupant.kind === "human"
        ? "border-team-nos/70 bg-team-nos/15 text-team-nos"
        : occupant.kind === "bot"
          ? "border-primary/40 bg-background/60 text-foreground/80"
          : "border-dashed border-primary/40 bg-background/30 text-muted-foreground";

  const Icon = occupant.kind === "bot" ? Bot : occupant.kind === "empty" ? UserPlus : User;

  const avatarUrl =
    occupant.kind === "me" || occupant.kind === "human"
      ? (occupant.avatarUrl ?? null)
      : occupant.kind === "bot"
        ? (occupant.avatarUrl ?? null)
        : null;
  const hasAvatar = !!avatarUrl;

  const t = useT();
  const truncateName = (name: string) => (name.length > 20 ? `${name.slice(0, 20)}…` : name);
  const label =
    occupant.kind === "me"
      ? `${truncateName(occupant.name)} ${t("seat.me_suffix")}`
      : occupant.kind === "human"
        ? truncateName(occupant.name)
        : occupant.kind === "bot"
          ? t("seat.bot")
          : occupant.private
            ? "Privada"
            : t("seat.free");
  const isPrivateEmpty = occupant.kind === "empty" && !!occupant.private;

  const Tag = onClick ? "button" : "div";

  // Estat de presència derivat (només per a humans amb dades de seguiment).
  let presence: PresenceStatus | null = null;
  let presenceLastSeen: string | null = null;
  if (occupant.kind === "human") {
    const isOnline = occupant.online !== false;
    presenceLastSeen = occupant.lastSeen ?? null;
    presence = getPresenceStatus(isOnline, presenceLastSeen);
  } else if (occupant.kind === "me") {
    presence = "online";
  }

  const bubble = (
    <Tag
      type={onClick ? "button" : undefined}
      onClick={onClick}
      disabled={onClick ? false : undefined}
      className={cn(
        "relative w-16 h-16 rounded-full border-2 flex items-center justify-center transition-all",
        ring,
        highlighted && "ring-2 ring-primary/70 ring-offset-2 ring-offset-background",
        onClick && "hover:scale-105 hover:border-primary cursor-pointer active:scale-95",
        !onClick && "cursor-default",
        // Els avatars de perfil sempre es mostren a color i sense transparència.
        !hasAvatar && presence === "offline" && "opacity-50 grayscale",
        !hasAvatar && presence === "away" && "opacity-80",
      )}
      aria-label={t("seat.aria", { n: seat, label })}
    >
      {avatarUrl ? (
        <img
          src={avatarUrl}
          alt=""
          className="absolute inset-0 w-full h-full rounded-full object-cover opacity-100 grayscale-0 saturate-100 contrast-100"
          draggable={false}
        />
      ) : (
        <Icon className="w-7 h-7" strokeWidth={2.2} />
      )}
      {isPrivateEmpty && (
        <span
          className="absolute -top-3 left-1/2 -translate-x-1/2 z-10 w-6 h-6 rounded-full bg-background/80 border-2 border-primary flex items-center justify-center shadow"
          aria-label="Mesa protegida amb contrasenya"
          title="Mesa protegida amb contrasenya"
        >
          <KeyRound className="w-3.5 h-3.5 text-primary" strokeWidth={2.5} />
        </span>
      )}
      {info.isHost && (
        <Crown
          className="absolute -top-2 -right-2 w-4 h-4 drop-shadow"
          style={{ color: "hsl(45 90% 60%)", fill: "hsl(45 90% 60%)" }}
        />
      )}
      {presence && (
        <PresenceDot
          status={presence}
          lastSeen={presenceLastSeen}
          size={12}
          className="absolute -bottom-0.5 -right-0.5"
        />
      )}
      {occupant.kind === "human" && !!normalizeUserId(occupant.userId ?? null) && friendIds.has(normalizeUserId(occupant.userId ?? null)!) && (
        <FriendBadge
          variant="seat"
          className="absolute -top-2 -left-2 z-20 pointer-events-none"
          title="Amic"
        />
      )}
    </Tag>
  );

  const profileUserId =
    occupant.kind === "human" || occupant.kind === "me" ? (occupant.userId ?? null) : null;
  const profileDeviceId =
    occupant.kind === "human" || occupant.kind === "me" ? (occupant.deviceId ?? null) : null;
  const canOpenProfile = !onClick && !suppressProfile && !!(profileUserId || profileDeviceId);
  const profileFallbackName =
    occupant.kind === "human" || occupant.kind === "me" ? occupant.name : label;
  const interactive = canOpenProfile ? (
    <PlayerProfileDialog
      userId={profileUserId ?? undefined}
      deviceId={!profileUserId ? (profileDeviceId ?? undefined) : undefined}
      fallbackName={profileFallbackName}
      trigger={
        <button
          type="button"
          className="appearance-none bg-transparent p-0 border-0 cursor-pointer"
          aria-label={t("seat.aria", { n: seat, label })}
        >
          {bubble}
        </button>
      }
    />
  ) : (
    bubble
  );

  return (
    <div className={cn(POSITION_CLASSES[seat], "flex flex-col items-center gap-1")}>
      {interactive}
      <span
        className={cn(
          "font-display font-bold leading-tight text-center whitespace-nowrap",
          textSize === "large" ? "text-[13px]" : "text-[11px]",
          occupant.kind === "me" && "text-primary",
          occupant.kind === "human" && "text-foreground",
          occupant.kind === "bot" && "text-foreground/80",
          occupant.kind === "empty" && !isPrivateEmpty && "text-muted-foreground",
          isPrivateEmpty && "text-orange-500",
        )}
      >
        {isPrivateEmpty ? t("seat.private_label") : label}
      </span>
      {showTeam && (
        <span
          className={cn(
            "uppercase tracking-widest leading-none",
            textSize === "large" ? "text-[10px]" : "text-[8px]",
            team === "nos" ? "text-team-nos/80" : "text-team-ells/80",
          )}
        >
          {team === "nos" ? t("common.us") : t("common.them")}
        </span>
      )}
    </div>
  );
}