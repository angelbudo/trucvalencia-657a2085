import { useMemo } from "react";
import { useT } from "@/i18n/useT";
import type { PlayerId } from "@/game/types";
import type { RoomPlayerDTO } from "@/online/types";
import type { RoomPresenceMember } from "@/online/useRoomPresence";
import { cn } from "@/lib/utils";

interface Props {
  /** Jugadors realment asseguts a la mesa (font: room_players via RPC). */
  players: RoomPlayerDTO[];
  /** Membres del canal Realtime Presence per a aquesta sala. */
  presenceMembers: RoomPresenceMember[];
  /** Asiento del propi usuari (per marcar "(tu)"). */
  mySeat?: PlayerId | null;
  /** Device id propi (per marcar "(tu)" quan sóc espectador). */
  myDeviceId?: string;
  className?: string;
  title?: string;
  /** Compact: amaga el títol i comprimeix paddings. */
  compact?: boolean;
}

/**
 * Llista unificada "qui hi ha a la taula":
 *   - Primer els jugadors asseguts (ordenats per asiento) en negreta.
 *   - A sota, els espectadors (de Presence) sense negreta i amb "(espectador)".
 *
 * Els espectadors es deriven filtrant del canal de presència aquells
 * deviceId que no apareixen a `players` (els 4 asientos físics).
 */
export function RoomMembersPanel({
  players,
  presenceMembers,
  mySeat = null,
  myDeviceId,
  className,
  title,
  compact = false,
}: Props) {
  const t = useT();
  const seatedDevices = useMemo(() => new Set(players.map((p) => p.deviceId)), [players]);
  const orderedPlayers = useMemo(
    () => [...players].sort((a, b) => a.seat - b.seat),
    [players],
  );
  const spectators = useMemo(() => {
    const seen = new Set<string>();
    const out: RoomPresenceMember[] = [];
    for (const m of presenceMembers) {
      if (seatedDevices.has(m.deviceId)) continue; // ja apareix com a jugador
      if (seen.has(m.deviceId)) continue;
      seen.add(m.deviceId);
      out.push(m);
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }, [presenceMembers, seatedDevices]);

  const total = orderedPlayers.length + spectators.length;

  return (
    <section
      className={cn(
        "rounded-lg border border-primary/30 bg-background/70 flex flex-col",
        compact ? "p-1.5" : "p-2",
        className,
      )}
      aria-label={title ?? t("members.toggle")}
    >
      {!compact && (
        <header className="px-1 pb-1.5 flex items-center justify-between">
          <span className="text-[13px] font-display tracking-widest uppercase text-primary/85">
            {title ?? t("members.toggle")}
          </span>
          <span className="text-[12px] text-muted-foreground">({total})</span>
        </header>
      )}
      {total === 0 ? (
        <p className="text-[12px] text-muted-foreground italic text-center py-1">
          {t("members.empty")}
        </p>
      ) : (
        <ul className="flex flex-col gap-0.5 text-[14px]">
          {orderedPlayers.length > 0 && (
            <li className="text-[11px] uppercase tracking-wider text-muted-foreground/80 px-1 mt-0.5">
              {t("members.players_header")}
            </li>
          )}
          {orderedPlayers.map((p) => {
            const isMe = mySeat != null && p.seat === mySeat;
            return (
              <li
                key={`seat-${p.seat}`}
                className="px-1.5 py-0.5 rounded flex items-center gap-1.5 min-w-0"
              >
                <span className="text-[11px] font-mono text-muted-foreground w-4 text-right">
                  {p.seat + 1}
                </span>
                <span className="font-bold text-foreground truncate">
                  {p.name}
                  {isMe && <span className="ml-1 font-normal text-muted-foreground">(tu)</span>}
                </span>
                {!p.isOnline && (
                  <span className="ml-auto text-[11px] text-muted-foreground italic shrink-0">
                    offline
                  </span>
                )}
              </li>
            );
          })}
          {spectators.length > 0 && (
            <li className="text-[11px] uppercase tracking-wider text-muted-foreground/80 px-1 mt-1.5">
              {t("members.spectators_header")}
            </li>
          )}
          {spectators.map((s) => {
            const isMe = myDeviceId && s.deviceId === myDeviceId;
            return (
              <li
                key={`spec-${s.deviceId}`}
                className="px-1.5 py-0.5 rounded flex items-center gap-1.5 min-w-0"
              >
                <span className="text-[11px] font-mono text-muted-foreground w-4 text-right">
                  ·
                </span>
                <span className="font-normal text-foreground/80 truncate">
                  {s.name}{" "}
                  <span className="text-muted-foreground">({t("table_chat.spectator")})</span>
                  {isMe && <span className="ml-1 text-muted-foreground">(tu)</span>}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}