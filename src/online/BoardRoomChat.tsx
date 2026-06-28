import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { RoomCodeLabel } from "@/online/RoomCodeLabel";
import { Flag, MessageCircle, Send, ShieldAlert, X } from "lucide-react";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { cn } from "@/lib/utils";
import { useT } from "@/i18n/useT";
import { useRoomTextChat } from "@/online/useRoomTextChat";
import { sendTextMessage } from "@/online/rooms.functions";
import { filterProfanity, loadBlacklistFromSupabase } from "@/online/profanityFilter";
import { supabase } from "@/integrations/supabase/client";
import { useLobbyPresence, type OnlinePlayer } from "@/online/useLobbyPresence";
import { PlayerProfileDialog } from "@/online/PlayerProfileDialog";
import { useAuth } from "@/hooks/useAuth";
import { usePlayerMiniStats } from "@/online/usePlayerMiniStats";
import { PlayerMiniStatsRow } from "@/online/PlayerMiniStats";
import type { PlayerId } from "@/game/types";
import type { RoomPlayerDTO } from "@/online/types";
import { toast } from "sonner";
import { normalizeUserId, useFriendUserIds } from "@/lib/friends";
import { FriendBadge } from "@/components/FriendBadge";

const MAX_LEN = 200;

interface Props {
  roomId: string | null;
  roomCode: string;
  deviceId: string;
  name: string;
  hasName: boolean;
  ready: boolean;
  mySeat: PlayerId | null;
  players: RoomPlayerDTO[];
  buttonClassName?: string;
  buttonTopPx?: number;
  salaSlug?: string | null;
}

function PlayersTopPanel({
  players,
  myDeviceId,
  seatedPlayers,
  currentRoomCode,
  headerExtra,
}: {
  players: OnlinePlayer[];
  myDeviceId: string;
  seatedPlayers: RoomPlayerDTO[];
  currentRoomCode: string;
  headerExtra?: ReactNode;
}) {
  const t = useT();
  const friendIds = useFriendUserIds();
  const seatedDeviceIds = new Set(seatedPlayers.map((p) => p.deviceId));
  const isSpectatorOfThisRoom = (p: OnlinePlayer) =>
    p.roomCode === currentRoomCode && !seatedDeviceIds.has(p.deviceId);
  const me = players.find((p) => p.deviceId === myDeviceId);
  const others = players.filter((p) => p.deviceId !== myDeviceId);
  const getFriendRank = (userId?: string | null) => {
    const normalizedUserId = normalizeUserId(userId);
    return normalizedUserId && friendIds.has(normalizedUserId) ? 1 : 0;
  };
  others.sort((a, b) => {
    const af = getFriendRank(a.userId);
    const bf = getFriendRank(b.userId);
    if (af !== bf) return bf - af;
    return a.name.localeCompare(b.name);
  });
  // Detecta jugadors asseguts a aquesta mesa que no apareixen al presence
  // global (estan desconnectats però encara reservats al seu seient). Els
  // afegim al llistat amb la mateixa opacitat que l'avatar de la taula
  // perquè es vegi clarament qui s'ha caigut.
  const presentDeviceIds = new Set(players.map((p) => p.deviceId));
  const offlineSeated = seatedPlayers
    .filter((p) => p.deviceId !== myDeviceId && !presentDeviceIds.has(p.deviceId) && !p.botified)
    .map((p) => ({
      deviceId: p.deviceId,
      name: p.name,
      userId: p.userId ?? null,
      roomCode: currentRoomCode,
      __offlineSeated: true as const,
    }));
  const list: (OnlinePlayer & { __offlineSeated?: boolean })[] = me
    ? [me, ...others, ...offlineSeated as any]
    : [...others, ...offlineSeated as any];
  const { getStats } = usePlayerMiniStats(
    list.map((p) => ({ deviceId: p.deviceId, userId: p.userId ?? null })),
  );

  return (
    <section
      className="rounded-t-lg border border-b-0 border-primary/30 bg-gray-200 text-background shadow-xl flex flex-col flex-[0_0_auto] h-[140px]"
      aria-label={t("players.connected")}
    >
      <div className="pl-2 pr-1 py-0 border-b border-primary/20 flex items-center gap-2 bg-background rounded-t-lg h-7 overflow-hidden">
        <span className="text-[14px] font-semibold text-primary flex-1 min-w-0 truncate">
          {t("players.connected")} <span className="text-[14px] font-normal">({list.length})</span>
        </span>
        {headerExtra && <div className="shrink-0 flex items-center -my-2">{headerExtra}</div>}
      </div>
      <div className="px-2 py-1.5 flex-1 min-h-0 overflow-y-auto chat-scroll text-[14px] space-y-0.5">
        {list.length === 0 ? (
          <p className="text-background/60 italic text-center py-2">
            {t("players.no_one_connected")}
          </p>
        ) : (
          list.map((p) => {
            const isMe = p.deviceId === myDeviceId;
            const stats = getStats({ deviceId: p.deviceId, userId: p.userId ?? null });
            const normalizedUserId = normalizeUserId(p.userId);
            const isFriend = !isMe && !!normalizedUserId && friendIds.has(normalizedUserId);
            const spectator = isSpectatorOfThisRoom(p);
            const nameWeightClass = spectator ? "font-normal" : "font-semibold";
            const spectatorSuffix = spectator ? (
              <span className="ml-1 font-normal text-background/70">
                ({t("table_chat.spectator")})
              </span>
            ) : null;
            const offlineSeated = !!(p as { __offlineSeated?: boolean }).__offlineSeated;
            return (
              <div
                key={p.deviceId}
                className="leading-snug flex items-center gap-1.5 min-w-0"
                style={offlineSeated ? { opacity: 0.6 } : undefined}
              >
                {isMe ? (
                  <span className={cn("inline-flex items-center text-background whitespace-nowrap", nameWeightClass)}>
                    {isFriend && (
                      <FriendBadge
                        variant="chat"
                        className="mr-1"
                        title={t("friends.is_friend") || "Amic"}
                      />
                    )}
                    <span className="whitespace-nowrap">
                      {p.name} {t("seat.me_suffix")}
                    </span>
                    {spectatorSuffix}
                  </span>
                ) : (
                  <span className="inline-flex items-center min-w-0">
                    <PlayerProfileDialog
                      userId={p.userId ?? undefined}
                      deviceId={p.userId ? undefined : p.deviceId}
                      fallbackName={p.name}
                      trigger={
                        <button
                          type="button"
                          className={cn(
                            "inline-flex items-center text-background hover:underline focus:outline-none focus:underline text-left whitespace-nowrap",
                            nameWeightClass,
                          )}
                        >
                          {isFriend && (
                            <FriendBadge
                              variant="chat"
                              className="mr-1"
                              title={t("friends.is_friend") || "Amic"}
                            />
                          )}
                          <span className="whitespace-nowrap">{p.name}</span>
                        </button>
                      }
                    />
                    {spectatorSuffix}
                  </span>
                )}
                <PlayerMiniStatsRow stats={stats} className="shrink-0" />
                {p.roomCode && !spectator && (
                  <RoomCodeLabel
                    code={p.roomCode}
                    className="text-[13px] text-background/60 ml-auto pl-1"
                  />
                )}
              </div>
            );
          })
        )}
      </div>
    </section>
  );
}


/** Xat propi d'una mesa (room_text_chat). Es reinicia automàticament quan
 *  la mesa es tanca i en crear-ne una nova (perquè canvia el roomId). */
export function BoardRoomChat({
  roomId,
  roomCode,
  deviceId,
  name,
  hasName,
  ready,
  mySeat,
  players,
  buttonClassName,
  buttonTopPx,
  salaSlug,
}: Props) {
  const t = useT();
  const messages = useRoomTextChat(roomId);
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [lastSeenId, setLastSeenId] = useState<number>(0);
  const scrollRef = useRef<HTMLDivElement>(null);

  const { user } = useAuth();
  const onlinePlayers = useLobbyPresence({
    deviceId,
    name,
    roomCode,
    salaSlug,
    enabled: ready && hasName,
    userId: user?.id ?? null,
    filterBySala: salaSlug ?? null,
  });

  useEffect(() => {
    if (messages.length > 0) {
      setLastSeenId((prev) => (prev === 0 ? messages[messages.length - 1].id : prev));
    }
  }, [roomId, messages.length]);

  useEffect(() => {
    if (open && messages.length > 0) {
      setLastSeenId(messages[messages.length - 1].id);
    }
  }, [open, messages]);

  useEffect(() => {
    const el = scrollRef.current;
    if (el && open) el.scrollTop = el.scrollHeight;
  }, [messages.length, open]);

  // Reset on room change
  useEffect(() => {
    setLastSeenId(0);
  }, [roomId]);

  // Carrega la llista negra de paraules des de Supabase (un sol cop).
  useEffect(() => {
    void loadBlacklistFromSupabase();
  }, []);

  const namesBySeat = new Map<PlayerId, string>();
  for (const p of players) namesBySeat.set(p.seat, p.name);

  const unreadCount = messages.reduce(
    (acc, m) =>
      m.id > lastSeenId && m.deviceId !== deviceId && m.seat !== mySeat
        ? acc + 1
        : acc,
    0,
  );

  const canSend = hasName && roomId != null; // espectadors també poden xatejar
  const inputDisabled = sending || !canSend;
  const placeholder = !hasName
    ? t("sala_chat.placeholder_no_name")
    : mySeat == null
      ? t("table_chat.placeholder")
      : t("table_chat.placeholder");

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (inputDisabled || !roomId) return;
    const trimmed = text.trim();
    if (!trimmed) return;
    setSending(true);
    try {
      // Si no estic assegut, sóc espectador: el servidor exigeix senderName.
      const senderName = mySeat == null ? (name || undefined) : undefined;
      const clean = filterProfanity(trimmed);
      await sendTextMessage({ data: { roomId, deviceId, text: clean, senderName } });
      setText("");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setSending(false);
    }
  };

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <Button
          size="icon"
          className={
            buttonClassName ??
            "fixed right-4 top-[54px] z-[55] h-12 w-12 rounded-full text-primary-foreground shadow-lg bg-accent"
          }
          style={buttonTopPx != null ? { top: `${buttonTopPx}px` } : undefined}
          aria-label={t("table_chat.aria_chat")}
          title={t("table_chat.aria_chat")}
        >
          <MessageCircle className="text-destructive-foreground w-[24px] h-[24px]" />
          {unreadCount > 0 && (
            <span
              className="absolute top-0 right-0 -translate-y-1/2 translate-x-1/2 min-w-[20px] h-5 px-1 rounded-full bg-destructive text-destructive-foreground text-[13px] font-bold flex items-center justify-center shadow mr-[7px] ml-0 mt-[6px]"
              aria-label={`${unreadCount} missatges no llegits`}
            >
              {unreadCount > 99 ? "99+" : unreadCount}
            </span>
          )}
        </Button>
      </SheetTrigger>
      <SheetContent
        side="right"
        overlayClassName="bg-black/25"
        className="w-[90vw] sm:max-w-[26.5rem] flex flex-col bg-transparent border-0 p-0 shadow-none mt-[90px] h-[calc(100vh-260px)] !right-auto !left-1/2 -translate-x-1/2 [&>button]:hidden z-[210]"
      >
        <SheetHeader className="sr-only">
          <SheetTitle>{t("table_chat.aria_chat")}</SheetTitle>
        </SheetHeader>
        <div className="flex-1 overflow-hidden px-0 py-[10px] flex flex-col min-h-0">
          <PlayersTopPanel
            players={onlinePlayers}
            myDeviceId={deviceId}
            seatedPlayers={players}
            currentRoomCode={roomCode}
            headerExtra={
              <SheetClose
                className="inline-flex items-center justify-center h-7 w-9 rounded-sm text-primary hover:opacity-80 focus:outline-none p-0"
                aria-label={t("common.close")}
              >
                <X className="h-7 w-7 -mr-[15px]" />
              </SheetClose>
            }
          />
          <section
            className="rounded-b-lg border border-primary/30 bg-gray-200 text-background shadow-xl flex flex-col flex-1 min-h-0"
            aria-label={t("table_chat.aria_chat")}
          >
            <div className="px-2 py-1 border-b border-primary/20 flex items-center gap-2 bg-background">
              <span className="text-[14px] font-semibold text-primary flex-1 min-w-0 truncate">
                {t("table_chat.header", { code: roomCode })}
              </span>
              <span className="text-[14px] text-primary shrink-0">
                {messages.length === 1
                  ? t("sala_chat.messages_singular", { n: messages.length })
                  : t("sala_chat.messages_plural", { n: messages.length })}
              </span>
            </div>
            <div
              ref={scrollRef}
              className="px-2 py-1.5 flex-1 min-h-0 overflow-y-auto chat-scroll text-[14px] space-y-0.5"
            >
              {messages.length === 0 ? (
                <p className="text-background/60 italic text-center py-2">
                  {t("table_chat.no_messages")}
                </p>
              ) : (
                messages.map((m) => {
                  const isSpectatorMsg = m.seat == null;
                  const isMine = !isSpectatorMsg && m.seat === mySeat;
                  const presenceName = m.deviceId
                    ? onlinePlayers.find((p) => p.deviceId === m.deviceId)?.name
                    : undefined;
                  const senderName = isSpectatorMsg
                    ? (m.senderName?.trim() || presenceName?.trim() || t("table_chat.spectator"))
                    : (namesBySeat.get(m.seat as PlayerId) ?? `${t("table_chat.seat", { n: (m.seat as number) + 1 })}`);
                  const handleReport = async () => {
                    if (!roomId || !m.deviceId || m.seat == null) return;
                    const confirmed = typeof window !== "undefined"
                      ? window.confirm(t("sala_chat.report_message", { name: senderName }))
                      : true;
                    if (!confirmed) return;
                    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
                    const payload: Record<string, unknown> = {
                      room_id: roomId,
                      target_seat: m.seat,
                      target_device_id: m.deviceId,
                      reporter_device_id: deviceId,
                      message_id: m.id,
                      message_text: m.text,
                      expires_at: expiresAt,
                    };
                    if (user?.id) payload.reporter_user_id = user.id;
                    const { error } = await (supabase.from("room_chat_flags") as any).insert(payload);
                    if (error) {
                      toast.error(error.message);
                    } else {
                      toast.success(t("sala_chat.report_dsa"));
                    }
                  };
                  return (
                    <div key={m.id} className="leading-snug flex items-start gap-1 group">
                      <div className="flex-1 min-w-0">
                        <span
                          className={cn(
                            "mr-1 text-background",
                            isSpectatorMsg ? "font-normal italic opacity-80" : "font-semibold",
                          )}
                        >
                          {senderName}
                          {isSpectatorMsg && (
                            <span className="ml-1 text-[12px] opacity-80">
                              ({t("table_chat.spectator")})
                            </span>
                          )}
                          :
                        </span>
                        <span className={cn("break-words", isSpectatorMsg ? "text-background/80" : "text-background")}>{filterProfanity(m.text, String(m.id))}</span>
                      </div>
                      {!isMine && !isSpectatorMsg && (
                        <button
                          type="button"
                          onClick={handleReport}
                          className="opacity-50 hover:opacity-100 text-background hover:text-destructive shrink-0 mt-0.5"
                          aria-label={t("sala_chat.report_message", { name: senderName })}
                          title={t("sala_chat.report_dsa")}
                        >
                          <Flag className="w-[14px] h-[14px]" />
                        </button>
                      )}
                    </div>
                  );
                })
              )}
            </div>
            <form
              onSubmit={handleSubmit}
              className="flex items-center gap-1 border-t border-primary/20 px-0.5 py-1 bg-background rounded-b-lg"
            >
              <Input
                value={text}
                onChange={(e) => setText(e.target.value.slice(0, MAX_LEN))}
                placeholder={placeholder}
                maxLength={MAX_LEN}
                disabled={inputDisabled}
                className="h-8 text-[14px] flex-1 bg-white text-background placeholder:text-background/50 border-primary/30"
                aria-label={t("table_chat.aria_message")}
              />
              <Link
                to={`/reportar?sala=${encodeURIComponent(roomCode)}`}
                className="h-8 w-8 shrink-0 inline-flex items-center justify-center rounded-md text-primary border border-primary hover:text-destructive hover:bg-destructive/10"
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
        </div>
      </SheetContent>
    </Sheet>
  );
}