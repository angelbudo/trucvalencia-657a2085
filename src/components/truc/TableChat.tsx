import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { BellOff, Flag, Send, ShieldAlert, ShieldCheck, ShieldOff, VolumeX } from "lucide-react";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { useT } from "@/i18n/useT";
import type { PlayerId } from "@/game/types";
import type { RoomTextMessage } from "@/online/useRoomTextChat";
import { TRUC_Z_INDEX } from "@/components/truc/layers";
import { formatChatFlagNotice, type ChatFlagNotice } from "@/online/chatFlagNotices";
import { PlayerProfileDialog } from "@/online/PlayerProfileDialog";
import { usePresenceNamesByDevice } from "@/online/useLobbyPresence";
import { useLocalMute } from "@/online/useLocalMute";
import { filterProfanity } from "@/online/profanityFilter";

const MAX_LEN = 200;

interface TableChatProps {
  messages: RoomTextMessage[];
  mySeat: PlayerId;
  seatNames: Record<PlayerId, string>;
  onSend: (text: string) => Promise<void>;
  /** Si és true, deshabilita l'input i el botó d'enviar (p.ex. en pausa). */
  disabled?: boolean;
  /** Codi de la sala, per a prerellenar el report DSA. */
  roomCode?: string;
  /** Map seient → ms epoch d'expiració del silenciament (només seients silenciats). */
  mutedSeatsExpiry?: Map<PlayerId, number>;
  /** ms epoch quan expira el meu silenciament (null si no estic silenciat). */
  myMuteExpiresAt?: number | null;
  /** Callback per silenciar (flag) un jugador. Si no es proveeix, el botó només
   *  obre el formulari de report DSA sense crear el flag. */
  onFlagSeat?: (
    seat: PlayerId,
    ctx?: { messageId?: number; messageText?: string },
  ) => Promise<void> | void;
  /** Indica si JO ja he flagejat aquest seient (per amagar el botó). */
  iAlreadyFlaggedSeat?: (seat: PlayerId) => boolean;
  /** Notificacions de moderació (silenci iniciat / ampliat / revisió). */
  flagNotices?: ChatFlagNotice[];
  /** Identitat per seient per a obrir el perfil al clicar el nom al xat. */
  seatIdentities?: Record<PlayerId, { userId?: string | null; deviceId?: string | null } | null>;
}

function formatRemaining(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

/** Mini-xat de text lliure que s'incrusta sota les cartes del jugador.
 *  Pensat per a la mesa online — manté l'historial visible i un input
 *  amb límit de 200 caràcters. Auto-scroll al darrer missatge.
 *
 *  Inclou flags moderadors: cada jugador pot silenciar (flag) un altre
 *  durant un temps mentre es revisa el seu contingut. */
export function TableChat({
  messages,
  mySeat,
  seatNames,
  onSend,
  disabled = false,
  roomCode,
  mutedSeatsExpiry,
  myMuteExpiresAt = null,
  onFlagSeat,
  iAlreadyFlaggedSeat,
  flagNotices,
  seatIdentities,
}: TableChatProps) {
  const t = useT();
  const presenceNamesByDevice = usePresenceNamesByDevice();
  const { toggle: toggleLocalMute, isMuted: isLocallyMuted } = useLocalMute();
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [flagging, setFlagging] = useState<PlayerId | null>(null);
  const [now, setNow] = useState<number>(() => Date.now());
  const scrollRef = useRef<HTMLDivElement>(null);

  // Filtra localmente los mensajes de devices silenciados por el usuario.
  // No afecta al rival ni a Supabase: es una vista local.
  const visibleMessages = useMemo(
    () => messages.filter((m) => !isLocallyMuted(m.deviceId)),
    [messages, isLocallyMuted],
  );

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [visibleMessages.length, flagNotices?.length]);

  // Tick to refresh mute countdowns.
  useEffect(() => {
    const hasMutes = (mutedSeatsExpiry && mutedSeatsExpiry.size > 0) || myMuteExpiresAt !== null;
    if (!hasMutes) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [mutedSeatsExpiry, myMuteExpiresAt]);

  const isMeMuted = myMuteExpiresAt !== null && myMuteExpiresAt > now;
  const myMuteRemaining = isMeMuted && myMuteExpiresAt ? myMuteExpiresAt - now : 0;
  const inputDisabled = disabled || sending || isMeMuted;

  const placeholder = useMemo(() => {
    if (isMeMuted) return t("table_chat.muted", { time: formatRemaining(myMuteRemaining) });
    if (disabled) return t("table_chat.paused");
    return t("table_chat.placeholder");
  }, [isMeMuted, myMuteRemaining, disabled, t]);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (inputDisabled) return;
    const trimmed = text.trim();
    if (!trimmed || sending) return;
    setSending(true);
    try {
      await onSend(trimmed);
      setText("");
    } finally {
      setSending(false);
    }
  };

  const handleFlag = async (
    seat: PlayerId,
    ctx?: { messageId?: number; messageText?: string },
  ) => {
    if (!onFlagSeat || flagging !== null) return;
    setFlagging(seat);
    try {
      await onFlagSeat(seat, ctx);
    } finally {
      setFlagging(null);
    }
  };

  return (
    <section
      className="relative mx-1 mb-2 rounded-lg border border-primary/30 bg-background/80 flex flex-col"
      style={{ zIndex: TRUC_Z_INDEX.tableChat }}
      aria-label={t("table_chat.aria_chat") }
    >
      {isMeMuted && (
        <div
          role="status"
          className="px-2 py-1 text-[13px] bg-destructive/15 text-destructive border-b border-destructive/30 flex items-center gap-1.5"
        >
          <ShieldOff className="w-[14px] h-[14px] shrink-0" />
          <span className="truncate">
            {t("table_chat.you_reported", { time: formatRemaining(myMuteRemaining) })}
          </span>
        </div>
      )}

      <div
        ref={scrollRef}
        className="px-1 py-1.5 max-h-24 overflow-y-auto text-[14px] space-y-0.5"
      >
        {visibleMessages.length === 0 && (!flagNotices || flagNotices.length === 0) ? (
          <p className="text-muted-foreground italic text-center py-1">
            {t("table_chat.no_messages")}
          </p>
        ) : (
          (() => {
            type Item =
              | { kind: "msg"; t: number; key: string; msg: typeof messages[number] }
              | { kind: "notice"; t: number; key: string; notice: ChatFlagNotice };
            const items: Item[] = [];
            for (const m of visibleMessages) items.push({ kind: "msg", t: m.createdAt, key: `m-${m.id}`, msg: m });
            for (const n of flagNotices ?? []) items.push({ kind: "notice", t: n.createdAt, key: `n-${n.id}`, notice: n });
            items.sort((a, b) => (a.t !== b.t ? a.t - b.t : a.key.localeCompare(b.key)));
            return items.map((it) => {
              if (it.kind === "notice") {
                const n = it.notice;
                const isReview = n.kind.startsWith("review-");
                const isApproved = n.kind === "review-approved-target" || n.kind === "review-approved-reporter";
                const isDismissed = n.kind === "review-dismissed-target" || n.kind === "review-dismissed-reporter";
                const Icon = isApproved ? ShieldOff : isDismissed ? ShieldCheck : VolumeX;
                const tone = isReview
                  ? (isDismissed
                      ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 border-emerald-500/30"
                      : "bg-destructive/10 text-destructive border-destructive/30")
                  : "bg-muted text-muted-foreground border-border";
                return (
                  <div
                    key={it.key}
                    role="status"
                    aria-live="polite"
                    data-testid={`chat-flag-notice-${n.kind}`}
                    className={cn(
                      "leading-snug flex items-start gap-1 px-1.5 py-0.5 rounded border italic",
                      tone,
                    )}
                  >
                    <Icon className="w-[14px] h-[14px] mt-0.5 shrink-0" />
                    <span className="flex-1 min-w-0 break-words">{formatChatFlagNotice(n)}</span>
                  </div>
                );
              }
              const m = it.msg;
              const isSpectatorMsg = m.seat == null;
              const isMine = !isSpectatorMsg && m.seat === mySeat;
              const presenceName = m.deviceId
                ? presenceNamesByDevice[m.deviceId]
                : undefined;
              const reportedNick = isSpectatorMsg
                ? (m.senderName?.trim() || presenceName?.trim() || t("table_chat.spectator"))
                : (seatNames[m.seat as PlayerId] ?? t("table_chat.seat", { n: (m.seat as number) + 1 }));
              const seatExpiry = !isSpectatorMsg ? (mutedSeatsExpiry?.get(m.seat as PlayerId) ?? 0) : 0;
              const seatMuted = seatExpiry > now;
              const seatRemaining = seatMuted ? seatExpiry - now : 0;
              const reportHref = `/reportar?sala=${encodeURIComponent(roomCode ?? "")}&reportat=${encodeURIComponent(reportedNick)}&contingut=${encodeURIComponent(m.text)}`;
              const alreadyFlaggedByMe = !isMine && !isSpectatorMsg && iAlreadyFlaggedSeat?.(m.seat as PlayerId) === true;
              const ident = !isSpectatorMsg ? (seatIdentities?.[m.seat as PlayerId] ?? null) : null;
              const nameNode = !isMine && !isSpectatorMsg && ident && (ident.userId || ident.deviceId) ? (
                <PlayerProfileDialog
                  userId={ident.userId ?? undefined}
                  deviceId={ident.userId ? undefined : (ident.deviceId ?? undefined)}
                  fallbackName={reportedNick}
                  trigger={
                    <button
                      type="button"
                      className={cn(
                        "font-semibold mr-1 hover:underline focus:outline-none focus:underline",
                        "text-foreground",
                      )}
                    >
                      {reportedNick}:
                    </button>
                  }
                />
              ) : (
                <span
                  className={cn(
                    "mr-1",
                    isSpectatorMsg
                      ? "font-normal text-muted-foreground italic"
                      : cn("font-semibold", isMine ? "text-primary" : "text-foreground"),
                  )}
                >
                  {reportedNick}
                  {isSpectatorMsg && (
                    <span className="ml-1 text-[12px] text-muted-foreground">
                      ({t("table_chat.spectator")})
                    </span>
                  )}
                  :
                </span>
              );
              return (
                <div key={it.key} className="leading-snug flex items-start gap-1 group">
                  <div className="flex-1 min-w-0">
                    {nameNode}
                    <span
                      className={cn(
                        "break-words",
                        isSpectatorMsg ? "text-foreground/70" : "text-foreground/90",
                      )}
                    >
                      {filterProfanity(m.text, String(m.id))}
                    </span>
                    {seatMuted && (
                      <span
                        className="ml-1 inline-flex items-center gap-0.5 text-[12px] px-1 py-0 rounded bg-destructive/20 text-destructive align-middle"
                        title={t("table_chat.muted_label")}
                      >
                        <VolumeX className="w-[12px] h-[12px]" />
                        {formatRemaining(seatRemaining)}
                      </span>
                    )}
                  </div>
                  {!isMine && !isSpectatorMsg && (
                    <div className="flex items-center gap-0.5 shrink-0 mt-0.5">
                      {m.deviceId && (
                        <button
                          type="button"
                          onClick={() => toggleLocalMute(m.deviceId)}
                          className="opacity-50 hover:opacity-100 text-muted-foreground hover:text-primary"
                          aria-label={t("table_chat.local_mute_aria", { name: reportedNick }) || `Silenciar ${reportedNick}`}
                          title={t("table_chat.local_mute_title") || "Silenciar localment (només per a tu)"}
                        >
                          <BellOff className="w-[14px] h-[14px]" />
                        </button>
                      )}
                      {onFlagSeat && !alreadyFlaggedByMe && !seatMuted && (
                        <button
                          type="button"
                          onClick={() => handleFlag(m.seat as PlayerId, { messageId: m.id, messageText: m.text })}
                          disabled={flagging !== null}
                          className="opacity-50 hover:opacity-100 text-muted-foreground hover:text-destructive disabled:opacity-30 disabled:cursor-wait"
                          aria-label={t("table_chat.mute_player", { name: reportedNick })}
                          title={t("table_chat.mute_5min")}
                        >
                          <VolumeX className="w-[14px] h-[14px]" />
                        </button>
                      )}
                      <Link
                        to={reportHref}
                        className="opacity-50 hover:opacity-100 text-muted-foreground hover:text-destructive"
                        aria-label={t("sala_chat.report_message", { name: reportedNick })}
                        title={t("sala_chat.report_dsa")}
                      >
                        <Flag className="w-[14px] h-[14px]" />
                      </Link>
                    </div>
                  )}
                </div>
              );
            });
          })()
        )}
      </div>
      <form
        onSubmit={handleSubmit}
        className="flex items-center gap-1 border-t border-primary/20 p-1"
      >
        <Input
          value={text}
          onChange={(e) => setText(e.target.value.slice(0, MAX_LEN))}
          placeholder={placeholder}
          maxLength={MAX_LEN}
          disabled={inputDisabled}
          className="h-8 text-[14px] flex-1 bg-background/80"
          aria-label={t("table_chat.aria_message")}
        />
        <Link
          to={`/reportar?sala=${encodeURIComponent(roomCode ?? "")}`}
          className="h-8 w-8 shrink-0 inline-flex items-center justify-center rounded-md text-muted-foreground hover:text-destructive hover:bg-destructive/10"
          aria-label={t("sala_chat.report_content")}
          title={t("table_chat.report_content_title")}
        >
          <ShieldAlert className="w-[16px] h-[16px]" />
        </Link>
        <Button
          type="submit"
          size="sm"
          variant="default"
          disabled={inputDisabled || !text.trim()}
          className="h-8 w-8 p-0 shrink-0"
          aria-label={t("table_chat.aria_send")}
        >
          <Send className="w-[16px] h-[16px]" />
        </Button>
      </form>
    </section>
  );
}