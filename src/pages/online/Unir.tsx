import { useNavigate } from "@/lib/router-shim";
import { useState } from "react";
import { ClientOnly } from "@/components/ClientOnly";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { usePlayerIdentity } from "@/hooks/usePlayerIdentity";
import { useAuth } from "@/hooks/useAuth";
import { joinRoom } from "@/online/rooms.functions";
import { clearOtherPendingMatches } from "@/lib/pendingMatches";
import { isRoomPrivate, verifyRoomPassword } from "@/online/roomPassword";
import { RoomPasswordDialog } from "@/components/RoomPasswordDialog";
import { Loader2, LogIn, LogOut, Settings } from "lucide-react";
import { useT } from "@/i18n/useT";
import { ShareAppButton } from "@/components/ShareAppButton";

function Loading() {
  return (
    <main className="min-h-screen flex items-center justify-center">
      <Loader2 className="w-6 h-6 animate-spin text-primary" />
    </main>
  );
}

function OnlineUnirPage() {
  return (
    <ClientOnly fallback={<Loading />}><UnirSala /></ClientOnly>
  );
}

function UnirSala() {
  const navigate = useNavigate();
  const t = useT();
  const { deviceId, name, hasName, ready } = usePlayerIdentity();
  const { user } = useAuth();
  const [code, setCode] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pwdPrompt, setPwdPrompt] = useState<boolean>(false);

  if (!ready) return <Loading />;

  const cleanCode = code.toUpperCase().replace(/[^A-Z2-9]/g, "").slice(0, 6);

  const mapJoinError = (raw: string): string => {
    const m = raw.toLowerCase();
    if (/(not.?found|no.?existe|no existeix|inexist|invalid.?code|codi.*incorrecte|c[oó]digo.*incorrecto)/.test(m)) return t("unir.error.not_found");
    if (/(full|llena|plena|completa)/.test(m)) return t("unir.error.full");
    if (/(closed|cerrada|tancada|tancad)/.test(m)) return t("unir.error.closed");
    if (/(in.?progress|started|en curs|comenzad|començad|en marcha)/.test(m)) return t("unir.error.in_progress");
    return t("unir.error.generic", { msg: raw });
  };

  const performJoin = async () => {
    try {
      await clearOtherPendingMatches({ kind: "online", deviceId, keepRoomCode: cleanCode });
      const result = await joinRoom({ data: { code: cleanCode, deviceId, name, profileUserId: user?.id ?? null } });
      if (result.seat == null && result.isSpectator) {
        navigate(`/online/partida/${cleanCode}?spectator=1`);
        return;
      }
      navigate(`/online/sala/${cleanCode}?from=unir`);
    } catch (e) {
      const raw = e instanceof Error ? e.message : t("nou.unexpected_error");
      setError(mapJoinError(raw));
      setSubmitting(false);
    }
  };

  const handleJoin = async () => {
    if (!hasName) { setError(t("unir.need_name")); return; }
    if (cleanCode.length !== 6) { setError(t("unir.code_six_chars")); return; }
    setSubmitting(true);
    setError(null);
    try {
      const priv = await isRoomPrivate(cleanCode);
      if (priv) { setPwdPrompt(true); setSubmitting(false); return; }
      await performJoin();
    } catch {
      await performJoin();
    }
  };

  return (
    <main className="menu-screen min-h-screen flex flex-col items-center px-5 py-4">
      <div className="w-full max-w-md flex items-center justify-between">
        <ShareAppButton />
        <Button
          onClick={() => navigate("/")}
          size="sm"
          variant="outline"
          className="h-8 w-8 p-0 border-foreground/80 text-foreground hover:bg-foreground/10"
          aria-label={t("common.back_home")}
          title={t("common.back_home")}
        >
          <LogOut className="w-4 h-4" />
        </Button>
      </div>
      <div className="w-full max-w-md flex-1 flex flex-col justify-center gap-5 py-4">
        <header className="text-center">
          <h1 className="font-title font-black italic text-gold text-3xl pr-2 text-center">{t("unir.join_table")}</h1>
        </header>

        {!hasName && (
          <section className="px-1 py-2 flex items-center justify-between gap-3">
            <p className="text-xs text-[#c2b9a3]">{t("unir.need_name")}</p>
            <Button size="sm" variant="outline" onClick={() => navigate("/ajustes")} className="border-primary/40">
              <Settings className="w-3 h-3 mr-1" /> {t("home.settings")}
            </Button>
          </section>
        )}

        <section className="flex flex-col gap-1.5">
          <div className="font-display font-bold text-base text-white">
            {t("unir.code_label")}
          </div>
          <Input
            value={cleanCode}
            onChange={(e) => setCode(e.target.value)}
            placeholder="ABCD23"
            maxLength={6}
            className="text-center font-title font-bold italic text-3xl tracking-[0.3em] uppercase h-14"
            autoCapitalize="characters"
            autoComplete="off"
          />
        </section>

        {error && <p className="text-xs text-destructive text-center">{error}</p>}

        <Button
          size="lg"
          className="home-cta-btn w-full min-h-14 h-auto py-2 bg-accent text-accent-foreground hover:bg-accent/90 font-display font-bold text-lg whitespace-normal"
          onClick={handleJoin}
          disabled={submitting || !hasName}
        >
          {submitting ? <Loader2 className="w-5 h-5 mr-2 animate-spin" /> : <LogIn className="w-5 h-5 mr-2" />}
          <span className="line-clamp-2 text-center leading-tight">{t("unir.enter_table")}</span>
        </Button>
      </div>
      <RoomPasswordDialog
        open={pwdPrompt}
        onVerify={(pwd) => verifyRoomPassword(cleanCode, pwd)}
        onSuccess={() => { setPwdPrompt(false); setSubmitting(true); void performJoin(); }}
        onCancel={() => { setPwdPrompt(false); setSubmitting(false); }}
      />
    </main>
  );
}
export default OnlineUnirPage;