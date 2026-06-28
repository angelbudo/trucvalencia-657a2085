import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import {
  Loader2,
  LogOut,
  RefreshCw,
  ShieldCheck,
  ShieldX,
  Inbox,
  History,
  MessageSquare,
  HandHeart,
  AlertTriangle,
  ShieldAlert,
  Trash2,
  User,
  Mail,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { useAuth } from "@/hooks/useAuth";
import { useMyRole } from "@/hooks/useMyRole";
import { ShareAppButton } from "@/components/ShareAppButton";
import { useT } from "@/i18n/useT";
import {
  listInboxFlags,
  listAuditEntries,
  decideFlag,
  deleteAuditEntries,
  deleteAllAuditEntries,
  type InboxFlag,
  type AuditEntry,
  type FlagDecision,
  type FlagStatus,
} from "@/online/moderationInbox";

const TABS: { value: FlagStatus | "all"; labelKey: string }[] = [
  { value: "pending", labelKey: "mod.tab.pending" },
  { value: "approved", labelKey: "mod.tab.approved" },
  { value: "dismissed", labelKey: "mod.tab.dismissed" },
  { value: "all", labelKey: "mod.tab.all" },
];

// Fallback labels (project i18n dict may not have these keys yet).
const FALLBACK: Record<string, string> = {
  "mod.tab.pending": "Pendents",
  "mod.tab.approved": "Aprovats",
  "mod.tab.dismissed": "Desestimats",
  "mod.tab.all": "Tots",
  "mod.status.pending": "Pendent",
  "mod.status.approved": "Aprovat",
  "mod.status.dismissed": "Desestimat",
  "mod.status.forgiven": "Perdonat",
};
function lbl(t: ReturnType<typeof useT>, key: string): string {
  const v = t(key as never);
  return v && v !== key ? v : FALLBACK[key] ?? key;
}

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString("ca-ES", { dateStyle: "short", timeStyle: "short" });
  } catch {
    return iso;
  }
}

function truncate(s: string | null | undefined, n = 14): string {
  const str = s ?? "";
  return str.length <= n ? str : `${str.slice(0, n)}…`;
}

function SourceBadge({ source }: { source: InboxFlag["source"] }) {
  if (source === "local-blacklist") {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-medium bg-orange-500/15 text-orange-600 border border-orange-500/30">
        Blacklist local
      </span>
    );
  }
  if (source === "openai-moderation") {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-medium bg-violet-500/15 text-violet-600 border border-violet-500/30">
        OpenAI
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-medium bg-slate-500/15 text-slate-600 border border-slate-500/30">
      Jugador
    </span>
  );
}

function StatusBadge({ status, label }: { status: FlagStatus; label: string }) {
  // Fons igual al de la pantalla (verd fosc), text colorit segons l'estat.
  const color =
    status === "pending" ? "text-amber-400 border-amber-500/40"
    : status === "approved" ? "text-destructive border-destructive/40"
    : "text-emerald-400 border-emerald-500/40";
  return (
    <span className={cn("text-[10px] px-2 py-0.5 rounded bg-background border", color)}>
      {label}
    </span>
  );
}

function UserLine({ name, username, email, deviceId }: { name: string | null; username: string | null; email: string | null; deviceId: string | null }) {
  const display = name
    ? (username ? `${name} (${username})` : name)
    : (username ? `(${username})` : "—");
  return (
    <div className="text-xs flex flex-col gap-0.5">
      <span className="flex items-center gap-1.5 text-foreground/90 min-w-0">
        <User className="w-3.5 h-3.5 shrink-0 text-muted-foreground" />
        <span className="font-medium truncate">{display}</span>
      </span>
      <span className="flex items-center gap-1.5 text-muted-foreground min-w-0">
        <Mail className="w-3.5 h-3.5 shrink-0" />
        <span className="truncate">{email || "—"}</span>
      </span>
      <span className="text-[10px] text-muted-foreground/70">
        <code>{truncate(deviceId, 18)}</code>
      </span>
    </div>
  );
}

export default function Moderacio() {
  const navigate = useNavigate();
  const t = useT();
  const { user, ready: authReady } = useAuth();
  const { role, isAdmin, isModerator, ready: roleReady } = useMyRole();

  const [status, setStatus] = useState<FlagStatus | "all">("pending");
  const [flags, setFlags] = useState<InboxFlag[]>([]);
  const [audit, setAudit] = useState<AuditEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadingAudit, setLoadingAudit] = useState(false);
  const [working, setWorking] = useState<number | null>(null);
  const [notes, setNotes] = useState<Record<number, string>>({});
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [confirmBulk, setConfirmBulk] = useState<"none" | "selected" | "all">("none");

  useEffect(() => {
    document.title = "Moderació · Truc Valencià";
  }, []);

  useEffect(() => {
    if (!authReady || !roleReady) return;
    if (!user || !isModerator) {
      navigate("/", { replace: true });
    }
  }, [authReady, roleReady, user, isModerator, navigate]);

  const refresh = useCallback(async () => {
    if (!isModerator) return;
    setLoading(true);
    try {
      const list = await listInboxFlags(status);
      setFlags(list);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [isModerator, status]);

  const refreshAudit = useCallback(async () => {
    if (!isModerator) return;
    setLoadingAudit(true);
    try {
      const entries = await listAuditEntries();
      setAudit(entries);
      setSelected(new Set());
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setLoadingAudit(false);
    }
  }, [isModerator]);

  useEffect(() => {
    if (isModerator) void refresh();
  }, [isModerator, refresh]);

  useEffect(() => {
    if (!isModerator || status !== "pending") return;
    const id = window.setInterval(() => { void refresh(); }, 20000);
    return () => window.clearInterval(id);
  }, [isModerator, status, refresh]);

  const counts = useMemo(() => {
    const c = { pending: 0, approved: 0, dismissed: 0 };
    for (const f of flags) c[f.status]++;
    return c;
  }, [flags]);

  if (!authReady || !roleReady) {
    return (
      <main className="min-h-screen flex items-center justify-center">
        <Loader2 className="w-6 h-6 animate-spin text-primary" />
      </main>
    );
  }
  if (!user || !isModerator) return null;

  async function handleDecide(flag: InboxFlag, decision: FlagDecision) {
    if (decision === "forgiven" && !isAdmin) {
      toast.error("Només l'administrador pot perdonar punts.");
      return;
    }
    setWorking(flag.id);
    try {
      const tag = user?.email ?? user?.id ?? "moderator";
      const res = await decideFlag({
        flag,
        decision,
        userId: user!.id,
        moderatorTag: tag,
        note: notes[flag.id]?.trim() || undefined,
      });
      const label =
        decision === "approved" ? "Baneig aprovat — silenciament mantingut."
        : decision === "forgiven" ? "Punts perdonats — flag arxivat."
        : decision === "dismissed" ? "Flag desestimat."
        : "Flag reobert.";
      toast.success(label);
      if (res.auditError) {
        toast.warning(`Decisió aplicada però l'auditoria ha fallat: ${res.auditError}`);
      }
      await refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setWorking(null);
    }
  }

  function toggleSelect(id: number) {
    setSelected((p) => {
      const next = new Set(p);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  async function handleBulkDelete(mode: "selected" | "all") {
    try {
      if (mode === "all") {
        await deleteAllAuditEntries();
        toast.success("Historial esborrat.");
      } else {
        await deleteAuditEntries(Array.from(selected));
        toast.success(`${selected.size} registre(s) esborrat(s).`);
      }
      setConfirmBulk("none");
      await refreshAudit();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <main className="menu-screen min-h-screen px-4 py-5 pb-24 bg-background text-foreground normal-case [&_button]:!normal-case [&_[role=tab]]:!normal-case">
      <div className="w-full max-w-4xl mx-auto flex flex-col gap-3">
        {/* Top action row (igual que /ajustes) */}
        <div className="flex items-center justify-between">
          <ShareAppButton />
          <Button
            asChild
            size="sm"
            variant="outline"
            className="h-8 w-8 p-0 border-foreground/80 text-foreground hover:bg-foreground/10"
            aria-label="Tornar"
            title="Tornar"
          >
            <Link to="/"><LogOut className="w-4 h-4" /></Link>
          </Button>
        </div>

        {/* Title block */}
        <header className="text-center">
          <h1 className="font-title font-black italic text-gold text-2xl md:text-3xl leading-none">
            Moderació
          </h1>
          <p className="mt-1 text-xs text-muted-foreground">
            Bústia de reports de xat · rol:{" "}
            <span className={cn("font-medium", isAdmin ? "text-destructive" : "text-amber-500")}>
              {role}
            </span>
          </p>
        </header>

        <Tabs defaultValue="inbox" className="w-full mt-[10px]">
          <TabsList className="grid w-full grid-cols-2">
            <TabsTrigger value="inbox" className="gap-1.5">
              <Inbox className="w-4 h-4" /> Alertes
              {counts.pending > 0 && (
                <span className="ml-1 inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full bg-destructive text-[10px] text-destructive-foreground">
                  {counts.pending}
                </span>
              )}
            </TabsTrigger>
            <TabsTrigger value="audit" className="gap-1.5" onClick={() => void refreshAudit()}>
              <History className="w-4 h-4" /> Historial
            </TabsTrigger>
          </TabsList>

          {/* === INBOX ============================================== */}
          <TabsContent value="inbox" className="mt-4 flex flex-col gap-3">
            <div className="flex w-full max-w-full items-center justify-between gap-1 overflow-hidden">
              {TABS.map((t2) => (
                <button
                  key={t2.value}
                  type="button"
                  onClick={() => setStatus(t2.value)}
                  className={cn(
                    "h-[30px] px-1.5 sm:px-2.5 rounded-md text-[12px] sm:text-[14px] font-medium border whitespace-nowrap transition-colors shrink-0",
                    status === t2.value
                      ? "bg-primary text-primary-foreground border-primary"
                      : "bg-background border-border hover:bg-muted",
                  )}
                >
                  {lbl(t, t2.labelKey)}
                </button>
              ))}
            </div>
            <div className="flex items-center justify-end gap-2 -mt-1">
              <span className="text-[11px] text-muted-foreground">
                {flags.length} flag{flags.length === 1 ? "" : "s"}
              </span>
              <Button onClick={() => void refresh()} size="sm" variant="outline"
                disabled={loading} className="h-7 w-7 p-0 shrink-0">
                <RefreshCw className={cn("w-4 h-4", loading && "animate-spin")} />
              </Button>
            </div>


            {loading && flags.length === 0 ? (
              <div className="flex justify-center py-10"><Loader2 className="w-5 h-5 animate-spin text-primary" /></div>
            ) : flags.length === 0 ? (
              <p className="text-center text-sm text-muted-foreground py-10">
                Cap alerta.
              </p>
            ) : (
              <div className="avatar-scroll max-h-[60vh] overflow-y-auto pr-2">
                <ul className="flex flex-col gap-3">
                  {flags.map((f) => {
                    const isWorking = working === f.id;
                    const isSevere = f.weight >= 2;
                    return (
                      <li
                        key={f.id}
                        className={cn(
                          "rounded-lg border p-3 flex flex-col gap-2 shadow-sm",
                          isSevere
                            ? "border-destructive/50 bg-destructive/5"
                            : "border-orange-500/40 bg-orange-500/5",
                        )}

                      >
                        <div className="flex items-start justify-between gap-2 flex-wrap">
                          <div className="flex items-center gap-2 flex-wrap">
                            <StatusBadge status={f.status} label={lbl(t, `mod.status.${f.status}`)} />
                            <SourceBadge source={f.source} />
                            <span className={cn(
                              "text-[10px] px-2 py-0.5 rounded border",
                              isSevere
                                ? "bg-destructive/10 text-destructive border-destructive/30"
                                : "bg-amber-500/10 text-amber-500 border-amber-500/30",
                            )}>
                              {f.reason ?? "sense motiu"} · pes {f.weight}
                            </span>
                          </div>
                          <span className="text-[11px] text-muted-foreground">{formatDate(f.createdAt)}</span>
                        </div>

                        <UserLine name={f.targetName} username={f.targetUsername} email={f.targetEmail} deviceId={f.targetDeviceId} />

                        {f.messageText ? (
                          <div className={cn(
                            "rounded-md p-2 border flex items-start gap-2 bg-background",
                            isSevere
                              ? "border-destructive/30 text-destructive"
                              : "border-orange-500/30 text-orange-300",
                          )}>
                            {isSevere
                              ? <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
                              : <MessageSquare className="w-4 h-4 mt-0.5 shrink-0" />}
                            <p className="text-sm font-medium break-words italic">"{f.messageText}"</p>
                          </div>

                        ) : (
                          <p className="text-xs text-muted-foreground italic">[Missatge no disponible]</p>
                        )}

                        <div className="text-xs text-muted-foreground flex flex-wrap gap-x-3 gap-y-1">
                          <span>
                            <span className="font-medium text-foreground/80">Sala:</span>{" "}
                            <code className="text-[11px]">{f.roomName ?? truncate(f.roomId, 8)}</code>
                          </span>
                          {f.decidedAt && <span>Decidit {formatDate(f.decidedAt)}</span>}
                        </div>

                        {f.status === "pending" && (
                          <Input
                            value={notes[f.id] ?? ""}
                            onChange={(e) => setNotes((p) => ({ ...p, [f.id]: e.target.value.slice(0, 500) }))}
                            placeholder="Nota interna (opcional)"
                            disabled={isWorking}
                            className="h-8 text-xs"
                            maxLength={500}
                          />
                        )}

                        <div className="flex flex-wrap items-center gap-1.5 pt-1 overflow-hidden">
                          {f.status !== "approved" && (
                            <Button size="sm" variant="destructive" disabled={isWorking}
                              className="h-auto px-3 py-1.5 text-[13px] sm:text-[14px]"
                              onClick={() => void handleDecide(f, "approved")}>
                              <ShieldCheck className="w-3.5 h-3.5 mr-1 shrink-0" /> Aprovar baneig
                            </Button>
                          )}
                          {f.status !== "dismissed" && (
                            <Button size="sm" variant="outline" disabled={isWorking}
                              className="h-auto px-3 py-1.5 text-[13px] sm:text-[14px]"
                              onClick={() => void handleDecide(f, "dismissed")}>
                              <ShieldX className="w-3.5 h-3.5 mr-1 shrink-0" /> Desestimar
                            </Button>
                          )}
                          {isAdmin && f.status !== "dismissed" && (
                            <Button size="sm" variant="ghost" disabled={isWorking}
                              className="h-auto px-3 py-1.5 text-[13px] sm:text-[14px] text-emerald-500 hover:text-emerald-400 hover:bg-emerald-500/10"
                              onClick={() => void handleDecide(f, "forgiven")}>
                              <HandHeart className="w-3.5 h-3.5 mr-1 shrink-0" /> Perdonar punts
                            </Button>
                          )}
                          {f.status !== "pending" && (
                            <Button size="sm" variant="outline" disabled={isWorking}
                              className="h-auto px-3 py-1.5 text-[13px] sm:text-[14px] bg-background"
                              onClick={() => void handleDecide(f, "pending")}>
                              Reobrir
                            </Button>
                          )}
                        </div>
                      </li>
                    );
                  })}
                </ul>
              </div>
            )}
          </TabsContent>

          {/* === AUDIT ============================================== */}
          <TabsContent value="audit" className="mt-4 flex flex-col gap-3">
            <div className="text-xs text-muted-foreground">
              {audit.length} entrades · {selected.size} seleccionades
            </div>

            <div className="flex w-full max-w-full items-center justify-between gap-2 overflow-hidden">
              <Button onClick={() => setConfirmBulk("selected")} size="sm" variant="outline"
                disabled={selected.size === 0}
                className="border-destructive/40 text-destructive hover:bg-destructive/10 bg-background text-[13px] sm:text-[15px] px-3 h-8 whitespace-nowrap">
                <Trash2 className="w-3.5 h-3.5 mr-1 shrink-0" /> Esborrar
              </Button>

              <Button onClick={() => setConfirmBulk("all")} size="sm" variant="outline"
                disabled={audit.length === 0}
                className="border-destructive/60 text-destructive hover:bg-destructive/10 bg-background text-[13px] sm:text-[15px] px-3 h-8 whitespace-nowrap">
                <Trash2 className="w-3.5 h-3.5 mr-1 shrink-0" /> Esborrar tot
              </Button>

              <Button onClick={() => void refreshAudit()} size="sm" variant="outline"
                disabled={loadingAudit} className="h-8 w-8 p-0 shrink-0">
                <RefreshCw className={cn("w-4 h-4", loadingAudit && "animate-spin")} />
              </Button>
            </div>

            {confirmBulk !== "none" && (
              <div className="rounded-md border border-destructive/40 bg-background p-2 flex flex-col gap-2">
                <div className="flex items-center gap-2">
                  <ShieldAlert className="w-4 h-4 text-destructive shrink-0" />
                  <span className="text-xs text-destructive flex-1">
                    {confirmBulk === "all"
                      ? "Segur que vols esborrar TOT l'historial? Aquesta acció no es pot desfer."
                      : `Esborrar ${selected.size} registre(s) seleccionat(s)?`}
                  </span>
                </div>
                <div className="flex items-center justify-end gap-2">
                  <Button size="sm" variant="outline" className="bg-background" onClick={() => setConfirmBulk("none")}>Cancel·lar</Button>
                  <Button size="sm" variant="destructive" onClick={() => void handleBulkDelete(confirmBulk as "selected" | "all")}>
                    Confirmar
                  </Button>
                </div>
              </div>
            )}


            {loadingAudit && audit.length === 0 ? (
              <div className="flex justify-center py-10"><Loader2 className="w-5 h-5 animate-spin text-primary" /></div>
            ) : audit.length === 0 ? (
              <p className="text-center text-sm text-muted-foreground py-10">
                Cap decisió registrada encara.
              </p>
            ) : (
              <div className="avatar-scroll max-h-[60vh] overflow-y-auto pr-2">
                <ul className="flex flex-col gap-2">
                  {audit.map((a) => {
                    const checked = selected.has(a.id);
                    const sev = ((a.reason ?? "").toLowerCase().match(/llenguatge|amenaça|amenaza/)) ? 2 : 1;
                    const isSev = sev >= 2;
                    return (
                      <li key={a.id} className={cn(
                        "rounded-md border p-2.5 text-sm flex gap-2",
                        isSev ? "border-destructive/50 bg-destructive/5" : "border-orange-500/40 bg-orange-500/5",
                        checked && "ring-1 ring-primary/60",
                      )}>

                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => toggleSelect(a.id)}
                          className="mt-1 h-4 w-4 shrink-0 accent-primary cursor-pointer"
                          aria-label="Seleccionar"
                        />
                        <div className="flex-1 min-w-0 flex flex-col gap-1">
                          <div className="flex items-center justify-between gap-2 flex-wrap">
                            <StatusBadge
                              status={(a.decision === "forgiven" ? "dismissed" : a.decision) as FlagStatus}
                              label={lbl(t, `mod.status.${a.decision}`)}
                            />
                            <span className="text-[11px] text-muted-foreground">{formatDate(a.decidedAt)}</span>
                          </div>
                          <UserLine name={a.targetName} username={a.targetUsername} email={a.targetEmail} deviceId={a.targetDeviceId} />
                          {a.messageText ? (
                            <p className="text-xs italic break-words">"{a.messageText}"</p>
                          ) : (
                            <p className="text-xs text-muted-foreground italic">[Missatge no disponible]</p>
                          )}
                          <div className="text-[11px] text-muted-foreground flex flex-wrap gap-x-3">
                            <span>flag #{a.flagId}</span>
                            {a.roomName && <span>sala: <code>{a.roomName}</code></span>}
                            {a.reason && <span>motiu: {a.reason}</span>}
                          </div>
                          {a.moderatorNote && (
                            <p className="text-[11px] text-foreground/80">📝 {a.moderatorNote}</p>
                          )}
                        </div>
                      </li>
                    );
                  })}
                </ul>
              </div>
            )}
          </TabsContent>
        </Tabs>
      </div>
    </main>
  );
}