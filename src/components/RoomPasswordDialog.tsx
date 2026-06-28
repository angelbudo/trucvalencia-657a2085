import { useEffect, useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { KeyRound, Loader2, RotateCcw } from "lucide-react";

interface Props {
  open: boolean;
  /** Validador asíncron contra la base de dades (Edge Function). */
  onVerify: (password: string) => Promise<boolean>;
  onSuccess: () => void;
  onCancel: () => void;
}

export function RoomPasswordDialog({ open, onVerify, onSuccess, onCancel }: Props) {
  const [value, setValue] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);

  useEffect(() => {
    if (open) { setValue(""); setErr(null); setChecking(false); }
  }, [open]);

  const submit = async () => {
    if (checking) return;
    setChecking(true);
    setErr(null);
    try {
      const ok = await onVerify(value);
      if (ok) {
        setValue("");
        onSuccess();
      } else {
        setErr("Contrasenya incorrecta");
      }
    } catch {
      setErr("No s'ha pogut validar. Torna-ho a provar.");
    } finally {
      setChecking(false);
    }
  };

  const retry = () => {
    setValue("");
    setErr(null);
  };

  const close = () => {
    setValue("");
    setErr(null);
    onCancel();
  };

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) close(); }}>
      <DialogContent className="w-[92vw] sm:max-w-md max-h-[85vh] overflow-y-auto overflow-x-hidden rounded-2xl border-primary/30 py-3 sm:py-4 px-[10px]">
        <DialogHeader className="px-0 mt-[10px]">
          <DialogTitle className="font-title font-black italic text-gold text-2xl text-center inline-flex items-center justify-center gap-2">
            <KeyRound className="w-5 h-5 text-gold" />
            Taula protegida
          </DialogTitle>
          <DialogDescription className="text-center text-sm text-muted-foreground">
            Aquesta taula té contrasenya. Introdueix-la per entrar.
          </DialogDescription>
        </DialogHeader>

        <div className="px-2 pb-2 flex flex-col gap-3">
          <Input
            type="password"
            autoFocus
            value={value}
            onChange={(e) => { setValue(e.target.value); setErr(null); }}
            onKeyDown={(e) => { if (e.key === "Enter") void submit(); }}
            placeholder="Contrasenya"
            className="text-center"
            disabled={checking}
            autoComplete="off"
          />
          {err && (
            <p className="text-xs text-destructive text-center font-semibold">{err}</p>
          )}

          {err ? (
            <div className="flex">
              <Button
                variant="outline"
                onClick={retry}
                className="flex-1 border-primary/40 text-primary hover:bg-primary/10"
              >
                <RotateCcw className="w-4 h-4 mr-1" /> Tornar a intentar
              </Button>
            </div>
          ) : (
            <div className="flex">
              <Button onClick={() => void submit()} disabled={checking || !value} className="flex-1">
                {checking ? <Loader2 className="w-4 h-4 mr-1 animate-spin" /> : <KeyRound className="w-4 h-4 mr-1" />}
                {checking ? "Validant…" : "Entrar"}
              </Button>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}