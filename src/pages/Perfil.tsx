import { useState, useEffect } from "react";
import { useNavigate } from "@/lib/router-shim";
import { PlayerProfileDialog } from "@/online/PlayerProfileDialog";
import { ClientOnly } from "@/components/ClientOnly";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { Loader2, Trophy, Flame, Star, Users, Copy, UserPlus, Check, X, LogOut, Gamepad2, ThumbsDown, Award, BarChart3, Mail } from "lucide-react";
import { toast } from "sonner";
import { ShareAppButton } from "@/components/ShareAppButton";
import { AvatarPicker } from "@/components/AvatarPicker";
import { UsernameField } from "@/components/UsernameField";
import { ClassificacionsDialog } from "@/components/ClassificacionsDialog";
import { ConnectionStatus } from "@/components/ConnectionStatus";
import { useConfirm } from "@/components/ConfirmDialog";
import { useT } from "@/i18n/useT";
import { fetchPlayerNamesByUserIds } from "@/lib/playerNames";
import { MessagesInbox } from "@/components/MessagesInbox";

import { useAuth } from "@/hooks/useAuth";
import { useMyProfile, progressInLevel } from "@/lib/playerStats";
import {
  useFriends,
  addFriendByUsernameDirect,
  respondFriendRequest,
  removeFriend,
} from "@/lib/friends";

function Loading() {
  return (
    <main className="min-h-screen flex items-center justify-center">
      <Loader2 className="w-6 h-6 animate-spin text-primary" />
    </main>
  );
}

function PerfilInner() {
  const navigate = useNavigate();
  const { user, ready } = useAuth();
  const { profile, stats, loading, reload } = useMyProfile();
  const friends = useFriends();
  const [friendInput, setFriendInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [playerNames, setPlayerNames] = useState<Map<string, string>>(() => new Map());
  const t = useT();
  const { confirm, dialog: confirmDialog } = useConfirm();



  useEffect(() => {
    const ids = Array.from(new Set([
      ...friends.accepted.map((f) => f.other.user_id),
      ...friends.incoming.map((f) => f.other.user_id),
      ...friends.outgoing.map((f) => f.other.user_id),
    ].filter(Boolean)));
    if (ids.length === 0) { setPlayerNames(new Map()); return; }
    let alive = true;
    fetchPlayerNamesByUserIds(ids).then((m) => { if (alive) setPlayerNames(m); });
    return () => { alive = false; };
  }, [friends.accepted, friends.incoming, friends.outgoing]);

  function labelFor(other: { user_id: string; display_name?: string | null; username?: string | null }): string {
    const pn = (playerNames.get(other.user_id) ?? other.display_name ?? "").trim();
    const un = (other.username ?? "").trim();
    if (pn && un) return `${pn} (${un})`;
    return pn || un || "Jugador anònim";
  }

  if (!ready) return <Loading />;
  if (!user) {
    return (
      <main className="min-h-screen p-6 flex flex-col items-center justify-center gap-4">
        <p className="text-muted-foreground">Inicia sessió per veure el teu perfil i estadístiques.</p>
        <Button onClick={() => navigate("/auth")}>Iniciar sessió</Button>
        <Button variant="ghost" onClick={() => navigate("/")}>Tornar</Button>
      </main>
    );
  }

  const wins = stats?.wins ?? 0;
  const losses = stats?.losses ?? 0;
  const total = wins + losses;
  const winRate = total > 0 ? Math.round((wins / total) * 100) : 0;
  const level = stats?.level ?? 1;
  const xp = stats?.xp ?? 0;
  const prog = progressInLevel(xp, level);

  async function handleAddFriend() {
    const v = friendInput.trim();
    if (!v) return;
    setBusy(true);
    try {
      await addFriendByUsernameDirect(v);
      toast.success("Solicitud enviada");
      setFriendInput("");
      friends.reload();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function copyCode() {
    if (!profile?.friend_code) return;
    navigator.clipboard.writeText(profile.friend_code);
    toast.success("Codi copiat");
  }

  return (
    <main className="menu-screen min-h-screen px-4 py-5 pb-24">
      <div className="w-full max-w-2xl mx-auto flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <ShareAppButton />
          <Button
            onClick={() => navigate("/ajustes")}
            size="sm"
            variant="outline"
            className="h-8 w-8 p-0 border-foreground/80 text-foreground hover:bg-foreground/10"
            aria-label="Tornar"
            title="Tornar"
          >
            <LogOut className="w-4 h-4" />
          </Button>
        </div>

        <header className="text-center">
          <h1 className="font-title font-black italic text-gold text-2xl text-center pr-1.5">El meu perfil</h1>
        </header>

        {loading && !profile ? (
          <Loading />
        ) : (
          <>
            <section className="flex flex-col gap-3">
              <div className="flex items-center gap-3">
                <AvatarPicker
                  userId={user.id}
                  currentUrl={profile?.avatar_url ?? null}
                  displayName={profile?.display_name ?? "Jugador"}
                  onChanged={() => { void reload(); }}
                />
                <div className="min-w-0 flex-1 flex flex-wrap items-center gap-x-3 gap-y-1">
                  <div className="min-w-0 flex flex-col">
                    <div className="font-display font-bold text-lg text-foreground truncate">{profile?.display_name ?? "Jugador"}</div>
                    <div className="text-xs text-muted-foreground truncate">{user.email}</div>
                    <ConnectionStatus online className="mt-0.5" />
                  </div>
                  <Badge variant="outline" className="gap-1 border-transparent text-white bg-[#f97415] ml-auto">
                    <Star className="w-3 h-3 text-white" /> Nivell {level}
                  </Badge>
                </div>
              </div>

              <div>
                <div className="flex justify-between text-xs text-muted-foreground mb-1">
                  <span>{prog.current} / {prog.max} XP</span>
                  <span>Nivell {level + 1}</span>
                </div>
                <div className="h-2 rounded-full bg-muted-foreground/50 border border-primary/20 overflow-hidden">
                  <div className="h-full bg-[#f97415] transition-all" style={{ width: `${prog.pct}%` }} />
                </div>
              </div>

              <UsernameField current={profile?.username ?? null} onSaved={() => { void reload(); }} />
            </section>

            <Tabs defaultValue="stats" className="mt-2">
              <TabsList className="flex w-full h-auto rounded-xl gap-1 p-1 bg-[#93c572]">
                <TabsTrigger value="stats" className="flex-1 bg-transparent text-white hover:bg-[#7fb55e] data-[state=active]:!bg-table-felt data-[state=active]:!text-[#f5c542] data-[state=active]:shadow-none data-[state=active]:opacity-100 py-1 px-2 gap-1 text-[13px] normal-case"><BarChart3 className="w-3.5 h-3.5" /> Estadístiques</TabsTrigger>
                <TabsTrigger value="friends" className="flex-1 bg-transparent text-white hover:bg-[#7fb55e] data-[state=active]:!bg-table-felt data-[state=active]:!text-[#f5c542] data-[state=active]:shadow-none data-[state=active]:opacity-100 py-1 px-2 gap-1 text-[13px] normal-case"><Users className="w-3.5 h-3.5" /> Amics</TabsTrigger>
                <TabsTrigger value="messages" className="flex-1 bg-transparent text-white hover:bg-[#7fb55e] data-[state=active]:!bg-table-felt data-[state=active]:!text-[#f5c542] data-[state=active]:shadow-none data-[state=active]:opacity-100 py-1 px-2 gap-1 text-[13px] normal-case"><Mail className="w-3.5 h-3.5" /> Missatges</TabsTrigger>
              </TabsList>


              <TabsContent value="stats" className="mt-3 flex flex-col gap-3">
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                <StatBox icon={<Gamepad2 className="w-4 h-4 text-[#93c572]" />} label="Partides" value={total} accent="text-foreground/30 font-bold text-slate-100" labelClassName="text-[#93c572]" />
                <StatBox icon={<ThumbsDown className="w-4 h-4 text-stone-500" />} label="Abandonades" value={stats?.abandoned ?? 0} accent="text-foreground/30 font-bold text-slate-100 text-[#df2020]" labelClassName="text-stone-500" />
                <StatBox icon={<Trophy className="w-4 h-4 text-[#ef8e39]" />} label="Victòries" value={wins} accent="text-primary font-bold text-[#ef8e39]" valueClassName="text-foreground/30 font-bold text-slate-100" labelClassName="text-[#ef8e39]" />
                <StatBox icon={<X className="w-4 h-4 text-[#df2020]" />} label="Derrotes" value={losses} accent="text-foreground/30 font-bold text-slate-100 text-[#df2020]" labelClassName="text-[#df2020]" />
                <StatBox icon={<Award className="w-4 h-4 text-[#e6b033]" />} label="% Victòries" value={`${winRate}%`} accent="text-foreground/30 font-bold text-slate-100" labelClassName="text-[#e6b033]" />
                <StatBox icon={<Flame className="w-4 h-4 text-[#66a50d]" />} label="Ratxa màx." value={stats?.max_streak ?? 0} accent="font-bold text-slate-100" labelClassName="text-[#66a50d]" />
              </div>

              <div className="p-3 flex items-center justify-center gap-3">
                <div className="text-center">
                  <div className="text-xs text-muted-foreground">El teu codi d'amic</div>
                  <div className="font-mono text-lg tracking-wider text-gold">{profile?.friend_code ?? "—"}</div>
                </div>
                <Button size="sm" variant="outline" onClick={copyCode} className="border-primary/40 text-primary hover:bg-primary/10">
                  <Copy className="w-4 h-4 mr-1" /> Copiar
                </Button>
              </div>

              <div className="flex justify-center">
                <ClassificacionsDialog
                  trigger={
                    <Button size="sm" className="bg-[#f5c542] text-primary-foreground font-semibold hover:bg-[#f5c542]/90">
                      Veure classificacions
                    </Button>
                  }
                />
              </div>
              </TabsContent>

              <TabsContent value="friends" className="mt-3 flex flex-col gap-3">


              <div className="flex flex-col gap-1">
                <Label htmlFor="friend-username" className="text-xs text-muted-foreground">Afegir amic pel seu nom d'usuari</Label>
                <div className="flex gap-2">
                  <Input
                    id="friend-username"
                    placeholder="Nom d'usuari"
                    value={friendInput}
                    onChange={(e) => setFriendInput(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") void handleAddFriend(); }}
                    className="bg-background/40 border-primary/30"
                  />
                  <Button onClick={handleAddFriend} disabled={busy || !friendInput.trim()}>
                    <UserPlus className="w-4 h-4 mr-1" /> {busy ? "Enviant..." : "Afegir"}
                  </Button>
                </div>
              </div>

              <Tabs defaultValue="amics">
                <TabsList className="flex w-full h-auto rounded-xl">
                  <TabsTrigger value="amics" className="text-slate-100 py-1 px-2 flex-1 text-[13px]">Amics ({friends.accepted.length})</TabsTrigger>
                  <TabsTrigger value="rebudes" className="text-slate-100 py-1 px-2 w-auto flex-none text-[13px]">Rebudes ({friends.incoming.length})</TabsTrigger>
                  <TabsTrigger value="enviades" className="text-slate-100 py-1 px-2 w-auto flex-none text-[13px]">Enviades ({friends.outgoing.length})</TabsTrigger>
                </TabsList>

                <TabsContent value="amics" className="avatar-scroll max-h-[45vh] overflow-y-auto space-y-2 mt-3">
                  {friends.accepted.length === 0 && (
                    <p className="text-sm text-muted-foreground text-center py-4">Encara no tens amics. Comparteix el teu codi!</p>
                  )}
                  {friends.accepted.map((f) => (
                    <div key={f.friendship.id} className="flex items-center justify-between rounded-md border border-primary/25 bg-white p-2 py-[2px] pb-[4px]">
                      <PlayerProfileDialog
                        userId={f.other.user_id}
                        fallbackName={f.other.username ?? "Jugador"}
                        trigger={
                          <button type="button" className="flex items-center min-w-0 flex-1 text-left hover:opacity-80 transition -my-[5px] gap-[5px] -ml-[15px] -mt-[6px]">
                            <span className={`w-2.5 h-2.5 rounded-full shrink-0 ${f.online ? "bg-gold" : "bg-muted-foreground/40"}`} title={f.online ? "Connectat" : "Desconnectat"} />
                            <div className="min-w-0">
                              <div className="font-medium truncate text-[hsl(var(--primary-foreground))] normal-case">{labelFor(f.other)}</div>
                              <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs font-bold leading-none">
                                <span className="inline-flex items-center gap-0.5 text-[#f97415]" title="Nivell"><Star className="w-3.5 h-3.5" /> {f.stats?.level ?? 1}</span>
                                <span className="inline-flex items-center gap-0.5 text-[#93c572]" title="Partides"><Gamepad2 className="w-3.5 h-3.5" /> {(f.stats?.wins ?? 0) + (f.stats?.losses ?? 0)}</span>
                                <span className="inline-flex items-center gap-0.5 text-[#ef8e39]" title="Victòries"><Trophy className="w-3.5 h-3.5" /> {f.stats?.wins ?? 0}</span>
                                <span className="inline-flex items-center gap-0.5 text-destructive" title="Derrotes"><X className="w-3.5 h-3.5" /> {f.stats?.losses ?? 0}</span>
                                <span className="inline-flex items-center gap-0.5 text-[#e6b033]" title="% Victòries"><Award className="w-3.5 h-3.5" /> {(((f.stats?.wins ?? 0) + (f.stats?.losses ?? 0)) > 0 ? Math.round(((f.stats?.wins ?? 0) / ((f.stats?.wins ?? 0) + (f.stats?.losses ?? 0))) * 100) : 0)}%</span>
                                <span className="inline-flex items-center gap-0.5 text-[#66a50d]" title="Ratxa màx."><Flame className="w-3.5 h-3.5" /> {f.stats?.max_streak ?? 0}</span>
                              </div>
                            </div>
                          </button>
                        }
                      />
                      <Button size="sm" variant="ghost" className="h-8 w-8 p-0 bg-team-nos text-white hover:bg-team-nos/90" onClick={async () => {
                        const ok = await confirm(t("friends.confirm_remove", { name: labelFor(f.other) }));
                        if (!ok) return;
                        try { await removeFriend(f.other.user_id); friends.reload(); toast.success("Amic eliminat"); }
                        catch (e) { toast.error((e as Error).message); }
                      }} aria-label="Eliminar amic">
                        <X className="w-4 h-4" strokeWidth={3} />
                      </Button>
                    </div>
                  ))}

                </TabsContent>

                <TabsContent value="rebudes" className="avatar-scroll max-h-[45vh] overflow-y-auto space-y-2 mt-3">
                  {friends.incoming.length === 0 && (
                    <p className="text-sm text-muted-foreground text-center py-4">No tens sol·licituds pendents.</p>
                  )}
                  {friends.incoming.map((f) => (
                    <div key={f.friendship.id} className="flex items-center justify-between rounded-md border border-primary/25 bg-white p-2 py-[2px] pb-[4px]">
                      <PlayerProfileDialog
                        userId={f.other.user_id}
                        fallbackName={f.other.username ?? "Jugador"}
                        trigger={
                          <button type="button" className="min-w-0 flex-1 text-left hover:opacity-80 transition">
                            <div className="font-medium truncate text-[hsl(var(--primary-foreground))] normal-case">{labelFor(f.other)}</div>
                            <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs font-bold leading-none">
                              <span className="inline-flex items-center gap-0.5 text-[#f97415]" title="Nivell"><Star className="w-3.5 h-3.5" /> {f.stats?.level ?? 1}</span>
                              <span className="inline-flex items-center gap-0.5 text-[#93c572]" title="Partides"><Gamepad2 className="w-3.5 h-3.5" /> {(f.stats?.wins ?? 0) + (f.stats?.losses ?? 0)}</span>
                              <span className="inline-flex items-center gap-0.5 text-[#ef8e39]" title="Victòries"><Trophy className="w-3.5 h-3.5" /> {f.stats?.wins ?? 0}</span>
                              <span className="inline-flex items-center gap-0.5 text-destructive" title="Derrotes"><X className="w-3.5 h-3.5" /> {f.stats?.losses ?? 0}</span>
                              <span className="inline-flex items-center gap-0.5 text-[#e6b033]" title="% Victòries"><Award className="w-3.5 h-3.5" /> {(((f.stats?.wins ?? 0) + (f.stats?.losses ?? 0)) > 0 ? Math.round(((f.stats?.wins ?? 0) / ((f.stats?.wins ?? 0) + (f.stats?.losses ?? 0))) * 100) : 0)}%</span>
                              <span className="inline-flex items-center gap-0.5 text-[#66a50d]" title="Ratxa màx."><Flame className="w-3.5 h-3.5" /> {f.stats?.max_streak ?? 0}</span>
                            </div>
                          </button>
                        }
                      />

                      <div className="flex gap-1 shrink-0 ml-2">
                        <Button size="sm" variant="ghost" className="h-8 w-8 p-0 bg-emerald-500 text-white hover:bg-emerald-500/90" onClick={async () => {
                          try { await respondFriendRequest(f.friendship.id, true); friends.reload(); toast.success("Acceptat"); }
                          catch (e) { toast.error((e as Error).message); }
                        }} aria-label="Acceptar">
                          <Check className="w-4 h-4" strokeWidth={3} />
                        </Button>
                        <Button size="sm" variant="ghost" className="h-8 w-8 p-0 bg-team-nos text-white hover:bg-team-nos/90" onClick={async () => {
                           const ok = await confirm(t("friends.confirm_cancel_incoming", { name: labelFor(f.other) }));
                           if (!ok) return;
                           try { await respondFriendRequest(f.friendship.id, false); friends.reload(); }
                           catch (e) { toast.error((e as Error).message); }
                         }} aria-label="Rebutjar">
                          <X className="w-4 h-4" strokeWidth={3} />
                        </Button>
                      </div>
                    </div>
                  ))}
                </TabsContent>

                <TabsContent value="enviades" className="avatar-scroll max-h-[45vh] overflow-y-auto space-y-2 mt-3">
                  {friends.outgoing.length === 0 && (
                    <p className="text-sm text-muted-foreground text-center py-4">No has enviat sol·licituds.</p>
                  )}
                  {friends.outgoing.map((f) => (
                    <div key={f.friendship.id} className="flex items-center justify-between rounded-md border border-primary/25 bg-white p-2 py-[2px] pb-[4px]">
                      <PlayerProfileDialog
                        userId={f.other.user_id}
                        fallbackName={f.other.username ?? "Jugador"}
                        trigger={
                          <button type="button" className="min-w-0 flex-1 text-left hover:opacity-80 transition">
                            <div className="font-medium truncate text-[hsl(var(--primary-foreground))] normal-case">{labelFor(f.other)}</div>
                            <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs font-bold leading-none">
                              <span className="inline-flex items-center gap-0.5 text-[#f97415]" title="Nivell"><Star className="w-3.5 h-3.5" /> {f.stats?.level ?? 1}</span>
                              <span className="inline-flex items-center gap-0.5 text-[#93c572]" title="Partides"><Gamepad2 className="w-3.5 h-3.5" /> {(f.stats?.wins ?? 0) + (f.stats?.losses ?? 0)}</span>
                              <span className="inline-flex items-center gap-0.5 text-[#ef8e39]" title="Victòries"><Trophy className="w-3.5 h-3.5" /> {f.stats?.wins ?? 0}</span>
                              <span className="inline-flex items-center gap-0.5 text-destructive" title="Derrotes"><X className="w-3.5 h-3.5" /> {f.stats?.losses ?? 0}</span>
                              <span className="inline-flex items-center gap-0.5 text-[#e6b033]" title="% Victòries"><Award className="w-3.5 h-3.5" /> {(((f.stats?.wins ?? 0) + (f.stats?.losses ?? 0)) > 0 ? Math.round(((f.stats?.wins ?? 0) / ((f.stats?.wins ?? 0) + (f.stats?.losses ?? 0))) * 100) : 0)}%</span>
                              <span className="inline-flex items-center gap-0.5 text-[#66a50d]" title="Ratxa màx."><Flame className="w-3.5 h-3.5" /> {f.stats?.max_streak ?? 0}</span>

                            </div>
                          </button>
                        }
                      />
                      <Button size="sm" variant="ghost" className="shrink-0 ml-2 h-8 w-8 p-0 bg-team-nos text-white hover:bg-team-nos/90" onClick={async () => {
                        const ok = await confirm(t("friends.confirm_cancel_outgoing", { name: labelFor(f.other) }));
                        if (!ok) return;
                        try { await removeFriend(f.other.user_id); friends.reload(); }
                        catch (e) { toast.error((e as Error).message); }
                      }} aria-label="Cancel·lar">
                        <X className="w-4 h-4" strokeWidth={3} />
                      </Button>
                    </div>
                  ))}
                </TabsContent>
              </Tabs>
            </TabsContent>

            <TabsContent value="messages" className="mt-3">
              <MessagesInbox userId={user.id} />
            </TabsContent>
            </Tabs>
          </>
        )}
      </div>
      {confirmDialog}
    </main>
  );
}

function StatBox({ icon, label, value, accent, accentStyle, valueClassName, labelClassName }: { icon: React.ReactNode; label: string; value: React.ReactNode; accent?: string; accentStyle?: React.CSSProperties; valueClassName?: string; labelClassName?: string }) {
  return (
    <div className="rounded-md border border-primary/25 bg-background/40 p-3 text-center">
      <div className={`flex items-center justify-center gap-1 text-[13px] mb-1 ${accent ?? "text-muted-foreground"}`} style={accentStyle}>
        {icon}<span className={labelClassName}>{label}</span>
      </div>
      <div className={`text-xl font-bold ${valueClassName ?? accent ?? "text-foreground"}`} style={valueClassName ? undefined : accentStyle}>{value}</div>
    </div>
  );
}


export default function Perfil() {
  return <ClientOnly fallback={<Loading />}><PerfilInner /></ClientOnly>;
}