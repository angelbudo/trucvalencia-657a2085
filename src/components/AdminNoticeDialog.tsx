import { useEffect, useState } from "react";
import { ShieldAlert } from "lucide-react";
import { usePlayerIdentity } from "@/hooks/usePlayerIdentity";
import { useAuthUserId } from "@/hooks/useAuthUserId";
import { useDeviceModeration } from "@/online/useDeviceModeration";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

const STORAGE_KEY = "truc:adminNoticeAck:v1";

function readAck(deviceId: string): number {
  if (typeof window === "undefined") return 0;
  try {
    const raw = window.localStorage.getItem(`${STORAGE_KEY}:${deviceId}`);
    return raw ? Number(raw) || 0 : 0;
  } catch {
    return 0;
  }
}
function writeAck(deviceId: string, ts: number) {
  if (typeof window === "undefined") return;
  try { window.localStorage.setItem(`${STORAGE_KEY}:${deviceId}`, String(ts)); } catch { /* noop */ }
}

/**
 * Diàleg modal "Aviso del Administrador". S'obre automàticament quan arriba
 * un `last_notice` nou per al dispositiu actual. L'usuari ha de confirmar
 * per tancar-lo i el seu timestamp queda registrat a `localStorage` per no
 * reaparèixer.
 */
export function AdminNoticeDialog() {
  const { deviceId } = usePlayerIdentity();
  const userId = useAuthUserId();
  const mod = useDeviceModeration(deviceId || null, userId);
  const [open, setOpen] = useState(false);
  const [shownNotice, setShownNotice] = useState<string>("");

  useEffect(() => {
    if (!deviceId || !mod.loaded || !mod.lastNotice || !mod.lastNoticeAt) return;
    const ack = readAck(deviceId);
    if (mod.lastNoticeAt > ack) {
      setShownNotice(mod.lastNotice);
      setOpen(true);
    }
  }, [deviceId, mod.loaded, mod.lastNotice, mod.lastNoticeAt]);

  const handleClose = () => {
    if (deviceId && mod.lastNoticeAt) writeAck(deviceId, mod.lastNoticeAt);
    setOpen(false);
  };

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) handleClose(); }}>
      <DialogContent className="border-2 border-red-600 bg-zinc-950 text-white shadow-[0_0_40px_-5px_rgba(239,68,68,0.6)]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-red-400">
            <ShieldAlert className="w-6 h-6" aria-hidden="true" />
            Aviso del Administrador
          </DialogTitle>
          <DialogDescription className="text-zinc-200 text-base pt-2 whitespace-pre-line">
            {shownNotice}
          </DialogDescription>
        </DialogHeader>
        <div className="text-xs text-zinc-400 border-t border-zinc-800 pt-3">
          Reportes en este ciclo: <strong>{mod.reportCount}/3</strong>
          {" · "}Baneos consumidos: <strong>{mod.banCount}/3</strong>
          {mod.bannedUntil && !mod.permanentBan && (
            <> {" · "}Suspendido hasta: <strong>{new Date(mod.bannedUntil).toLocaleString()}</strong></>
          )}
        </div>
        <DialogFooter>
          <Button onClick={handleClose} variant="destructive" className="w-full sm:w-auto">
            He entendido
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default AdminNoticeDialog;