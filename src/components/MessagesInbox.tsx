import { useEffect, useState } from "react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Trash2 } from "lucide-react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { useAdminPassword } from "@/hooks/useAdminPassword";
import { useInbox, formatSender, type InboxMessage } from "@/lib/messagesInbox";
import { fetchPlayerNamesByUserIds } from "@/lib/playerNames";
import { PlayerProfileDialog } from "@/online/PlayerProfileDialog";

export function MessagesInbox({ userId, compact = false, hideAdminCounter = false }: { userId: string; compact?: boolean; hideAdminCounter?: boolean }) {
  const { isAdmin } = useAdminPassword();
  const { messages, broadcasts, loading, reload } = useInbox(userId);

  const [to, setTo] = useState("");
  const [subject, setSubject] = useState("");
  const [content, setContent] = useState("");
  const [asBroadcast, setAsBroadcast] = useState(false);
  const [sending, setSending] = useState(false);

  const resolveReceiver = async (input: string): Promise<string | null> => {
    const v = input.trim();
    if (!v) return null;
    const db = supabase as any;
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)) return v;
    const { data } = await db.from("profiles").select("user_id").or(`username.eq.${v},display_name.eq.${v}`).maybeSingle();
    return data?.user_id ?? null;
  };

  const onSend = async () => {
    if (!content.trim()) { toast.error("Escriu un missatge"); return; }
    setSending(true);
    try {
      const db = supabase as any;
      if (asBroadcast && isAdmin) {
        const { error } = await db.from("admin_broadcasts").insert({
          subject: subject.trim() || null,
          content: content.trim(),
          sender_id: userId,
        });
        if (error) throw error;
        toast.success("Comunicat enviat");
      } else {
        const receiverId = await resolveReceiver(to);
        if (!receiverId) { toast.error("Destinatari no trobat"); setSending(false); return; }
        const { error } = await db.from("user_messages").insert({
          sender_id: userId,
          receiver_id: receiverId,
          subject: subject.trim() || null,
          content: content.trim(),
        });
        if (error) throw error;
        toast.success("Missatge enviat");
      }
      setTo(""); setSubject(""); setContent(""); setAsBroadcast(false);
      void reload();
    } catch (e: any) {
      toast.error(e?.message ?? "Error en enviar");
    } finally {
      setSending(false);
    }
  };

  const unreadCount = messages.filter((m) => !m.read_at).length;
  const lastSeenBroadcasts = (typeof window !== "undefined" ? localStorage.getItem("broadcasts:lastSeenAt") : null) ?? "1970-01-01T00:00:00Z";
  const newBroadcastsCount = broadcasts.filter((b) => b.created_at > lastSeenBroadcasts).length;

  return (
    <Tabs defaultValue="rebuts" className="w-full">
      <TabsList className="flex w-full h-auto rounded-xl">
        <TabsTrigger value="rebuts" className="text-slate-100 py-1 px-2 w-auto flex-none text-[13px]">Rebuts{!compact ? ` (${unreadCount})` : ""}</TabsTrigger>
        <TabsTrigger value="avisos" className="text-slate-100 py-1 px-2 w-auto flex-none text-[13px]">Avisos Admin{!compact && !hideAdminCounter ? ` (${newBroadcastsCount})` : ""}</TabsTrigger>
        <TabsTrigger value="enviar" className="text-slate-100 py-1 px-2 flex-1 text-[13px]">Enviar</TabsTrigger>
      </TabsList>

      <TabsContent value="rebuts" className="avatar-scroll max-h-[55vh] overflow-y-auto space-y-2 mt-3 pr-1">
        {loading && <p className="text-xs text-muted-foreground">Carregant…</p>}
        {!loading && messages.length === 0 && <p className="text-xs text-muted-foreground">Cap missatge.</p>}
        {messages.map((m) => (
          <MessageRow key={m.id} message={m} onDeleted={() => reload()} />
        ))}
      </TabsContent>

      <TabsContent value="avisos" className="avatar-scroll max-h-[55vh] overflow-y-auto space-y-2 mt-3 pr-1">
        {loading && <p className="text-xs text-muted-foreground">Carregant…</p>}
        {!loading && broadcasts.length === 0 && <p className="text-xs text-muted-foreground">Cap avís.</p>}
        {broadcasts.map((b) => (
          <div key={b.id} className="border border-primary/40 rounded-md p-2 text-sm bg-primary/5">
            {b.subject && <div className="font-semibold text-primary">{b.subject}</div>}
            <div className="whitespace-pre-wrap">{b.content}</div>
            <div className="text-[10px] text-muted-foreground mt-1">{new Date(b.created_at).toLocaleString()}</div>
          </div>
        ))}
      </TabsContent>

      <TabsContent value="enviar" className="space-y-3 mt-3">
        {!asBroadcast && (
          <div className="space-y-1">
            <Label htmlFor="msg-to" className="text-xs">Destinatari (ID o username)</Label>
            <Input id="msg-to" value={to} onChange={(e) => setTo(e.target.value)} placeholder="UUID o username" />
          </div>
        )}
        <div className="space-y-1">
          <Label htmlFor="msg-subj" className="text-xs">Assumpte</Label>
          <Input id="msg-subj" value={subject} onChange={(e) => setSubject(e.target.value)} maxLength={120} />
        </div>
        <div className="space-y-1">
          <Label htmlFor="msg-body" className="text-xs">Missatge</Label>
          <Textarea id="msg-body" value={content} onChange={(e) => setContent(e.target.value)} rows={4} maxLength={2000} />
        </div>
        {isAdmin && (
          <label className="flex items-center gap-2 text-xs">
            <Checkbox checked={asBroadcast} onCheckedChange={(v) => setAsBroadcast(!!v)} />
            <span>Enviar com a comunicat global (admin)</span>
          </label>
        )}
        <Button onClick={onSend} disabled={sending} className="w-full">
          {sending ? "Enviant…" : asBroadcast ? "Publicar comunicat" : "Enviar missatge"}
        </Button>
      </TabsContent>
    </Tabs>
  );
}

function MessageRow({ message, onDeleted }: { message: InboxMessage; onDeleted: () => void }) {
  const initialName = message.sender_id
    ? formatSender(message.sender_display_name, message.sender_username)
    : "Desconegut";
  const [senderName, setSenderName] = useState<string>(initialName);
  const [open, setOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    if (!message.sender_id) return;
    if (message.sender_display_name || message.sender_username) {
      setSenderName(formatSender(message.sender_display_name, message.sender_username));
      return;
    }
    let alive = true;
    (async () => {
      try {
        const m = await fetchPlayerNamesByUserIds([message.sender_id!]);
        if (alive) setSenderName(m.get(message.sender_id!) ?? "Jugador");
      } catch { /* noop */ }
    })();
    return () => { alive = false; };
  }, [message.sender_id, message.sender_display_name, message.sender_username]);

  const handleDelete = async () => {
    setDeleting(true);
    try {
      const db = supabase as any;
      const { error } = await db.from("user_messages").delete().eq("id", message.id);
      if (error) throw error;
      toast.success("Missatge eliminat");
      setOpen(false);
      onDeleted();
    } catch (e: any) {
      toast.error(e?.message ?? "Error en eliminar");
    } finally {
      setDeleting(false);
    }
  };

  const dateStr = new Date(message.created_at).toLocaleString();

  return (
    <>
      <div className="border border-border rounded-md p-2 bg-background/40">
        <div className="text-[11px] text-muted-foreground text-right truncate normal-case">
          Enviat per{" "}
          {message.sender_id ? (
            <PlayerProfileDialog
              userId={message.sender_id}
              fallbackName={senderName}
              trigger={
                <button type="button" className="text-gold hover:underline font-semibold normal-case">
                  {senderName}
                </button>
              }
            />
          ) : (
            <span className="text-gold font-semibold normal-case">{senderName}</span>
          )}
          {" - "}{dateStr}
        </div>
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="block w-full text-left hover:opacity-80 transition"
        >
          <div className="font-sans font-bold text-primary text-sm normal-case truncate">
            {message.subject || "(sense assumpte)"}
          </div>
          <div className="font-sans font-normal text-sm text-foreground/90 leading-relaxed normal-case truncate">
            {message.content}
          </div>
        </button>
      </div>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="w-[90vw] sm:max-w-md max-h-[85vh] overflow-y-auto rounded-2xl border-primary/30 gap-2">
          <DialogHeader>
            <DialogTitle className="font-title font-black italic text-gold text-2xl text-center normal-case">
              Missatge
            </DialogTitle>
          </DialogHeader>
          <div className="text-[11px] text-muted-foreground text-right normal-case">
            Enviat per <span className="text-gold font-semibold">{senderName}</span> - {dateStr}
          </div>
          <div className="font-sans font-bold text-primary text-sm text-left normal-case mt-0.5">
            {message.subject || "(sense assumpte)"}
          </div>
          <div className="whitespace-pre-wrap font-sans font-normal text-sm text-foreground/90 leading-relaxed text-left normal-case mt-0.5">
            {message.content}
          </div>
          <div className="flex justify-end mt-1.5">
            <Button
              variant="destructive"
              size="sm"
              onClick={handleDelete}
              disabled={deleting}
            >
              <Trash2 className="w-4 h-4 mr-1" />
              {deleting ? "Eliminant…" : "Borrar missatge"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}