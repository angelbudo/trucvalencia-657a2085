import { useEffect, useRef, useState } from "react";
import { Camera, Image as ImageIcon, Loader2, Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";

// 210 avatars predefinits al bucket públic "default-avatars".
// Els fitxers s'anomenen "{n}.jpg" o "{n}.png" (extensió mixta).
const SUPABASE_PUBLIC_URL =
  (import.meta.env.VITE_SUPABASE_URL as string | undefined) ??
  "https://sgonrrtqdcwyajsmufhs.supabase.co";
const AVATAR_BASE = `${SUPABASE_PUBLIC_URL}/storage/v1/object/public/default-avatars`;
const AVATAR_COUNT = 210;

let cachedPresets: string[] | null = null;
async function loadPresetAvatars(): Promise<string[]> {
  if (cachedPresets) return cachedPresets;
  const { data, error } = await supabase.storage.from("default-avatars").list("", {
    limit: 1000,
    sortBy: { column: "name", order: "asc" },
  });
  if (error || !data) {
    // Fallback: assume .jpg
    cachedPresets = Array.from({ length: AVATAR_COUNT }, (_, i) => `${AVATAR_BASE}/${i + 1}.jpg`);
    return cachedPresets;
  }
  const byNumber = new Map<number, string>();
  for (const f of data) {
    const m = f.name.match(/^(\d+)\.(jpg|jpeg|png|webp)$/i);
    if (m) byNumber.set(parseInt(m[1], 10), f.name);
  }
  const list: string[] = [];
  for (let i = 1; i <= AVATAR_COUNT; i++) {
    const name = byNumber.get(i) ?? `${i}.jpg`;
    list.push(`${AVATAR_BASE}/${name}`);
  }
  cachedPresets = list;
  return list;
}

export const PRESET_AVATARS: string[] = Array.from(
  { length: AVATAR_COUNT },
  (_, i) => `${AVATAR_BASE}/${i + 1}.jpg`,
);
void loadPresetAvatars();

interface Props {
  userId: string;
  currentUrl: string | null;
  displayName: string;
  onChanged: (url: string) => void;
}

export function AvatarPicker({ userId, currentUrl, displayName, onChanged }: Props) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [presets, setPresets] = useState<string[]>(PRESET_AVATARS);
  useEffect(() => { void loadPresetAvatars().then(setPresets); }, []);
  const cameraRef = useRef<HTMLInputElement>(null);
  const galleryRef = useRef<HTMLInputElement>(null);

  const initial = (displayName || "?").trim().charAt(0).toUpperCase();

  async function persist(url: string) {
    const { error } = await supabase
      .from("profiles")
      .update({ avatar_url: url })
      .eq("user_id", userId);
    if (error) throw error;
    onChanged(url);
  }

  async function compressImage(file: File, maxSize = 60, quality = 0.8): Promise<Blob> {
    const dataUrl: string = await new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result as string);
      r.onerror = () => reject(r.error);
      r.readAsDataURL(file);
    });
    const img: HTMLImageElement = await new Promise((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = () => reject(new Error("No s'ha pogut carregar la imatge"));
      i.src = dataUrl;
    });
    const ratio = Math.min(1, maxSize / Math.max(img.width, img.height));
    const w = Math.max(1, Math.round(img.width * ratio));
    const h = Math.max(1, Math.round(img.height * ratio));
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Canvas no disponible");
    ctx.drawImage(img, 0, 0, w, h);
    const blob: Blob = await new Promise((resolve, reject) => {
      canvas.toBlob(
        (b) => (b ? resolve(b) : reject(new Error("No s'ha pogut comprimir"))),
        "image/jpeg",
        quality,
      );
    });
    return blob;
  }

  async function handleFile(file: File) {
    if (!file) return;
    if (file.size > 20 * 1024 * 1024) {
      toast.error("La imatge ha de pesar menys de 20 MB");
      return;
    }
    setBusy(true);
    try {
      const blob = await compressImage(file, 60, 0.8);
      // Nom de fitxer estable per usuari: sobreescriu sempre l'anterior
      // i evita acumular historial al bucket.
      const path = `${userId}/avatar.jpg`;
      // Neteja preventiva de qualsevol fitxer antic d'aquest usuari
      // (versions anteriors guardaven `avatar-<timestamp>.jpg`).
      try {
        const { data: existing } = await supabase.storage.from("avatars").list(userId, { limit: 100 });
        const toRemove = (existing ?? [])
          .map((f) => `${userId}/${f.name}`)
          .filter((p) => p !== path);
        if (toRemove.length) await supabase.storage.from("avatars").remove(toRemove);
      } catch { /* noop */ }
      const { error: upErr } = await supabase.storage
        .from("avatars")
        .upload(path, blob, { upsert: true, contentType: "image/jpeg", cacheControl: "0" });
      if (upErr) throw upErr;
      const { data } = supabase.storage.from("avatars").getPublicUrl(path);
      // Trenca la caché del navegador en pujades successives.
      const url = `${data.publicUrl}?v=${Date.now()}`;
      await persist(url);
      toast.success("Avatar actualitzat");
      setOpen(false);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function pickPreset(url: string) {
    setBusy(true);
    try {
      await persist(url);
      toast.success("Avatar actualitzat");
      setOpen(false);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <button
          type="button"
          className="relative shrink-0 w-16 h-16 rounded-full border-2 border-primary/40 overflow-hidden bg-background/40 flex items-center justify-center hover:border-primary transition"
          aria-label="Canviar avatar"
        >
          {currentUrl ? (
            <img src={currentUrl} alt="Avatar" className="w-full h-full object-cover" />
          ) : (
            <span className="text-xl font-bold text-gold">{initial}</span>
          )}
          <span className="absolute bottom-0 inset-x-0 bg-black/60 text-[9px] text-white py-0.5 text-center uppercase tracking-wider">
            Editar
          </span>
        </button>
      </DialogTrigger>
      <DialogContent className="w-[90vw] sm:max-w-md max-h-[85vh] overflow-y-auto rounded-2xl border-primary/30">
        <DialogHeader>
          <DialogTitle className="text-gold font-title font-black italic text-2xl text-center">Foto de perfil</DialogTitle>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          <div className="grid grid-cols-2 gap-2">
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={() => cameraRef.current?.click()}
              className="bg-team-nos text-background hover:bg-team-nos/90 border-transparent"
            >
              <Camera className="w-4 h-4 mr-2" /> Càmera
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={() => galleryRef.current?.click()}
              className="bg-accent text-accent-foreground hover:bg-accent/90 border-transparent"
            >
              <ImageIcon className="w-4 h-4 mr-2" /> Galeria
            </Button>
            <input
              ref={cameraRef}
              type="file"
              accept="image/*"
              capture="user"
              hidden
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void handleFile(f);
                e.target.value = "";
              }}
            />
            <input
              ref={galleryRef}
              type="file"
              accept="image/*"
              hidden
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void handleFile(f);
                e.target.value = "";
              }}
            />
          </div>

          <div>
            <div className="font-title font-bold text-base text-white mb-2 [&]:!font-[Cinzel,serif]">
              O tria un avatar
            </div>
            <div className="avatar-scroll max-h-[50vh] overflow-y-auto pr-2">
              <div className="grid grid-cols-5 gap-2">
                {presets.map((url) => {
                  const selected = currentUrl === url;
                  return (
                    <button
                      key={url}
                      type="button"
                      disabled={busy}
                      onClick={() => pickPreset(url)}
                      className={`relative aspect-square rounded-full overflow-hidden border-2 transition ${
                        selected ? "border-gold" : "border-primary/30 hover:border-primary"
                      } bg-background/40`}
                    >
                      <img src={url} alt="" className="w-full h-full object-cover" loading="lazy" />
                      {selected && (
                        <span className="absolute inset-0 bg-black/40 flex items-center justify-center">
                          <Check className="w-5 h-5 text-gold" />
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            </div>
          </div>

          {busy && (
            <div className="flex items-center justify-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="w-4 h-4 animate-spin" /> Guardant…
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}