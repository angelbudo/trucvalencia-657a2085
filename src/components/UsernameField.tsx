import { useEffect, useRef, useState } from "react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Check, Loader2, AtSign, X } from "lucide-react";
import { toast } from "sonner";
import {
  isUsernameAvailable,
  normalizeUsername,
  setUsername,
  validateUsernameFormat,
} from "@/lib/username";

export function UsernameField({
  current,
  onSaved,
}: {
  current: string | null;
  onSaved: () => void;
}) {
  const [editing, setEditing] = useState(!current);
  const [draft, setDraft] = useState(current ?? "");
  const [checking, setChecking] = useState(false);
  const [available, setAvailable] = useState<boolean | null>(null);
  const [formatErr, setFormatErr] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const debounceRef = useRef<number | null>(null);
  const syncedRef = useRef(false);

  // Quan el perfil acaba de carregar-se (current passa de null a un valor),
  // sincronitzem el draft i sortim del mode edició perquè es vegi el nom
  // d'usuari guardat sense que l'usuari l'hagi de tornar a escriure.
  useEffect(() => {
    if (syncedRef.current) return;
    if (current) {
      setDraft(current);
      setEditing(false);
      syncedRef.current = true;
    }
  }, [current]);

  useEffect(() => {
    if (!editing) return;
    const u = normalizeUsername(draft);
    if (u === (current ?? "")) {
      setAvailable(null);
      setFormatErr(null);
      setChecking(false);
      return;
    }
    const err = validateUsernameFormat(u);
    setFormatErr(err);
    if (err) {
      setAvailable(null);
      setChecking(false);
      return;
    }
    if (debounceRef.current) window.clearTimeout(debounceRef.current);
    setChecking(true);
    let cancelled = false;
    debounceRef.current = window.setTimeout(() => {
      // Hard safety timeout: si la consulta no respon en 4s, deixem
      // que l'usuari pugui desar igualment (el servidor validarà).
      const safety = window.setTimeout(() => {
        if (cancelled) return;
        setAvailable(null);
        setChecking(false);
      }, 4000);
      isUsernameAvailable(u)
        .then((ok) => {
          if (cancelled) return;
          setAvailable(ok);
        })
        .catch(() => {
          if (cancelled) return;
          setAvailable(null);
        })
        .finally(() => {
          window.clearTimeout(safety);
          if (cancelled) return;
          setChecking(false);
        });
    }, 400);
    return () => {
      cancelled = true;
      if (debounceRef.current) window.clearTimeout(debounceRef.current);
    };
  }, [draft, editing, current]);

  async function save() {
    setSaving(true);
    try {
      await setUsername(draft);
      toast.success("Nom d'usuari guardat");
      setEditing(false);
      onSaved();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  if (!editing && current) {
    return (
      <div className="rounded-md border border-primary/25 bg-background/40 p-3 flex items-center justify-between gap-2">
        <div className="min-w-0">
          <div className="font-display font-bold text-sm text-foreground flex items-center gap-1">
            <AtSign className="w-4 h-4" /> Nom d'usuari (públic)
          </div>
          <div className="font-mono text-base text-gold truncate">{current}</div>
        </div>
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            setDraft(current);
            setEditing(true);
          }}
        >
          Canviar
        </Button>
      </div>
    );
  }

  const canSave =
    !saving &&
    !checking &&
    !formatErr &&
    available !== false &&
    normalizeUsername(draft) !== (current ?? "");

  return (
    <div className="rounded-md border border-primary/25 bg-background/40 p-3 space-y-2">
      <div className="font-display font-bold text-sm text-foreground flex items-center gap-1">
        <AtSign className="w-4 h-4" /> Nom d'usuari únic
      </div>
      <div className="flex items-center gap-2">
        <Input
          value={draft}
          onChange={(e) => setDraft(e.target.value.toLowerCase())}
          maxLength={20}
          placeholder="elteunom"
          autoFocus
          className="font-mono flex-1"
          onKeyDown={(e) => {
            if (e.key === "Enter" && canSave) void save();
          }}
        />
        <Button size="icon" onClick={save} disabled={!canSave} aria-label="Desar">
          {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
        </Button>
        {current && (
          <Button
            size="icon"
            variant="ghost"
            onClick={() => {
              setDraft(current);
              setEditing(false);
            }}
            aria-label="Cancel·lar"
          >
            <X className="w-4 h-4" />
          </Button>
        )}
      </div>
      <div className="text-[11px] min-h-[16px]">
        {formatErr && <span className="text-destructive">{formatErr}</span>}
        {!formatErr && checking && (
          <span className="text-muted-foreground">Comprovant disponibilitat…</span>
        )}
        {!formatErr && !checking && available === true && (
          <span className="text-emerald-500">Disponible ✓</span>
        )}
        {!formatErr && !checking && available === false && (
          <span className="text-destructive">Ja agafat</span>
        )}
        {!formatErr &&
          !checking &&
          available === null &&
          normalizeUsername(draft) !== (current ?? "") && (
            <span className="text-muted-foreground">
              No s'ha pogut comprovar; pots provar de desar-lo.
            </span>
          )}
        {!formatErr &&
          !checking &&
          available === null &&
          normalizeUsername(draft) === (current ?? "") && (
            <span className="text-muted-foreground">
              3-20 caràcters: lletres minúscules, xifres i _
            </span>
          )}
      </div>
      <p className="text-[10px] text-muted-foreground">
        Aquest és el nom que es veurà a les classificacions i en partides públiques. El teu nom real
        es queda privat.
      </p>
    </div>
  );
}