import { useEffect, useState, type ReactNode } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Loader2, Star, Trophy, Flame, Gamepad2, X, ThumbsDown, UserPlus, Users, Check, Award, BarChart3, Mail, Send } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { addFriendDirect, getFriendStatusWith, useFriends, respondFriendRequest, removeFriend } from "@/lib/friends";
import { progressInLevel } from "@/lib/playerStats";
import { useOnlinePresenceLookup } from "@/online/useLobbyPresence";
import { ConnectionStatus } from "@/components/ConnectionStatus";
import { toast } from "sonner";
import { fetchPlayerNamesByUserIds, fetchPlayerNamesByDevices } from "@/lib/playerNames";
import { AtSign } from "lucide-react";
import { useConfirm } from "@/components/ConfirmDialog";
import { useT } from "@/i18n/useT";
import { MessagesInbox } from "@/components/MessagesInbox";

interface PublicProfile {
  user_id: string;
  username: string | null;
  display_name: string;
  avatar_url: string | null;
  friend_code: string;
  level: number;
  xp: number;
  wins: number;
  losses: number;
  abandoned: number;
  current_streak: number;
  max_streak: number;
}

interface PublicFriend {
  user_id: string;
  username: string | null;
  display_name: string;
  avatar_url: string | null;
  level: number;
  wins: number;
  losses: number;
  abandoned: number;
  max_streak: number;
}


function formatPlayerLabel(displayName: string | null | undefined, username: string | null | undefined): string {
  const dn = (displayName ?? "").trim();
  const un = (username ?? "").trim();
  if (dn && un) return `${dn} (${un})`;
  return dn || un || "Jugador";
}

function StatBox({ icon, label, value, accent, valueClassName, labelClassName }: { icon: React.ReactNode; label: string; value: React.ReactNode; accent?: string; valueClassName?: string; labelClassName?: string }) {
  return (
    <div className="rounded-md border border-primary/25 bg-background/40 p-3 text-center">
      <div className={`flex items-center justify-center gap-1 text-[13px] font-bold mb-1 ${accent ?? "text-muted-foreground"}`}>
        {icon}<span className={labelClassName}>{label}</span>
      </div>
      <div className={`text-xl font-bold ${valueClassName ?? accent ?? "text-foreground"}`}>{value}</div>
    </div>
  );
}

export function PlayerProfileDialog({
  deviceId,
  userId,
  fallbackName,
  trigger,
}: {
  deviceId?: string;
  userId?: string;
  fallbackName: string;
  trigger: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [profile, setProfile] = useState<PublicProfile | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [busy, setBusy] = useState(false);
  const [relStatus, setRelStatus] = useState<"none" | "outgoing" | "incoming" | "accepted">("none");
  const [friendsList, setFriendsList] = useState<PublicFriend[]>([]);
  const [playerNamesByUser, setPlayerNamesByUser] = useState<Map<string, string>>(() => new Map());
  const [profilePlayerName, setProfilePlayerName] = useState<string | null>(null);
  const [currentUserId, setCurrentUserId] = useState<string | undefined>(userId);
  const [currentDeviceId, setCurrentDeviceId] = useState<string | undefined>(deviceId);
  const [currentFallbackName, setCurrentFallbackName] = useState<string>(fallbackName);
  const { user } = useAuth();
  const { deviceIds: onlineDevices, userIds: onlineUsers } = useOnlinePresenceLookup(open);
  const isSelfProfile = !!(user && currentUserId && user.id === currentUserId);
  const { accepted, incoming, outgoing, reload: reloadFriends } = useFriends();
  const [respondingId, setRespondingId] = useState<string | null>(null);
  const t = useT();
  const { confirm, dialog: confirmDialog } = useConfirm();


  async function handleRespond(friendshipId: string, accept: boolean) {
    setRespondingId(friendshipId);
    try {
      await respondFriendRequest(friendshipId, accept);
      toast.success(accept ? "Sol·licitud acceptada" : "Sol·licitud rebutjada");
      await reloadFriends();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setRespondingId(null);
    }
  }

  useEffect(() => {
    if (open) {
      setCurrentUserId(userId);
      setCurrentDeviceId(deviceId);
      setCurrentFallbackName(fallbackName);
    }
  }, [open, userId, deviceId, fallbackName]);

  useEffect(() => {
    if (!open) return;
    let alive = true;
    setLoading(true);
    setNotFound(false);
    setProfile(null);
    setFriendsList([]);
    setPlayerNamesByUser(new Map());
    setProfilePlayerName(null);
    setRelStatus("none");
    (async () => {
      const { data, error } = currentUserId
        ? await supabase.rpc("get_public_player_profile_by_user_id", { p_user_id: currentUserId })
        : await supabase.rpc("get_public_player_profile_by_device", { p_device_id: currentDeviceId! });
      if (!alive) return;
      if (error || !data || (Array.isArray(data) && data.length === 0)) {
        setNotFound(true);
        setLoading(false);
        return;
      } else {
        const row = Array.isArray(data) ? data[0] : data;
        setProfile(row as PublicProfile);
        const targetId = (row as PublicProfile).user_id;
        // Fetch the chosen "player name" (room_players.name) for this profile.
        (async () => {
          const m = await fetchPlayerNamesByUserIds([targetId]);
          if (!alive) return;
          const pn = m.get(targetId);
          if (pn) setProfilePlayerName(pn);
          else if (currentDeviceId) {
            const md = await fetchPlayerNamesByDevices([currentDeviceId]);
            if (alive) setProfilePlayerName(md.get(currentDeviceId) ?? null);
          }
        })();
        const [fromRes, toRes] = await Promise.all([
          (supabase as any)
            .from("friends")
            .select("user_id, friend_id, status")
            .eq("user_id", targetId)
            .eq("status", "accepted"),
          (supabase as any)
            .from("friends")
            .select("user_id, friend_id, status")
            .eq("friend_id", targetId)
            .eq("status", "accepted"),
        ]);
        const rows = [
          ...((fromRes.data ?? []) as Array<{ user_id: string; friend_id: string }>),
          ...((toRes.data ?? []) as Array<{ user_id: string; friend_id: string }>),
        ];
        const otherIds = Array.from(new Set(rows.map((r) => (r.user_id === targetId ? r.friend_id : r.user_id))));
        if (alive && otherIds.length > 0) {
          const [pRes, sRes, nRes] = await Promise.all([
            supabase.from("profiles").select("user_id, username, display_name, avatar_url").in("user_id", otherIds),
            supabase.from("user_stats").select("user_id, level, wins, losses, abandoned, max_streak").in("user_id", otherIds),
            fetchPlayerNamesByUserIds(otherIds),
          ]);
          const statsByUser = new Map((sRes.data ?? []).map((s: any) => [s.user_id, s]));
          const list: PublicFriend[] = ((pRes.data ?? []) as any[]).map((p) => {
            const s = statsByUser.get(p.user_id) as any | undefined;
            return {
              user_id: p.user_id,
              username: p.username ?? null,
              display_name: p.display_name ?? "Jugador",
              avatar_url: p.avatar_url ?? null,
              level: s?.level ?? 1,
              wins: s?.wins ?? 0,
              losses: s?.losses ?? 0,
              abandoned: s?.abandoned ?? 0,
              max_streak: s?.max_streak ?? 0,
            };
          });

          if (alive) {
            setFriendsList(list);
            setPlayerNamesByUser(nRes);
          }
        }
      }
      setLoading(false);
    })();
    return () => { alive = false; };
  }, [open, currentDeviceId, currentUserId]);

  useEffect(() => {
    if (!open || !currentUserId || !user || user.id === currentUserId) return;
    let alive = true;
    (async () => {
      try {
        const r = await getFriendStatusWith(currentUserId);
        if (!alive) return;
        if (!r) setRelStatus("none");
        else if (r.status === "accepted") setRelStatus("accepted");
        else setRelStatus(r.direction);
      } catch { /* noop */ }
    })();
    return () => { alive = false; };
  }, [open, currentUserId, user]);

  // For the self-profile tabs, fetch the chosen player names of every friend
  // / pending request and merge them into the lookup map.
  useEffect(() => {
    if (!open || !isSelfProfile) return;
    const ids = Array.from(new Set([
      ...accepted.map((f) => f.other.user_id),
      ...incoming.map((f) => f.other.user_id),
      ...outgoing.map((f) => f.other.user_id),
    ].filter(Boolean)));
    if (ids.length === 0) return;
    let alive = true;
    (async () => {
      const m = await fetchPlayerNamesByUserIds(ids);
      if (!alive || m.size === 0) return;
      setPlayerNamesByUser((prev) => {
        const next = new Map(prev);
        m.forEach((v, k) => next.set(k, v));
        return next;
      });
    })();
    return () => { alive = false; };
  }, [open, isSelfProfile, accepted, incoming, outgoing]);

  async function handleAddFriend() {
    if (!user) {
      toast.error("Has d'iniciar sessió per afegir amics");
      return;
    }
    if (!profile?.user_id) return;
    setBusy(true);
    try {
      await addFriendDirect(profile.user_id);
      setRelStatus("outgoing");
      toast.success("Solicitud enviada");
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function openFriendProfile(f: PublicFriend) {
    const fname = f.display_name ?? f.username ?? "Jugador";
    setCurrentUserId(f.user_id);
    setCurrentDeviceId(undefined);
    setCurrentFallbackName(fname);
  }

  const isSelf = !!(user && profile && profile.user_id === user.id);
  const total = profile ? profile.wins + profile.losses : 0;
  const winRate = total > 0 ? Math.round(((profile?.wins ?? 0) / total) * 100) : 0;
  const prog = profile ? progressInLevel(profile.xp, profile.level) : null;
  // Line 1 (big name): always prefer the profile's Display Name (the name
  // the player uses to play, as shown in the friends list). Fall back to the
  // chosen "player name" or the caller-supplied label only if missing.
  const displayName =
    (profile?.display_name?.trim() || profilePlayerName || currentFallbackName || "Jugador");
  const usernameStr = profile?.username ?? null;
  const initial = (displayName || "?").trim().charAt(0).toUpperCase();
  const online =
    (!!profile?.user_id && onlineUsers.has(profile.user_id)) ||
    (!!currentDeviceId && onlineDevices.has(currentDeviceId));

  return (
    <>
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent className="w-[calc(100%-2rem)] sm:max-w-md h-[75vh] overflow-y-auto avatar-scroll rounded-2xl border-primary/30 p-4 flex flex-col justify-start items-stretch [scrollbar-gutter:stable_both-edges] [overflow-y:overlay]">
        <DialogHeader>
          <DialogTitle className="font-title font-black italic text-gold text-2xl text-center">Perfil del jugador</DialogTitle>
        </DialogHeader>

        {loading ? (
          <div className="py-10 flex items-center justify-center">
            <Loader2 className="w-6 h-6 animate-spin text-primary" />
          </div>
        ) : notFound || !profile ? (
          <p className="text-sm text-muted-foreground text-center py-6">
            Aquest jugador encara no té perfil públic.
          </p>
        ) : (
          <div className="flex flex-col gap-3">
            <div className="flex items-center gap-3">
              <div className="w-14 h-14 rounded-full overflow-hidden border-2 border-primary/40 bg-background/50 flex items-center justify-center shrink-0">
                {profile.avatar_url ? (
                  <img src={profile.avatar_url} alt={displayName} className="w-full h-full object-cover" />
                ) : (
                  <span className="font-display font-bold text-xl text-foreground">{initial}</span>
                )}
              </div>
              <div className="min-w-0 flex-1">
                <div className="text-lg font-bold text-foreground truncate normal-case leading-tight">{displayName}</div>
                {usernameStr && (
                  <div className="font-mono text-base text-gold truncate leading-tight">
                    {usernameStr}
                  </div>
                )}
                <ConnectionStatus online={online} className="mt-0.5" />
              </div>
              <Badge variant="outline" className="gap-1 border-transparent text-white bg-[#f97415] self-start">
                <Star className="w-3 h-3 text-white" /> Nivell {profile.level}
              </Badge>
            </div>

            {prog && (
              <div>
                <div className="flex justify-between text-xs text-muted-foreground mb-1">
                  <span>{prog.current} / {prog.max} XP</span>
                  <span>Nivell {profile.level + 1}</span>
                </div>
                <div className="h-2 rounded-full bg-muted-foreground/50 border border-primary/20 overflow-hidden">
                  <div className="h-full bg-[#f97415] transition-all" style={{ width: `${prog.pct}%` }} />
                </div>
              </div>
            )}

            {(() => {
              const StatsGrid = (
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                  <StatBox icon={<Gamepad2 className="w-3 h-3 text-[#93c572]" />} label="Partides" value={total} accent="text-foreground/30 font-bold text-slate-100" labelClassName="text-[#93c572]" />
                  <StatBox icon={<ThumbsDown className="w-3 h-3 text-stone-500" />} label="Abandonades" value={profile.abandoned} accent="text-foreground/30 font-bold text-slate-100 text-[#df2020]" labelClassName="text-stone-500" />
                  <StatBox icon={<Trophy className="w-3 h-3 text-[#ef8e39]" />} label="Victòries" value={profile.wins} accent="text-primary font-bold text-[#ef8e39]" valueClassName="text-slate-100" labelClassName="text-[#ef8e39]" />
                  <StatBox icon={<X className="w-3 h-3 text-[#df2020]" />} label="Derrotes" value={profile.losses} accent="text-foreground/30 font-bold text-slate-100 text-[#df2020]" labelClassName="text-[#df2020]" />
                  <StatBox icon={<Award className="w-3 h-3 text-[#e6b033]" />} label="% Victòries" value={`${winRate}%`} accent="text-foreground/30 font-bold text-slate-100" labelClassName="text-[#e6b033]" />
                  <StatBox icon={<Flame className="w-3 h-3 text-[#66a50d]" />} label="Ratxa màx." value={profile.max_streak} accent="font-bold text-slate-100" labelClassName="text-[#66a50d]" />
                </div>
              );

              const AddFriendBtn = !isSelf ? (
                <div className="flex justify-center pt-1">
                  <Button type="button" onClick={handleAddFriend} disabled={busy || !user || relStatus !== "none"} size="sm">
                    <UserPlus className="w-4 h-4 mr-1" />
                    {!user
                      ? "Inicia sessió per afegir"
                      : relStatus === "accepted"
                        ? "Ja és amic"
                        : relStatus === "outgoing"
                          ? "Solicitud enviada"
                          : relStatus === "incoming"
                            ? "Et té enviada una sol·licitud"
                            : "Afegir com a amic"}
                  </Button>
                </div>
              ) : null;

              const FriendsListPublic = friendsList.length === 0 ? (
                <p className="text-xs text-muted-foreground text-center py-3">Encara no té amics.</p>
              ) : (
                <div className="avatar-scroll max-h-[40vh] overflow-y-auto space-y-2 w-full pr-1">
                  {friendsList.map((f) => {
                    const fname = formatPlayerLabel(playerNamesByUser.get(f.user_id) ?? f.display_name, f.username);
                    const finit = (f.display_name || f.username || "?").trim().charAt(0).toUpperCase();
                    return (
                      <button
                        key={f.user_id}
                        type="button"
                        onClick={() => openFriendProfile(f)}
                        className="w-full flex items-center gap-3 rounded-md border border-primary/25 bg-white p-2 text-left hover:bg-white/10 transition"
                      >
                        <div className="w-9 h-9 rounded-full overflow-hidden border-2 border-primary/40 bg-background/50 flex items-center justify-center shrink-0">
                          {f.avatar_url ? (
                            <img src={f.avatar_url} alt={fname} className="w-full h-full object-cover" />
                          ) : (
                            <span className="font-display font-bold text-sm text-foreground">{finit}</span>
                          )}
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="font-medium truncate text-[hsl(var(--primary-foreground))] normal-case">{fname}</div>
                          <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs font-bold leading-none">
                            {(() => { const tot = f.wins + f.losses; const wr = tot > 0 ? Math.round((f.wins / tot) * 100) : 0; return (
                            <>
                            <span className="inline-flex items-center gap-0.5 text-[#f97415]" title="Nivell"><Star className="w-3.5 h-3.5" /> {f.level}</span>
                            <span className="inline-flex items-center gap-0.5 text-[#93c572]" title="Partides"><Gamepad2 className="w-3.5 h-3.5" /> {tot}</span>
                            <span className="inline-flex items-center gap-0.5 text-[#ef8e39]" title="Victòries"><Trophy className="w-3.5 h-3.5" /> {f.wins}</span>
                            <span className="inline-flex items-center gap-0.5 text-destructive" title="Derrotes"><X className="w-3.5 h-3.5" /> {f.losses}</span>
                            <span className="inline-flex items-center gap-0.5 text-[#e6b033]" title="% Victòries"><Award className="w-3.5 h-3.5" /> {wr}%</span>
                            <span className="inline-flex items-center gap-0.5 text-[#66a50d]" title="Ratxa màx."><Flame className="w-3.5 h-3.5" /> {f.max_streak}</span>
                            </>

                            ); })()}
                          </div>
                        </div>
                      </button>
                    );
                  })}
                </div>
              );

              if (isSelfProfile) {
                const selfTabCls = "flex-1 bg-transparent text-white hover:bg-[#7fb55e] data-[state=active]:!bg-table-felt data-[state=active]:!text-[#f5c542] data-[state=active]:shadow-none data-[state=active]:opacity-100 py-1 px-2 text-[13px] normal-case";
                const FriendsSelf = (
                  <Tabs defaultValue="amics" className="w-full">
                    <TabsList className="flex w-full h-auto rounded-xl">
                      <TabsTrigger value="amics" className="text-slate-100 py-1 px-2 flex-1 text-[13px]">Amics ({accepted.length})</TabsTrigger>
                      <TabsTrigger value="rebudes" className="text-slate-100 py-1 px-2 w-auto flex-none text-[13px]">Rebudes</TabsTrigger>
                      <TabsTrigger value="enviades" className="text-slate-100 py-1 px-2 w-auto flex-none text-[13px]">Enviades</TabsTrigger>
                    </TabsList>

                    <TabsContent value="amics" className="avatar-scroll max-h-[35vh] overflow-y-auto space-y-2 mt-3 w-full">
                      {accepted.length === 0 && (
                        <p className="text-sm text-muted-foreground text-center py-4">Encara no tens amics.</p>
                      )}
                      {accepted.map((f) => {
                        const label = formatPlayerLabel(playerNamesByUser.get(f.other.user_id) ?? f.other.display_name, f.other.username);
                        return (
                          <div key={f.friendship.id} className="flex items-center justify-between rounded-md border border-primary/25 bg-white p-2 w-full">
                            <div className="min-w-0 flex-1">
                              <div className="font-medium truncate text-[hsl(var(--primary-foreground))] normal-case">{label}</div>
                              <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs font-bold leading-none">
                                {(() => { const w = f.stats?.wins ?? 0; const l = f.stats?.losses ?? 0; const ab = f.stats?.abandoned ?? 0; const tot = w + l; const wr = tot > 0 ? Math.round((w / tot) * 100) : 0; return (
                                <>
                                <span className="inline-flex items-center gap-0.5 text-[#f97415]" title="Nivell"><Star className="w-3.5 h-3.5" /> {f.stats?.level ?? 1}</span>
                                <span className="inline-flex items-center gap-0.5 text-[#93c572]" title="Partides"><Gamepad2 className="w-3.5 h-3.5" /> {tot}</span>
                                <span className="inline-flex items-center gap-0.5 text-[#ef8e39]" title="Victòries"><Trophy className="w-3.5 h-3.5" /> {w}</span>
                                <span className="inline-flex items-center gap-0.5 text-destructive" title="Derrotes"><X className="w-3.5 h-3.5" /> {l}</span>
                                <span className="inline-flex items-center gap-0.5 text-[#e6b033]" title="% Victòries"><Award className="w-3.5 h-3.5" /> {wr}%</span>
                                <span className="inline-flex items-center gap-0.5 text-[#66a50d]" title="Ratxa màx."><Flame className="w-3.5 h-3.5" /> {f.stats?.max_streak ?? 0}</span>
                                </>
                                ); })()}
                              </div>
                            </div>
                            <Button size="sm" variant="ghost" className="shrink-0 ml-2 h-8 w-8 p-0 bg-team-nos text-white hover:bg-team-nos/90" onClick={async () => {
                              const ok = await confirm(t("friends.confirm_remove", { name: label }));
                              if (!ok) return;
                              try { await removeFriend(f.other.user_id); await reloadFriends(); toast.success("Amic eliminat"); }
                              catch (e) { toast.error((e as Error).message); }
                            }} aria-label="Eliminar amic">
                              <X className="w-4 h-4" strokeWidth={3} />
                            </Button>
                          </div>
                        );
                      })}
                    </TabsContent>

                    <TabsContent value="rebudes" className="avatar-scroll max-h-[35vh] overflow-y-auto space-y-2 mt-3 w-full">
                      {incoming.length === 0 && (
                        <p className="text-sm text-muted-foreground text-center py-4">No tens sol·licituds pendents.</p>
                      )}
                      {incoming.map((f) => {
                        const label = formatPlayerLabel(playerNamesByUser.get(f.other.user_id) ?? f.other.display_name, f.other.username);
                        const busyR = respondingId === f.friendship.id;
                        return (
                          <div key={f.friendship.id} className="flex items-center gap-2 rounded-md border border-primary/25 bg-white p-2 w-full">
                            <span className="flex-1 truncate text-sm text-[hsl(var(--primary-foreground))]">{label}</span>
                            <Button size="sm" variant="ghost" className="h-8 w-8 p-0 bg-emerald-500 text-white hover:bg-emerald-500/90" disabled={busyR} onClick={() => handleRespond(f.friendship.id, true)} aria-label="Acceptar">
                              <Check className="w-4 h-4" strokeWidth={3} />
                            </Button>
                            <Button size="sm" variant="ghost" className="h-8 w-8 p-0 bg-team-nos text-white hover:bg-team-nos/90" disabled={busyR} onClick={async () => {
                              const ok = await confirm(t("friends.confirm_cancel_incoming", { name: label }));
                              if (ok) handleRespond(f.friendship.id, false);
                            }} aria-label="Rebutjar">
                              <X className="w-4 h-4" strokeWidth={3} />
                            </Button>
                          </div>
                        );
                      })}
                    </TabsContent>

                    <TabsContent value="enviades" className="avatar-scroll max-h-[35vh] overflow-y-auto space-y-2 mt-3 w-full">
                      {outgoing.length === 0 && (
                        <p className="text-sm text-muted-foreground text-center py-4">No has enviat sol·licituds.</p>
                      )}
                      {outgoing.map((f) => {
                        const label = formatPlayerLabel(playerNamesByUser.get(f.other.user_id) ?? f.other.display_name, f.other.username);
                        const busyR = respondingId === f.friendship.id;
                        return (
                          <div key={f.friendship.id} className="flex items-center gap-2 rounded-md border border-primary/25 bg-white p-2 w-full">
                            <span className="flex-1 truncate text-sm text-[hsl(var(--primary-foreground))]">{label}</span>
                            <span className="text-xs text-muted-foreground">Pendent</span>
                            <Button size="sm" variant="ghost" className="h-8 w-8 p-0 bg-team-nos text-white hover:bg-team-nos/90" disabled={busyR} onClick={async () => {
                              const ok = await confirm(t("friends.confirm_cancel_outgoing", { name: label }));
                              if (ok) handleRespond(f.friendship.id, false);
                            }} aria-label="Cancel·lar">
                              <X className="w-4 h-4" strokeWidth={3} />
                            </Button>
                          </div>
                        );
                      })}
                    </TabsContent>
                  </Tabs>
                );

                return (
                  <Tabs defaultValue="stats" className="flex flex-col gap-3">
                    <TabsList className="flex w-full h-auto rounded-xl gap-1 p-1 bg-[#93c572]">
                      <TabsTrigger value="stats" className={selfTabCls}>Estadístiques</TabsTrigger>
                      <TabsTrigger value="friends" className={selfTabCls}>Amics</TabsTrigger>
                      <TabsTrigger value="messages" className={selfTabCls}>Missatges</TabsTrigger>
                    </TabsList>

                    <TabsContent value="stats" className="mt-3 flex flex-col gap-3">
                      {StatsGrid}
                    </TabsContent>

                    <TabsContent value="friends" className="mt-3 w-full">
                      {FriendsSelf}
                    </TabsContent>

                    <TabsContent value="messages" className="mt-3 w-full">
                      {user && <MessagesInbox userId={user.id} hideAdminCounter />}
                    </TabsContent>
                  </Tabs>
                );
              }

              // Non-self profile: Estadístiques / Amics / Missatges tabs
              const tabTriggerCls = "flex-1 bg-transparent text-white hover:bg-[#7fb55e] data-[state=active]:!bg-table-felt data-[state=active]:!text-[#f5c542] data-[state=active]:shadow-none data-[state=active]:opacity-100 py-1 px-2 text-[13px] normal-case";
                return (
                <Tabs defaultValue="stats" className="flex flex-col gap-3">
                  <TabsList className="flex w-full h-auto rounded-xl gap-1 p-1 bg-[#93c572]">
                    <TabsTrigger value="stats" className={tabTriggerCls}>Estadístiques</TabsTrigger>
                    <TabsTrigger value="friends" className={tabTriggerCls}>Amics</TabsTrigger>
                    <TabsTrigger value="messages" className={tabTriggerCls}>Missatges</TabsTrigger>
                  </TabsList>

                  <TabsContent value="stats" className="mt-3 flex flex-col gap-3">
                    {StatsGrid}
                    {AddFriendBtn}
                  </TabsContent>

                  <TabsContent value="friends" className="mt-3 w-full">
                    {FriendsListPublic}
                  </TabsContent>

                  <TabsContent value="messages" className="mt-3 w-full">
                    <SendMessageForm receiverId={profile.user_id} receiverName={displayName} />
                  </TabsContent>
                </Tabs>
              );
            })()}

          </div>
        )}
      </DialogContent>
    </Dialog>
    {confirmDialog}
    </>
  );
}


function SendMessageForm({ receiverId, receiverName }: { receiverId: string; receiverName: string }) {
  const { user } = useAuth();
  const [subject, setSubject] = useState("");
  const [content, setContent] = useState("");
  const [sending, setSending] = useState(false);

  const onSend = async () => {
    if (!user) { toast.error("Has d'iniciar sessió per enviar missatges"); return; }
    if (!content.trim()) { toast.error("Escriu un missatge"); return; }
    setSending(true);
    try {
      const db = supabase as any;
      const { error } = await db.from("user_messages").insert({
        sender_id: user.id,
        receiver_id: receiverId,
        subject: subject.trim() || null,
        content: content.trim(),
      });
      if (error) throw error;
      toast.success("Missatge enviat");
      setSubject("");
      setContent("");
    } catch (e: any) {
      toast.error(e?.message ?? "Error en enviar");
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="text-xs text-muted-foreground">
        Per a: <span className="text-gold font-semibold">{receiverName}</span>
      </div>
      <div className="space-y-1">
        <Label htmlFor="pm-subj" className="text-xs">Assumpte</Label>
        <Input id="pm-subj" value={subject} onChange={(e) => setSubject(e.target.value)} maxLength={120} className="bg-background/40 border-primary/30" />
      </div>
      <div className="space-y-1">
        <Label htmlFor="pm-body" className="text-xs">Missatge</Label>
        <Textarea id="pm-body" value={content} onChange={(e) => setContent(e.target.value)} rows={4} maxLength={2000} className="bg-background/40 border-primary/30" />
      </div>
      <Button onClick={onSend} disabled={sending || !user || !content.trim()} className="w-full uppercase">
        <Send className="w-4 h-4 mr-1" />
        {sending ? "Enviant…" : "Enviar missatge"}
      </Button>
    </div>
  );
}