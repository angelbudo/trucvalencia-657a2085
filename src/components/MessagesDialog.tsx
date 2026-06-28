import { useEffect, useState, useCallback } from "react";
import { Mail } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { useAdminPassword } from "@/hooks/useAdminPassword";

type UserMessage = {
  id: string;
  sender_id: string | null;
  receiver_id: string;
  subject: string | null;
  content: string;
  created_at: string;
  read_at: string | null;
};

type AdminBroadcast = {
  id: string;
  subject: string | null;
  content: string;
  created_at: string;
};

const db = supabase as any;

export default function MessagesDialog() {
  const { user } = useAuth();
  const { isAdmin } = useAdminPassword();
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<UserMessage[]>([]);
  const [broadcasts, setBroadcasts] = useState<AdminBroadcast[]>([]);
  const [loading, setLoading] = useState(false);

  // form
  const [to, setTo] = useState("");
  const [subject, setSubject] = useState("");
  const [content, setContent] = useState("");
  const [asBroadcast, setAsBroadcast] = useState(false);
  const [sending, setSending] = useState(false);

  const load = useCallback(async () => {
    if (!user) return;
    setLoading(true);
    const [m, b] = await Promise.all([
      db.from("user_messages").select("*").eq("receiver_id", user.id).order("created_at", { ascending: false }),
      db.from("admin_broadcasts").select("*").order("created_at", { ascending: false }),
    ]);
    if (m.data) setMessages(m.data);
    if (b.data) setBroadcasts(b.data);
    setLoading(false);
  }, [user]);

  useEffect(() => {
    if (open) void load();
  }, [open, load]);

  const resolveReceiver = async (input: string): Promise<string | null> => {
    const v = input.trim();
    if (!v) return null;
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)) return v;
    const { data } = await db.from("profiles").select("user_id").or(`username.eq.${v},display_name.eq.${v}`).maybeSingle();
    return data?.user_id ?? null;
  };

  const onSend = async () => {
    if (!user) { toast.error("Has d'iniciar sessió"); return; }
    if (!content.trim()) { toast.error("Escriu un missatge"); return; }
    setSending(true);
    try {
      if (asBroadcast && isAdmin) {
        const { error } = await db.from("admin_broadcasts").insert({
          subject: subject.trim() || null,
          content: content.trim(),
          sender_id: user.id,
        });
        if (error) throw error;
        toast.success("Comunicat enviat");
      } else {
        const receiverId = await resolveReceiver(to);
        if (!receiverId) { toast.error("Destinatari no trobat"); setSending(false); return; }
        const { error } = await db.from("user_messages").insert({
          sender_id: user.id,
          receiver_id: receiverId,
          subject: subject.trim() || null,
          content: content.trim(),
        });
        if (error) throw error;
        toast.success("Missatge enviat");
      }
      setTo(""); setSubject(""); setContent(""); setAsBroadcast(false);
      void load();
    } catch (e: any) {
      toast.error(e?.message ?? "Error en enviar");
    } finally {
      setSending(false);
    }
  };

  const unread = messages.filter(m => !m.read_at).length;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <button
          type="button"
          aria-label="Missatges"
          className="relative inline-flex items-center justify-center w-9 h-9 rounded-md text-muted-foreground hover:text-primary hover:bg-primary/10 transition-colors"
        >
          <Mail className="w-5 h-5" />
          {unread > 0 && (
            <span className="absolute -top-1 -right-1 min-w-[16px] h-4 px-1 rounded-full bg-destructive text-[10px] font-bold text-destructive-foreground flex items-center justify-center">
              {unread}
            </span>
          )}
        </button>
      </DialogTrigger>
      <DialogContent className="max-w-md max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Missatgeria</DialogTitle>
        </DialogHeader>

        <Tabs defaultValue="messages">
          <TabsList className="grid grid-cols-3 w-full">
            <TabsTrigger value="messages">Missatges</TabsTrigger>
            <TabsTrigger value="broadcasts">Avisos Admin</TabsTrigger>
            <TabsTrigger value="send">Enviar</TabsTrigger>
          </TabsList>

          <TabsContent value="messages" className="space-y-2 mt-3">
            {loading && <p className="text-xs text-muted-foreground">Carregant…</p>}
            {!loading && messages.length === 0 && <p className="text-xs text-muted-foreground">Cap missatge.</p>}
            {messages.map(m => (
              <div key={m.id} className="border border-border rounded-md p-2 text-sm">
                {m.subject && <div className="font-semibold text-gold">{m.subject}</div>}
                <div className="whitespace-pre-wrap">{m.content}</div>
                <div className="text-[10px] text-muted-foreground mt-1">{new Date(m.created_at).toLocaleString()}</div>
              </div>
            ))}
          </TabsContent>

          <TabsContent value="broadcasts" className="space-y-2 mt-3">
            {loading && <p className="text-xs text-muted-foreground">Carregant…</p>}
            {!loading && broadcasts.length === 0 && <p className="text-xs text-muted-foreground">Cap avís.</p>}
            {broadcasts.map(b => (
              <div key={b.id} className="border border-primary/40 rounded-md p-2 text-sm bg-primary/5">
                {b.subject && <div className="font-semibold text-gold">{b.subject}</div>}
                <div className="whitespace-pre-wrap">{b.content}</div>
                <div className="text-[10px] text-muted-foreground mt-1">{new Date(b.created_at).toLocaleString()}</div>
              </div>
            ))}
          </TabsContent>

          <TabsContent value="send" className="space-y-3 mt-3">
            {!asBroadcast && (
              <div className="space-y-1">
                <Label htmlFor="msg-to">Destinatari (ID o username)</Label>
                <Input id="msg-to" value={to} onChange={e => setTo(e.target.value)} placeholder="UUID o username" />
              </div>
            )}
            <div className="space-y-1">
              <Label htmlFor="msg-subj">Assumpte</Label>
              <Input id="msg-subj" value={subject} onChange={e => setSubject(e.target.value)} maxLength={120} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="msg-body">Missatge</Label>
              <Textarea id="msg-body" value={content} onChange={e => setContent(e.target.value)} rows={4} maxLength={2000} />
            </div>
            {isAdmin && (
              <label className="flex items-center gap-2 text-sm">
                <Checkbox checked={asBroadcast} onCheckedChange={v => setAsBroadcast(!!v)} />
                <span>Enviar com a comunicat global (admin)</span>
              </label>
            )}
            <Button onClick={onSend} disabled={sending || !user} className="w-full">
              {sending ? "Enviant…" : asBroadcast ? "Publicar comunicat" : "Enviar missatge"}
            </Button>
            {!user && <p className="text-xs text-muted-foreground">Cal iniciar sessió per a enviar.</p>}
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}