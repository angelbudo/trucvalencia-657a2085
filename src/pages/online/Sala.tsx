import { useNavigate, useParams, useSearchParams } from "@/lib/router-shim";
import { RoomCodeLabel } from "@/online/RoomCodeLabel";
import { useEffect, useRef, useState } from "react";
import { ClientOnly } from "@/components/ClientOnly";
import { Button } from "@/components/ui/button";
import { usePlayerIdentity } from "@/hooks/usePlayerIdentity";
import { useAdminPassword } from "@/hooks/useAdminPassword";
import { useAuth } from "@/hooks/useAuth";

import { useRoomRealtime } from "@/online/useRoomRealtime";
import { joinRoom, joinAsSpectator, startMatch, setSeatKind, leaveRoom, adminCloseRoom, setRoomSettings } from "@/online/rooms.functions";
import { cn } from "@/lib/utils";
import type { PlayerId } from "@/game/types";
import { Loader2, Copy, LogOut, Check, ShieldX, X } from "lucide-react";
import { TableSeatPicker, type SeatInfo } from "@/online/TableSeatPicker";
import { BoardRoomChat } from "@/online/BoardRoomChat";
import { toast } from "sonner";
import { useT } from "@/i18n/useT";
import { ShareAppButton } from "@/components/ShareAppButton";
import { useLobbyPresence, useOnlinePresenceLookup } from "@/online/useLobbyPresence";
import { useSendInvite } from "@/online/useInvites";
import { PlayerProfileDialog } from "@/online/PlayerProfileDialog";
import { salaForRoom } from "@/online/salaAssignment";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { isRoomPrivate, setRoomPassword, verifyRoomPassword, fetchRoomPassword } from "@/online/roomPassword";
import { RoomPasswordDialog } from "@/components/RoomPasswordDialog";
import { Input } from "@/components/ui/input";

import { usePlayerMiniStats } from "@/online/usePlayerMiniStats";
import { PlayerMiniStatsRow } from "@/online/PlayerMiniStats";
import { FriendBadge } from "@/components/FriendBadge";
import { useFriendIdentityMatcher } from "@/lib/friends";
import { useAvatarsByDevice } from "@/online/useAvatarsByDevice";
import { getRoomPlayerProfileUserId } from "@/online/types";
import { getBotAvatarsBySeat } from "@/online/botAvatars";
import { useSwipeLeft } from "@/hooks/useSwipeLeft";
import { useRoomPresence } from "@/online/useRoomPresence";
import { RoomMembersPanel } from "@/online/RoomMembersPanel";

function Loading() {
  return (
    <main className="min-h-screen flex items-center justify-center">
      <Loader2 className="w-6 h-6 animate-spin text-primary" />
    </main>
  );
}

function OnlineSalaPage() {
  return (
    <ClientOnly fallback={<Loading />}>
      <Sala />
    </ClientOnly>
  );
}

function Sala() {
  const { codi = "" } = useParams<{ codi: string }>();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const t = useT();
  const { deviceId, name, hasName, ready } = usePlayerIdentity();
  const code = codi.toUpperCase();
  const { data, error, loading, refresh } = useRoomRealtime(ready ? code : null, deviceId);
  const { password: adminPassword, isAdmin } = useAdminPassword();
  const { user } = useAuth();

  // Pantalla des d'on s'ha entrat a la mesa, per saber on tornar al sortir.
  // Possibles valors: "lobby" (+ sala=slug), "sales", "nou", "unir".
  // Per defecte tornem a l'inici.
  const fromParam = searchParams.get("from");
  const fromSala = searchParams.get("sala");
  const backHref = (() => {
    if (fromParam === "lobby" && fromSala) return `/online/lobby/${fromSala}`;
    if (fromParam === "sales") return "/online/sales";
    if (fromParam === "unir") return "/online/unir";
    return "/";
  })();

  useSwipeLeft(() => navigate(backHref));

  const [joining, setJoining] = useState(false);
  const [joinError, setJoinError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [copied, setCopied] = useState(false);
  const [closingAdmin, setClosingAdmin] = useState(false);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [pwdRequired, setPwdRequired] = useState<boolean>(false);
  const [pwdChecked, setPwdChecked] = useState(false);
  const [hostPwdInput, setHostPwdInput] = useState("");
  const [hostPwdSaved, setHostPwdSaved] = useState<string>("");
  const [hostPwdLoaded, setHostPwdLoaded] = useState(false);
  const [hostPwdSaving, setHostPwdSaving] = useState(false);
  const preserveSeatsForMatchRef = useRef(false);

  const salaSlug = code ? salaForRoom({ code }) : null;
  const onlinePlayers = useLobbyPresence({
    deviceId,
    name,
    roomCode: code,
    salaSlug,
    enabled: ready && hasName,
    userId: user?.id ?? null,
    filterBySala: salaSlug,
  });
  // Read-only presence lookup: works even without a player name (guest viewing)
  // so the green/online dot can still appear for other players at the table.
  const { deviceIds: onlineDeviceIds, userIds: onlineUserIds } = useOnlinePresenceLookup(ready);
  const sendInvite = useSendInvite({ fromDeviceId: deviceId, fromName: name, code });

  // Presència a nivell de sala: publica la nostra identitat al canal
  // `room:<id>` per a que la resta vegen qui hi és (incloent espectadors).
  const presenceMembers = useRoomPresence({
    roomId: data?.room.id ?? null,
    deviceId,
    name,
    userId: user?.id ?? null,
    // A Sala sempre sóc jugador (assegut o triant asiento), no espectador.
    isSpectator: false,
    enabled: ready && hasName,
  });

  // Password gate: SEMPRE demanem la contrasenya quan entrem a una mesa
  // privada (sense cache de validacions prèvies). L'amfitrió i qui ja
  // estigui assegut no han de passar el gate.
  useEffect(() => {
    if (!ready || !data || pwdChecked) return;
    if (data.room.hostDevice === deviceId || data.mySeat != null) {
      setPwdChecked(true); return;
    }
    isRoomPrivate(code).then((priv) => {
      if (priv) setPwdRequired(true);
      else setPwdChecked(true);
    }).catch(() => setPwdChecked(true));
  }, [ready, data, code, deviceId, pwdChecked]);

  useEffect(() => {
    if (!data || !hasName || joining) return;
    if (!pwdChecked) return;
    if (data.mySeat != null) return;
    if (data.room.status !== "lobby") return;
    const usedSeats = new Set(data.players.map((p) => p.seat));
    const freeHumanSeats = ([0, 1, 2, 3] as PlayerId[]).filter(
      (s) => data.room.seatKinds[s] === "human" && !usedSeats.has(s),
    );
    if (freeHumanSeats.length !== 1) return;
    setJoining(true);
    joinRoom({ data: { code, deviceId, name, profileUserId: user?.id ?? null, preferredSeat: freeHumanSeats[0] } })
      .then(() => refresh())
      .catch((e) => setJoinError(e instanceof Error ? e.message : String(e)))
      .finally(() => setJoining(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, hasName, name, deviceId, user?.id, code, joining]);

  useEffect(() => {
    if (data?.room.status === "playing" && data.mySeat != null) {
      preserveSeatsForMatchRef.current = true;
      navigate(`/online/partida/${code}`);
    }
    if (data?.room.status === "abandoned" || data?.room.status === "finished") {
      navigate(backHref);
    }
  }, [data, code, navigate, backHref]);

  // Si el jugador tanca la pestanya, abandona la taula (beacon) per a qualsevol
  // jugador assegut, no només l'amfitrió. Així el seient queda lliure i si era
  // l'únic ocupant, el servidor pot marcar la taula com a abandonada.
  const roomIdForUnload = data?.room.id;
  const roomStatusForUnload = data?.room.status;
  const mySeatForUnload = data?.mySeat;
  useEffect(() => {
    if (!roomIdForUnload || mySeatForUnload == null) return;
    if (roomStatusForUnload !== "lobby") return;
    const handleUnload = () => {
      if (preserveSeatsForMatchRef.current) return;
      const baseUrl = (import.meta.env.VITE_SUPABASE_URL as string | undefined) ?? "https://sgonrrtqdcwyajsmufhs.supabase.co";
      const url = `${baseUrl}/functions/v1/rooms-rpc`;
      const body = JSON.stringify({ fn: "leaveRoom", data: { roomId: roomIdForUnload, deviceId } });
      try {
        navigator.sendBeacon(url, new Blob([body], { type: "application/json" }));
      } catch { /* noop */ }
    };
    window.addEventListener("pagehide", handleUnload);
    window.addEventListener("beforeunload", handleUnload);
    return () => {
      window.removeEventListener("pagehide", handleUnload);
      window.removeEventListener("beforeunload", handleUnload);
    };
  }, [roomIdForUnload, roomStatusForUnload, mySeatForUnload, deviceId]);

  // Cleanup en navegar fora de la pantalla (SPA): si encara estic assegut en
  // una taula en lobby, allibera el seient. Així mai queda un seient zombi
  // quan l'usuari torna enrere, navega a una altra ruta, o hi ha un error
  // que el redirigeix.
  const leaveOnUnmountRef = useRef<{ roomId: string; status: string; seated: boolean } | null>(null);
  useEffect(() => {
    leaveOnUnmountRef.current = data
      ? { roomId: data.room.id, status: data.room.status, seated: data.mySeat != null }
      : null;
  }, [data]);
  useEffect(() => {
    return () => {
      const snap = leaveOnUnmountRef.current;
      if (preserveSeatsForMatchRef.current) return;
      if (!snap || !snap.seated) return;
      if (snap.status !== "lobby") return;
      // Disparem en paral·lel sendBeacon (garantit encara que el context JS
      // s'estigui desmuntant) i leaveRoom RPC (per rebre el resultat). Així
      // el seient queda lliure instantàniament tant si l'usuari prem enrere
      // com si tanca l'app o fa swipe.
      try {
        const baseUrl = (import.meta.env.VITE_SUPABASE_URL as string | undefined) ?? "https://sgonrrtqdcwyajsmufhs.supabase.co";
        const url = `${baseUrl}/functions/v1/rooms-rpc`;
        const body = JSON.stringify({ fn: "leaveRoom", data: { roomId: snap.roomId, deviceId } });
        navigator.sendBeacon(url, new Blob([body], { type: "application/json" }));
      } catch { /* noop */ }
      leaveRoom({ data: { roomId: snap.roomId, deviceId } }).catch(() => { /* noop */ });
    };
  }, [deviceId]);

  // Carregar la contrasenya actual de la mesa per a l'amfitrió (només una vegada).
  const isHostForPwd = data?.room.hostDevice === deviceId;
  useEffect(() => {
    if (!ready || !data || !isHostForPwd || hostPwdLoaded) return;
    if (data.room.status !== "lobby") return;
    fetchRoomPassword(code)
      .then((pwd) => {
        const val = pwd ?? "";
        setHostPwdSaved(val);
        setHostPwdInput(val);
      })
      .catch(() => {})
      .finally(() => setHostPwdLoaded(true));
  }, [ready, data, isHostForPwd, hostPwdLoaded, code]);


  const humanProfileUserIds = (data?.players ?? [])
    .filter((p) => data?.room.seatKinds[p.seat] === "human")
    .map((p) => getRoomPlayerProfileUserId(p))
    .filter((id): id is string => !!id);
  const seatedPlayersRefreshKey = (data?.players ?? [])
    .filter((p) => data?.room.seatKinds[p.seat] === "human")
    .map((p) => `${p.seat}:${p.deviceId}:${getRoomPlayerProfileUserId(p) ?? ""}`)
    .sort()
    .join("|");
  const avatarsByDevice = useAvatarsByDevice(
    humanProfileUserIds,
    Object.fromEntries((data?.players ?? [])
      .filter((p) => p.deviceId)
      .map((p) => [p.deviceId, getRoomPlayerProfileUserId(p)])),
    seatedPlayersRefreshKey,
  );

  if (!ready || loading) return <Loading />;

  if (error) {
    return (
      <main className="min-h-screen flex flex-col items-center justify-center gap-3 px-5">
        <p className="text-destructive text-sm text-center">{error}</p>
        <Button onClick={() => navigate(backHref)} variant="outline">{t("common.back_home")}</Button>
      </main>
    );
  }
  if (!data) return <Loading />;

  const { room, players } = data;
  const isPlaying = room.status === "playing";
  const isHost = room.hostDevice === deviceId;
  const expectedHumans = room.seatKinds.filter((k) => k === "human").length;
  const joinedHumans = players.length;
  const totalSeated = players.length + room.seatKinds.filter((k) => k === "bot").length;
  const tableFull = totalSeated >= 4;
  const canStart = isHost && joinedHumans >= expectedHumans && room.status === "lobby";
  const seatedDeviceIds = players.map((p) => p.deviceId);
  const hasFreeHumanSeat = ([0, 1, 2, 3] as PlayerId[]).some(
    (s) => room.seatKinds[s] === "human" && !players.some((p) => p.seat === s),
  );
  const canInvite = isHost && room.status === "lobby" && hasFreeHumanSeat;



  const handlePickSeat = async (seat: PlayerId) => {
    if (isPlaying) return;
    // Si sóc l'amfitrió i el seient és humà i està buit, el converteixo a bot
    if (isHost && room.status === "lobby" && room.seatKinds[seat] === "human" && !players.some((p) => p.seat === seat)) {
      try {
        await setSeatKind({ data: { roomId: room.id, deviceId, seat, kind: "bot" } });
        await refresh();
      } catch (e) {
        setJoinError(e instanceof Error ? e.message : String(e));
      }
      return;
    }
    // Si sóc l'amfitrió i toco un seient bot, el torne a humà (lliure)
    if (isHost && room.status === "lobby" && room.seatKinds[seat] === "bot") {
      try {
        await setSeatKind({ data: { roomId: room.id, deviceId, seat, kind: "human" } });
        await refresh();
      } catch (e) {
        setJoinError(e instanceof Error ? e.message : String(e));
      }
      return;
    }
    if (!hasName) { setJoinError(t("sala.need_name")); return; }
    if (data.mySeat != null) return;
    if (room.seatKinds[seat] !== "human") return;
    if (players.some((p) => p.seat === seat)) return;
    setJoining(true);
    setJoinError(null);
    try {
      const result = await joinRoom({ data: { code, deviceId, name, profileUserId: user?.id ?? null, preferredSeat: seat } });
      if (result.seat == null && result.isSpectator) {
        navigate(`/online/partida/${code}?spectator=1`);
        return;
      }
      await refresh();
    } catch (e) {
      setJoinError(e instanceof Error ? e.message : String(e));
    } finally {
      setJoining(false);
    }
  };

  const handleSpectate = async () => {
    setJoining(true);
    setJoinError(null);
    try {
      await joinAsSpectator({ data: { code, deviceId } });
      navigate(`/online/partida/${code}?spectator=1`);
    } catch (e) {
      setJoinError(e instanceof Error ? e.message : String(e));
    } finally {
      setJoining(false);
    }
  };

  const botAvatars = getBotAvatarsBySeat(room.id, room.seatKinds);
  const seats: SeatInfo[] = ([0, 1, 2, 3] as PlayerId[]).map((seat) => {
    const kind = room.seatKinds[seat];
    const occupant = players.find((p) => p.seat === seat);
    const isMe = occupant?.deviceId === deviceId;
    const isHostSeat = occupant?.deviceId === room.hostDevice;
    if (kind === "bot") {
      return {
        seat,
        kind,
        occupant: { kind: "bot", avatarUrl: botAvatars[seat] ?? null },
        selectable: isHost && room.status === "lobby",
      };
    }
    if (occupant) {
      const avatarUrl = avatarsByDevice[occupant.deviceId] ?? null;
      const profUserId = getRoomPlayerProfileUserId(occupant);
      const presenceOnline =
        onlineDeviceIds.has(occupant.deviceId) ||
        (!!profUserId && onlineUserIds.has(profUserId)) ||
        onlinePlayers.some(
          (p) => p.deviceId === occupant.deviceId || (!!profUserId && p.userId === profUserId),
        );
      const effectiveOnline = occupant.isOnline || presenceOnline;
      return {
        seat,
        kind,
        occupant: isMe
          ? { kind: "me", name: occupant.name, avatarUrl, userId: user?.id ?? null, deviceId: occupant.deviceId }
          : {
              kind: "human",
              name: occupant.name,
              online: effectiveOnline,
              lastSeen: occupant.lastSeen,
              avatarUrl,
              userId: profUserId,
              deviceId: occupant.deviceId,
            },
        isHost: isHostSeat,
        selectable: false,
      };
    }
    const isPrivateRoom = !!pwdRequired || !!(hostPwdSaved && hostPwdSaved.trim());
    return {
      seat,
      kind,
      occupant: { kind: "empty", private: isPrivateRoom },
      selectable: room.status === "lobby" && (isHost || (data.mySeat == null && hasName)),
    };
  });


  const handleStart = async () => {
    setStarting(true);
    try {
      preserveSeatsForMatchRef.current = true;
      await startMatch({ data: { roomId: room.id, deviceId } });
    } catch (e) {
      preserveSeatsForMatchRef.current = false;
      setJoinError(e instanceof Error ? e.message : String(e));
      setStarting(false);
    }
  };

  const handleCloseTable = async () => {
    try {
      await leaveRoom({ data: { roomId: room.id, deviceId } });
      navigate(backHref);
    } catch (e) {
      setJoinError(e instanceof Error ? e.message : String(e));
    }
  };

  const copyCode = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch { /* noop */ }
  };

  return (
    <main className="menu-screen min-h-screen flex flex-col items-center px-5 py-4">
      <div className="w-full max-w-md flex-1 flex flex-col">
        <div className="flex items-center justify-between">
          <ShareAppButton />
          <Button
            onClick={async () => {
              if (data?.room && data.mySeat != null && data.room.status === "lobby") {
                try { await leaveRoom({ data: { roomId: data.room.id, deviceId } }); } catch { /* noop */ }
              }
              navigate(backHref);
            }}
            size="sm"
            variant="outline"
            className="h-8 w-8 p-0 border-foreground/80 text-foreground hover:bg-foreground/10"
            aria-label={t("common.back_home")}
            title={t("common.back_home")}
          >
            <LogOut className="w-4 h-4" />
          </Button>
        </div>

        <div className="flex-1 flex flex-col justify-center gap-5 py-4">



        <header className="text-center flex flex-col items-center gap-2">
          <div className="inline-flex items-center gap-3">
            <h1 className="font-title font-black italic text-gold text-3xl sm:text-4xl">{t("sala.table")}</h1>
            <button
              type="button"
              onClick={copyCode}
              className="inline-flex items-center gap-2 px-3 py-1.5 rounded-xl border-2 border-primary/60 bg-background/40 hover:bg-primary/10"
              aria-label={t("sala.copy_code")}
              title={t("sala.copy_code_short")}
            >
              <span className="sala-code-title font-title font-black italic text-primary text-3xl sm:text-4xl">{code}</span>
              {copied ? <Check className="w-5 h-5 text-team-nos" /> : <Copy className="w-5 h-5 text-primary/70" />}
            </button>
          </div>
          <p className="text-[13px] text-[#c2b9a3] mb-[30px]">{t("sala.share_code")}</p>
        </header>

        {!hasName && (
          <section className="wood-surface border-2 border-destructive/50 rounded-2xl p-3 flex items-center justify-between gap-3">
            <p className="text-xs text-foreground">Configura el teu nom per asseure't</p>
            <Button size="sm" variant="outline" onClick={() => navigate("/ajustes")} className="border-primary/40">
              Ajustes
            </Button>
          </section>
        )}

        <section className="flex flex-col gap-3">
          {isPlaying && (
            <div className="mx-auto inline-flex items-center justify-center rounded-md border border-destructive/40 bg-background/40 px-3 py-1 text-xs font-display font-bold uppercase tracking-wider text-destructive">
              {t("lobby.in_play")}
            </div>
          )}
          {data.mySeat == null && hasName && room.status === "lobby" && !isHost && (
            <p className="text-sm text-muted-foreground text-center">{t("sala.choose_seat")}</p>
          )}
          {isHost && room.status === "lobby" && (
            <p className="text-sm text-muted-foreground text-center mb-5">
              {t("sala.host_seat_hint")}
            </p>
          )}
          <TableSeatPicker
            seats={seats}
            onSeatClick={handlePickSeat}
            highlightSeat={data.mySeat}
            textSize="large"
          />
          {isPlaying && data.mySeat == null && (
            <Button
              type="button"
              size="lg"
              className="home-cta-btn w-full min-h-12 h-auto py-2 bg-accent text-accent-foreground hover:bg-accent/90 font-display font-bold text-base whitespace-normal"
              onClick={handleSpectate}
              disabled={joining}
            >
              {joining ? <Loader2 className="w-5 h-5 mr-2 animate-spin" /> : null}
              <span className="line-clamp-2 text-center leading-tight">{t("lobby.spectate")}</span>
            </Button>
          )}
          {joining && <p className="text-[11px] text-muted-foreground text-center">{t("sala.reserving")}</p>}
        </section>





        {isHost && (
          <div className="flex flex-col gap-3">
            {canInvite && (
              <Button
                type="button"
                variant="outline"
                className="h-11 py-1 border-primary/50 text-primary hover:bg-primary/10 font-display font-bold text-base"
                onClick={() => setInviteOpen(true)}
              >
                Convidar jugadors de la sala
              </Button>
            )}
            <Button
              size="lg"
              className="home-cta-btn w-full min-h-14 h-auto py-2 bg-primary text-primary-foreground hover:bg-primary/90 font-display font-bold text-lg gold-glow whitespace-normal"
              onClick={handleStart}
              disabled={!canStart || starting}
            >
              {starting ? <Loader2 className="w-5 h-5 mr-2 animate-spin" /> : null}
              <span className="line-clamp-2 text-center leading-tight">
                {tableFull
                  ? t("sala.start_match")
                  : canStart
                    ? t("sala.start_match")
                    : t("sala.waiting_humans", { joined: joinedHumans, total: expectedHumans })}
              </span>
            </Button>
            {room.status === "lobby" && (
              <div className="flex flex-col gap-1.5 mt-3">
                <div className="font-display font-bold text-lg text-white">
                  Contrasenya (Taula privada)
                </div>
                <div className="flex items-center gap-2">
                  <Input
                    type="text"
                    value={hostPwdInput}
                    onChange={(e) => setHostPwdInput(e.target.value)}
                    placeholder="Deixa-ho buit per a taula pública"
                    maxLength={32}
                    className="flex-1"
                  />
                  <Button
                    size="icon"
                    onClick={async () => {
                      const next = hostPwdInput.trim();
                      if (next === hostPwdSaved.trim()) return;
                      setHostPwdSaving(true);
                      try {
                        await setRoomPassword(room.id, deviceId, next ? next : null);
                        setHostPwdSaved(next);
                        // (No cache de validacions: cada accés es valida en viu.)
                        toast.success(next ? "Taula protegida amb contrasenya" : "Contrasenya eliminada");
                      } catch (e) {
                        toast.error(e instanceof Error ? e.message : "No s'ha pogut desar");
                      } finally {
                        setHostPwdSaving(false);
                      }
                    }}
                    disabled={hostPwdSaving || hostPwdInput.trim() === hostPwdSaved.trim()}
                    aria-label="Desar contrasenya"
                  >
                    {hostPwdSaving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
                  </Button>
                </div>
                <p className="text-[10px] text-muted-foreground">
                  Si poses contrasenya, qui entre en la taula haurà d'introduir-la. Els convidats directes no la necessiten.
                </p>
              </div>
            )}
          </div>
        )}


        {isHost && room.status === "lobby" ? (
          <RoomSettings
            roomId={room.id}
            deviceId={deviceId}
            targetCames={room.targetCames}
            targetCama={room.targetCama}
            turnTimeoutSec={room.turnTimeoutSec}
          />
        ) : (
          <div className="flex items-center justify-center gap-1.5 flex-wrap">
            {[
              { label: `${room.targetCames} cames` },
              { label: t("sala.points", { n: room.targetCama }) },
              { label: `${room.turnTimeoutSec}s/torn` },
            ].map((opt) => (
              <button
                key={opt.label}
                type="button"
                disabled
                aria-disabled
                className="option-chip inline-flex items-center justify-center rounded-md border border-primary/25 bg-background/30 text-foreground h-8 px-3 text-[11px] font-display leading-tight whitespace-nowrap cursor-not-allowed opacity-100"
              >
                <span className="option-chip-label">{opt.label}</span>
              </button>
            ))}
          </div>
        )}

        {joinError && <p className="text-xs text-destructive text-center">{joinError}</p>}

        {isHost && (
          <div className="flex flex-col gap-3">
            <Button
              type="button"
              variant="outline"
              className="border-destructive/50 text-destructive hover:bg-destructive/10"
              onClick={handleCloseTable}
            >
              {t("sala.close_table")}
            </Button>
          </div>
        )}
        {!isHost && room.status === "lobby" && (
          <p className="text-center text-sm text-gold mt-[30px]">{t("sala.waiting_host")}</p>
        )}

        {isAdmin && !isHost && (
          <Button
            type="button"
            variant="outline"
            disabled={closingAdmin}
            className="border-destructive/50 text-destructive hover:bg-destructive/10"
            onClick={async () => {
              setClosingAdmin(true);
              try {
                await adminCloseRoom({ data: { roomId: room.id, password: adminPassword } });
                toast.success(t("lobby.table_closed_toast"));
                navigate(backHref);
              } catch (e) {
                toast.error(e instanceof Error ? e.message : t("lobby.cant_close_table"));
                setClosingAdmin(false);
              }
            }}
          >
            {closingAdmin ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <ShieldX className="w-4 h-4 mr-2" />}
            {t("sala.close_table_admin")}
          </Button>
        )}
        </div>
      </div>


      {hasName && (
        <BoardRoomChat
          roomId={room.id}
          roomCode={code}
          deviceId={deviceId}
          name={name}
          hasName={hasName}
          ready={ready}
          mySeat={data.mySeat}
          players={players}
          salaSlug={salaSlug}
          buttonClassName="fixed right-4 top-[220px] z-40 h-12 w-12 rounded-full text-primary-foreground shadow-lg bg-accent"
        />
      )}

      <Dialog open={inviteOpen} onOpenChange={setInviteOpen}>
        <DialogContent className="w-[90vw] sm:max-w-[26.5rem] h-[60vh] flex flex-col gap-0 p-0 rounded-lg border border-primary/30 bg-gray-200 text-background overflow-hidden [&>button]:hidden">
          {(() => {
            const invitable = onlinePlayers.filter(
              (p) => p.deviceId !== deviceId && !seatedDeviceIds.includes(p.deviceId),
            );
            return (
              <InviteList
                invitable={invitable}
                t={t}
                sendInvite={sendInvite}
                onClose={() => setInviteOpen(false)}
              />
            );
          })()}
        </DialogContent>
      </Dialog>
      <RoomPasswordDialog
        open={pwdRequired}
        onVerify={(pwd) => verifyRoomPassword(code, pwd)}
        onSuccess={() => { setPwdRequired(false); setPwdChecked(true); }}
        onCancel={() => { setPwdRequired(false); navigate(backHref); }}
      />
    </main>
  );
}

function InviteList({
  invitable,
  t,
  sendInvite,
  onClose,
}: {
  invitable: Array<{ deviceId: string; userId?: string | null; name: string; roomCode?: string | null }>;
  t: ReturnType<typeof useT>;
  sendInvite: (deviceId: string) => Promise<void> | void;
  onClose: () => void;
}) {
  const { getResolvedUserId, isFriend } = useFriendIdentityMatcher(invitable);
  const { getStats } = usePlayerMiniStats(
    invitable.map((p) => ({ deviceId: p.deviceId, userId: getResolvedUserId(p) })),
  );
  return (
    <>
      <div className="pl-2 pr-1 py-0 border-b border-primary/20 flex items-center gap-2 bg-background rounded-t-lg h-7 overflow-hidden">
        <DialogTitle asChild>
          <span className="text-[14px] font-semibold text-primary flex-1 min-w-0 truncate leading-none">
            {t("players.connected")} <span className="text-[14px] font-normal">({invitable.length})</span>
          </span>
        </DialogTitle>
        <button
          type="button"
          onClick={onClose}
          className="inline-flex items-center justify-center h-7 w-9 rounded-sm text-primary hover:opacity-80 focus:outline-none p-0 shrink-0"
          aria-label={t("common.close")}
        >
          <X className="h-7 w-7 -mr-[15px]" />
        </button>
      </div>
      <div className="px-2 py-1.5 flex-1 min-h-0 overflow-y-auto chat-scroll text-[14px] space-y-0.5">
        {invitable.length === 0 ? (
          <p className="text-background/60 italic text-center py-2">
            {t("players.no_one_connected")}
          </p>
        ) : (
          invitable.map((p) => {
            const busy = !!p.roomCode;
            const resolvedUserId = getResolvedUserId(p);
            const stats = getStats({ deviceId: p.deviceId, userId: resolvedUserId });
            const showFriendBadge = isFriend(p);
            return (
              <div key={p.deviceId} className="leading-snug flex items-center gap-1.5 min-w-0">
                {showFriendBadge && <FriendBadge variant="chat" className="shrink-0" title="Amic" />}
                <PlayerProfileDialog
                  userId={resolvedUserId ?? undefined}
                  deviceId={resolvedUserId ? undefined : p.deviceId}
                  fallbackName={p.name}
                  trigger={
                    <button
                      type="button"
                      className="font-semibold text-background hover:underline focus:outline-none focus:underline text-left truncate min-w-0"
                    >
                      {p.name}
                    </button>
                  }
                />
                <PlayerMiniStatsRow stats={stats} className="shrink-0" />
                {busy ? (
                  <RoomCodeLabel
                    code={p.roomCode ?? ""}
                    className="text-[12px] text-background/60 shrink-0 ml-auto w-20 inline-block text-center leading-none"
                  />
                ) : (
                  <button
                    type="button"
                    onClick={() => { void sendInvite(p.deviceId); }}
                    className="ml-auto h-5 w-20 px-1.5 py-0 text-[12px] inline-flex items-center justify-center rounded border border-primary/40 text-primary bg-background hover:bg-primary/10 shrink-0 leading-none"
                  >
                    {t("players.invite")}
                  </button>
                )}
              </div>
            );
          })
        )}
      </div>
    </>
  );
}

const CAMES_OPTS = [1, 2, 3];
const TARGET_CAMA_OPTS = [9, 12];
const TURN_TIMEOUT_OPTS = [15, 30, 45, 60];

function RoomSettings({
  roomId,
  deviceId,
  targetCames,
  targetCama,
  turnTimeoutSec,
}: {
  roomId: string;
  deviceId: string;
  targetCames: number;
  targetCama: number;
  turnTimeoutSec: number;
}) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const apply = async (patch: { targetCames?: number; targetCama?: number; turnTimeoutSec?: number }) => {
    if (busy) return;
    setBusy(true);
    try {
      await setRoomSettings({ data: { roomId, deviceId, ...patch } });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t("sala.cant_change_settings"));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-col gap-1.5">
        <div className="font-display font-bold text-lg text-white">{t("settings.cames_to_win")}</div>
        <div className="grid grid-cols-3 gap-2">
          {CAMES_OPTS.map((v) => (
            <Chip key={v} selected={targetCames === v} disabled={busy} onClick={() => apply({ targetCames: v })} label={v === 1 ? t("sala.cama_singular", { n: v }) : t("sala.cama_plural", { n: v })} />
          ))}
        </div>
      </div>
      <div className="flex flex-col gap-1.5">
        <div className="font-display font-bold text-lg text-white">{t("settings.piedras_per_cama")}</div>
        <div className="grid grid-cols-2 gap-2">
          {TARGET_CAMA_OPTS.map((v) => (
            <Chip key={v} selected={targetCama === v} disabled={busy} onClick={() => apply({ targetCama: v })} label={t("sala.points", { n: v })} />
          ))}
        </div>
      </div>
      <div className="flex flex-col gap-1.5">
        <div className="font-display font-bold text-lg text-white">{t("sala.waiting_time_turn")}</div>
        <div className="grid grid-cols-4 gap-2">
          {TURN_TIMEOUT_OPTS.map((sec) => (
            <Chip key={sec} selected={turnTimeoutSec === sec} disabled={busy} onClick={() => apply({ turnTimeoutSec: sec })} label={`${sec}s`} />
          ))}
        </div>
      </div>
    </section>
  );
}

function Chip({ selected, onClick, label, disabled }: { selected: boolean; onClick: () => void; label: string; disabled?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-pressed={selected}
      className={cn(
        "option-chip rounded-md border px-2 py-1.5 text-center transition-all flex flex-col items-center gap-0.5 leading-tight disabled:opacity-60",
        selected
          ? "border-primary bg-primary/15 text-primary"
          : "border-primary/25 bg-background/30 text-foreground/80 hover:border-primary/50 hover:bg-primary/10",
      )}
    >
      <span className="option-chip-label inline-flex items-center gap-1.5 font-display text-sm">{label}</span>
    </button>
  );
}

export default OnlineSalaPage;