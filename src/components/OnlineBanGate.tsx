import { useEffect, useState, type ReactNode } from "react";
import { ShieldAlert, Clock, Megaphone } from "lucide-react";
import { usePlayerIdentity } from "@/hooks/usePlayerIdentity";
import { useAuthUserId } from "@/hooks/useAuthUserId";
import { useDeviceModeration } from "@/online/useDeviceModeration";
import { useLeaverPenalty } from "@/online/useLeaverPenalty";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { useT } from "@/i18n/useT";

function formatRemaining(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function closeApp() {
  try {
    window.close();
  } catch {
    /* ignore */
  }
  setTimeout(() => {
    try {
      window.location.replace("about:blank");
    } catch {
      /* ignore */
    }
  }, 100);
}

/** Diàleg d'apel·lació DSA: l'usuari escriu un missatge que arriba a
 *  la bandeja del super-admin (taula `admin_alerts`, kind='appeal'). */
function AppealDialog({
  open,
  onOpenChange,
  deviceId,
  userId,
  reason,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  deviceId: string | null;
  userId: string | null;
  reason: string;
}) {
  const t = useT();
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);

  const onSubmit = async () => {
    const msg = text.trim();
    if (msg.length < 5) {
      toast.error(t("appeal.too_short"));
      return;
    }
    setSending(true);
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { error } = await (supabase as any).rpc("submit_moderation_appeal", {
        p_device_id: deviceId,
        p_user_id: userId,
        p_reason: reason,
        p_message: msg,
      });
      if (error) throw error;
      toast.success(t("appeal.sent_ok"));
      setText("");
      onOpenChange(false);
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e);
      toast.error(m || t("appeal.sent_err"));
    } finally {
      setSending(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="bg-zinc-900 text-zinc-100 border-zinc-700">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Megaphone className="w-5 h-5 text-amber-400" />
            {t("appeal.title")}
          </DialogTitle>
          <DialogDescription className="text-zinc-400">
            {t("appeal.description")}
          </DialogDescription>
        </DialogHeader>
        <Textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          maxLength={2000}
          rows={6}
          placeholder={t("appeal.placeholder")}
          className="bg-zinc-950 border-zinc-700 text-zinc-100"
        />
        <div className="text-xs text-zinc-500 text-right">{text.length}/2000</div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={sending}>
            {t("common.cancel")}
          </Button>
          <Button onClick={onSubmit} disabled={sending || text.trim().length < 5}>
            {sending ? t("appeal.sending") : t("appeal.send")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Bloqueja l'accés online si el dispositiu o la cuenta tenen un baneig
 *  (moderació per comportament) o una suspensió per abandonament reiterat
 *  de partides. Els dos sistemes són independents: el leaver penalty mai
 *  acumula cap al baneig permanent. */
export function OnlineBanGate({ children }: { children: ReactNode }) {
  const { deviceId } = usePlayerIdentity();
  const userId = useAuthUserId();
  const mod = useDeviceModeration(deviceId || null, userId);
  const leaver = useLeaverPenalty(deviceId || null, userId);
  const [now, setNow] = useState<number>(() => Date.now());
  const [appealOpen, setAppealOpen] = useState(false);
  const t = useT();

  const anyTemporary =
    (mod.isBanned && !mod.permanentBan) || leaver.isBanned;

  useEffect(() => {
    if (!anyTemporary) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [anyTemporary]);

  if (!mod.isBanned && !leaver.isBanned) return <>{children}</>;

  const appealReason = mod.permanentBan
    ? "ban_permanent"
    : mod.isBanned
      ? "ban_temporary"
      : "leaver_penalty";

  const AppealButton = (
    <Button
      variant="outline"
      className="w-full mb-2 border-amber-500 text-amber-300 hover:bg-amber-500/10 hover:text-amber-200"
      onClick={() => setAppealOpen(true)}
    >
      <Megaphone className="w-4 h-4 mr-2" />
      {t("appeal.button")}
    </Button>
  );

  const dialog = (
    <AppealDialog
      open={appealOpen}
      onOpenChange={setAppealOpen}
      deviceId={deviceId || null}
      userId={userId}
      reason={appealReason}
    />
  );

  // Prioritat: baneig permanent > baneig de moderació > suspensió per abandonament.
  if (mod.permanentBan) {
    return (
      <main className="min-h-screen flex items-center justify-center p-6 bg-zinc-950 text-white">
        <div className="max-w-md w-full border-2 border-red-600 rounded-xl p-6 bg-zinc-900 shadow-[0_0_40px_-5px_rgba(239,68,68,0.6)]">
          <div className="flex items-center gap-2 text-red-400 mb-3">
            <ShieldAlert className="w-7 h-7" aria-hidden="true" />
            <h1 className="text-xl font-bold">{t("ban.title")}</h1>
          </div>
          <p className="text-zinc-100 mb-4">{t("ban.permanent")}</p>
          <div className="text-xs text-zinc-400 border-t border-zinc-800 pt-3 mb-4">
            {t("ban.cycle", { r: mod.reportCount, b: mod.banCount })}
          </div>
          {AppealButton}
          <Button variant="secondary" className="w-full" onClick={closeApp}>
            {t("ban.close_app")}
          </Button>
        </div>
        {dialog}
      </main>
    );
  }

  if (mod.isBanned) {
    const remaining = mod.bannedUntil ? Math.max(0, mod.bannedUntil - now) : 0;
    return (
      <main className="min-h-screen flex items-center justify-center p-6 bg-zinc-950 text-white">
        <div className="max-w-md w-full border-2 border-red-600 rounded-xl p-6 bg-zinc-900 shadow-[0_0_40px_-5px_rgba(239,68,68,0.6)]">
          <div className="flex items-center gap-2 text-red-400 mb-3">
            <ShieldAlert className="w-7 h-7" aria-hidden="true" />
            <h1 className="text-xl font-bold">{t("ban.title")}</h1>
          </div>
          <p className="text-zinc-100 mb-4">
            {t("ban.temporary", { n: Math.max(0, 3 - mod.banCount) })}
          </p>
          <div className="text-center text-3xl font-mono tracking-wider text-red-300 mb-4">
            {formatRemaining(remaining)}
          </div>
          <div className="text-xs text-zinc-400 border-t border-zinc-800 pt-3 mb-4">
            {t("ban.cycle", { r: mod.reportCount, b: mod.banCount })}
          </div>
          {AppealButton}
          <Button variant="secondary" className="w-full" onClick={closeApp}>
            {t("ban.close_app")}
          </Button>
        </div>
        {dialog}
      </main>
    );
  }

  // Leaver penalty (suspensió 24h de l'online, independent)
  const remainingLeaver = leaver.bannedUntil
    ? Math.max(0, leaver.bannedUntil - now)
    : 0;
  return (
    <main className="min-h-screen flex items-center justify-center p-6 bg-zinc-950 text-white">
      <div className="max-w-md w-full border-2 border-amber-500 rounded-xl p-6 bg-zinc-900 shadow-[0_0_40px_-5px_rgba(245,158,11,0.5)]">
        <div className="flex items-center gap-2 text-amber-400 mb-3">
          <Clock className="w-7 h-7" aria-hidden="true" />
          <h1 className="text-xl font-bold">{t("leaver.title")}</h1>
        </div>
        <p className="text-amber-300 font-semibold mb-2">{t("leaver.reason")}</p>
        <p className="text-zinc-100 mb-4">{t("leaver.body")}</p>
        <div className="text-center text-3xl font-mono tracking-wider text-amber-300 mb-4">
          {formatRemaining(remainingLeaver)}
        </div>
        {AppealButton}
        <Button variant="secondary" className="w-full" onClick={closeApp}>
          {t("ban.close_app")}
        </Button>
      </div>
      {dialog}
    </main>
  );
}

export default OnlineBanGate;