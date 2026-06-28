import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "@/lib/router-shim";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  ArrowLeft,
  LogOut,
  Loader2,
  Trash2,
  ShieldAlert,
  CheckCircle2,
  Eye,
} from "lucide-react";
import { requestAccountDeletion, type DeleteAccountResult } from "@/lib/deleteAccount";
import { getLanguage } from "@/i18n/useT";
import { ShareAppButton } from "@/components/ShareAppButton";

const DEVICE_KEY = "truc:device-id";

type Step = "input" | "preview" | "done";

function labelForTable(table: string, isEs: boolean): string {
  switch (table) {
    case "player_profiles":
      return isEs ? "perfiles y estadísticas de juego" : "perfils i estadístiques de joc";
    case "room_players":
      return isEs ? "ocupaciones de asiento en salas" : "ocupacions de seient en sales";
    case "sala_chat":
      return isEs ? "mensajes del chat de sala" : "missatges del xat de sala";
    case "room_text_chat":
      return isEs ? "mensajes del chat de partida" : "missatges del xat de partida";
    default:
      return table;
  }
}

const EsborrarDades = () => {
  const navigate = useNavigate();
  const isEs = getLanguage() === "es";
  const [deviceId, setDeviceId] = useState("");
  const [loading, setLoading] = useState(false);
  const [preview, setPreview] = useState<DeleteAccountResult | null>(null);
  const [result, setResult] = useState<DeleteAccountResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [step, setStep] = useState<Step>("input");

  useEffect(() => {
    document.title = isEs
      ? "Borrar mis datos · Truc Valencià"
      : "Esborrar les meues dades · Truc Valencià";
    const desc = isEs
      ? "Solicita el borrado de tus datos de Truc Valencià indicando el identificador anónimo de tu dispositivo."
      : "Sol·licita l'esborrat de les teues dades de Truc Valencià indicant l'identificador anònim del teu dispositiu.";
    let meta = document.querySelector('meta[name="description"]');
    if (!meta) {
      meta = document.createElement("meta");
      meta.setAttribute("name", "description");
      document.head.appendChild(meta);
    }
    meta.setAttribute("content", desc);
    try {
      const stored = window.localStorage.getItem(DEVICE_KEY);
      if (stored) setDeviceId(stored);
    } catch { /* */ }
  }, [isEs]);

  const trimmed = deviceId.trim();
  const looksValid = /^[a-zA-Z0-9_-]{4,80}$/.test(trimmed);
  const totalToDelete = useMemo(() => {
    if (!preview) return 0;
    return Object.values(preview.deleted).reduce((a, b) => a + b, 0);
  }, [preview]);
  const totalToAnonymize = useMemo(() => {
    if (!preview) return 0;
    return Object.values(preview.anonymized).reduce((a, b) => a + b, 0);
  }, [preview]);
  const hasAnyData = totalToDelete + totalToAnonymize > 0;

  async function onPreview(e: React.FormEvent) {
    e.preventDefault();
    if (!looksValid || loading) return;
    setLoading(true); setError(null); setPreview(null);
    try {
      const r = await requestAccountDeletion({ deviceId: trimmed, dryRun: true });
      setPreview(r); setStep("preview"); setConfirmed(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : (isEs ? "Error desconocido" : "Error desconegut"));
    } finally { setLoading(false); }
  }

  async function onConfirm() {
    if (!looksValid || !confirmed || loading) return;
    setLoading(true); setError(null);
    try {
      const r = await requestAccountDeletion({ deviceId: trimmed });
      setResult(r); setStep("done");
      try {
        const stored = window.localStorage.getItem(DEVICE_KEY);
        if (stored && stored.trim() === trimmed) window.localStorage.clear();
      } catch { /* */ }
      // Redirigim a l'inici després d'un breu moment perquè l'usuari vegi el resum.
      setTimeout(() => { navigate("/"); }, 2500);
    } catch (err) {
      setError(err instanceof Error ? err.message : (isEs ? "Error desconocido" : "Error desconegut"));
    } finally { setLoading(false); }
  }

  function onBackToInput() {
    setStep("input"); setPreview(null); setConfirmed(false); setError(null);
  }

  const T = isEs ? {
    headerSub: "Solicitud de borrado de datos",
    backHome: "Volver al inicio",
    title: "Borrar mis datos",
    intro: <>Esta página permite solicitar el borrado de todos los datos asociados a tu dispositivo en los servidores de <strong>Truc Valencià</strong>. No necesitas cuenta: solo <strong>el identificador anónimo de tu dispositivo</strong>.</>,
    h2What: "Qué se borra",
    whatList: [
      <><strong>Estadísticas de juego</strong> asociadas al dispositivo (envites, hechos, frecuencia de faroles…).</>,
      <><strong>Presencia en salas</strong>: tu asiento se libera de cualquier mesa donde aún aparezcas.</>,
      <><strong>Mensajes del chat de sala</strong> que has enviado.</>,
      <><strong>Mensajes de chat de partida</strong> que has enviado se anonimizan (se mantiene el texto, se borra tu identificador).</>,
    ],
    h2Plazos: "Plazos de borrado",
    h2Consent: "Consentimiento expreso",
    consentLead: <>Al pulsar <em>"Borrar definitivamente"</em> declaras, bajo tu responsabilidad, que:</>,
    consentItems: [
      "Eres el titular legítimo del dispositivo identificado por el identificador anónimo introducido.",
      <>Has leído y comprendes que el borrado es <strong>irreversible</strong>.</>,
      "Aceptas que los mensajes del chat de partida se conservan anonimizados.",
      <>Has leído la <Link to="/privacitat" className="underline text-primary">Política de Privacidad</Link>.</>,
      <>Puedes ejercer derechos ARCO/ARSULIPO o reclamar ante la <strong>AEPD</strong> (www.aepd.es).</>,
    ],
    h2GetId: "Cómo obtener mi identificador",
    getIdP: <>Si aún tienes la app instalada, ve a <Link to="/ajustes" className="underline text-primary">Configuración</Link> y usa el botón <strong>"Borrar mis datos"</strong>.</>,
    getIdSmall: "Si ya no tienes la app, el identificador era una cadena tipo UUID generada al primer uso.",
    h2Form: "Solicitud",
    label: "Identificador anónimo del dispositivo",
    invalidFormat: "Formato no válido. Debe tener entre 4 y 80 caracteres alfanuméricos, guión o guión bajo.",
    btnCheck: "Comprobar qué datos hay",
    note: <>Este paso <strong>no borra nada todavía</strong>. Te mostraremos cuántos datos tenemos de tu dispositivo y deberás confirmar explícitamente el borrado.</>,
    deviceIdentLabel: "Dispositivo identificado con:",
    noData: "No hay datos asociados a este identificador.",
    noDataSub: "O bien el identificador es incorrecto, o ya se han borrado anteriormente.",
    deleteLead: "Datos que se borrarán de manera irreversible:",
    anonSuffix: "(se anonimizarán, el texto se mantiene)",
    confirmCheck: <>He leído y acepto el <em>Consentimiento expreso</em> y los <em>Plazos de borrado</em>. Confirmo que quiero borrar estos datos de manera <strong>irreversible</strong> (art. 17 RGPD).</>,
    btnBack: "Volver",
    btnDelete: "Borrar definitivamente",
    doneTitle: "Datos borrados correctamente",
    doneP: <>Los datos asociados al dispositivo se han procesado en el servidor.</>,
    deletedPrefix: "Borrados:",
    anonPrefix: "Anonimizados:",
    noneFound: "No se ha encontrado ningún dato para este identificador.",
    doneSmall: "Si has hecho esta operación desde el mismo navegador donde tenías la app, los datos locales también se han limpiado.",
    moreInfo: <>Más información en nuestra <Link to="/privacitat" className="underline text-primary">Política de Privacidad</Link>.</>,
    backFooter: "Volver al inicio",
  } : {
    headerSub: "Sol·licitud d'esborrat de dades",
    backHome: "Tornar a inici",
    title: "Esborrar les meues dades",
    intro: <>Aquesta pàgina permet sol·licitar l'esborrat de totes les dades associades al teu dispositiu en els servidors de <strong>Truc Valencià</strong>. No cal tindre cap compte: només necessites <strong>l'identificador anònim del teu dispositiu</strong>.</>,
    h2What: "Què s'esborra",
    whatList: [
      <><strong>Estadístiques de joc</strong> associades al dispositiu.</>,
      <><strong>Presència a sales</strong>: el teu seient s'allibera.</>,
      <><strong>Missatges del xat de sala</strong> que has enviat.</>,
      <><strong>Missatges de xat de partida</strong>: s'anonimitzen.</>,
    ],
    h2Plazos: "Terminis d'esborrat",
    h2Consent: "Consentiment exprés",
    consentLead: <>En polsar <em>"Esborrar definitivament"</em> declares que:</>,
    consentItems: [
      "Ets el titular legítim del dispositiu.",
      <>L'esborrat és <strong>irreversible</strong>.</>,
      "Els missatges del xat de partida es conserven anonimitzats.",
      <>Has llegit la <Link to="/privacitat" className="underline text-primary">Política de Privacitat</Link>.</>,
      <>Pots reclamar davant l'<strong>AEPD</strong> (www.aepd.es).</>,
    ],
    h2GetId: "Com obtindre el meu identificador",
    getIdP: <>Si encara tens l'app instal·lada, vés a <Link to="/ajustes" className="underline text-primary">Configuració</Link>.</>,
    getIdSmall: "Si ja no tens l'app, l'identificador era una cadena tipus UUID generada al primer ús.",
    h2Form: "Sol·licitud",
    label: "Identificador anònim del dispositiu",
    invalidFormat: "Format no vàlid. Ha de tenir entre 4 i 80 caràcters alfanumèrics, guió o guió baix.",
    btnCheck: "Comprovar quines dades hi ha",
    note: <>Aquest pas <strong>no esborra res encara</strong>.</>,
    deviceIdentLabel: "Dispositiu identificat amb:",
    noData: "No hi ha dades associades a aquest identificador.",
    noDataSub: "O bé l'identificador és incorrecte, o ja s'han esborrat anteriorment.",
    deleteLead: "Dades que s'esborraran de manera irreversible:",
    anonSuffix: "(s'anonimitzaran, el text es manté)",
    confirmCheck: <>He llegit i accepte. Confirme que vull esborrar de manera <strong>irreversible</strong> (art. 17 RGPD).</>,
    btnBack: "Tornar",
    btnDelete: "Esborrar definitivament",
    doneTitle: "Dades esborrades correctament",
    doneP: <>Les dades associades al dispositiu s'han processat al servidor.</>,
    deletedPrefix: "Esborrats:",
    anonPrefix: "Anonimitzats:",
    noneFound: "No s'ha trobat cap dada per aquest identificador.",
    doneSmall: "Si has fet aquesta operació des del mateix navegador on tenies l'app, les dades locals també s'han netejat.",
    moreInfo: <>Més informació a la nostra <Link to="/privacitat" className="underline text-primary">Política de Privacitat</Link>.</>,
    backFooter: "Tornar a l'inici",
  };

  return (
    <main className="min-h-screen px-5 py-8 bg-background text-foreground">
      <div className="w-full max-w-lg mx-auto flex flex-col gap-4">
        <div className="flex items-center justify-between">
          <ShareAppButton />
          <Button
            onClick={() => navigate("/")}
            size="sm"
            variant="outline"
            className="h-8 w-8 p-0 border-foreground/80 text-foreground hover:bg-foreground/10"
            aria-label={T.backHome}
            title={T.backHome}
          >
            <LogOut className="w-4 h-4" />
          </Button>
        </div>

        <article className="max-w-none text-muted-foreground [&_p]:text-[14px] [&_p]:leading-relaxed [&_ul]:text-[14px] [&_ul]:leading-relaxed [&_li]:text-[14px] [&_li]:leading-relaxed">
          <p className="text-xs text-muted-foreground">{T.headerSub}</p><br/>
          <h1 className="font-title font-black italic text-gold text-[26px] normal-case mb-2">{T.title}</h1>
          <p>{T.intro}</p>

          <section className="mt-6">
            <h2 className="font-display font-bold text-base mt-4 mb-2 text-foreground">{T.h2What}</h2>
            <ul className="list-disc pl-6 my-3 space-y-1">
              {T.whatList.map((item, i) => <li key={i}>{item}</li>)}
            </ul>
          </section>

          <section className="mt-6">
            <h2 className="font-display font-bold text-base mt-4 mb-2 text-foreground">{T.h2Consent}</h2>
            <div className="rounded-md border border-border bg-muted/20 p-4 text-[14px] space-y-2">
              <p className="font-medium">{T.consentLead}</p>
              <ol className="list-decimal pl-5 space-y-1">
                {T.consentItems.map((item, i) => <li key={i}>{item}</li>)}
              </ol>
            </div>
          </section>

          <section className="mt-6">
            <h2 className="font-display font-bold text-base mt-4 mb-2 text-foreground">{T.h2GetId}</h2>
            <p>{T.getIdP}</p>
            <p className="text-[12px]">{T.getIdSmall}</p>
          </section>


          <section className="mt-6">
            <h2 className="font-display font-bold text-base mt-4 mb-2 text-foreground">{T.h2Form}</h2>
            {step === "input" && (
              <form onSubmit={onPreview} className="not-prose flex flex-col gap-3">
                <label htmlFor="deviceId" className="text-[14px] font-medium">{T.label}</label>
                <Input id="deviceId" type="text" value={deviceId} onChange={(e) => setDeviceId(e.target.value)} placeholder="p. ej. 3f8a1c20-…" autoComplete="off" disabled={loading} className="bg-background/40 border-primary/30 text-white" />
                {!looksValid && trimmed.length > 0 && (
                  <p className="text-[12px] text-destructive">{T.invalidFormat}</p>
                )}
                {error && (
                  <p className="text-[14px] text-destructive flex items-center gap-2">
                    <ShieldAlert className="w-4 h-4" /> {error}
                  </p>
                )}
                <Button type="submit" disabled={!looksValid || loading} variant="outline" className="w-full text-white hover:text-white">
                  {loading ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Eye className="w-4 h-4 mr-2" />}
                  {T.btnCheck}
                </Button>
                <p className="text-[12px]">{T.note}</p>
              </form>
            )}

            {step === "preview" && preview && (
              <div className="not-prose flex flex-col gap-4">
                <div className="rounded-md border border-primary/30 bg-primary/5 p-3 text-[14px]">
                  <p className="text-[12px]">{T.deviceIdentLabel}</p>
                  <p className="font-mono text-[12px] break-all mt-1">{trimmed}</p>
                </div>

                {!hasAnyData ? (
                  <div className="rounded-md border border-border bg-muted/30 p-3 text-[14px]">
                    <p className="font-medium">{T.noData}</p>
                    <p className="text-[12px] mt-1">{T.noDataSub}</p>
                  </div>
                ) : (
                  <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-[14px] flex flex-col gap-2">
                    <p className="font-medium text-destructive">{T.deleteLead}</p>
                    <ul className="text-[12px] space-y-1 ml-4 list-disc">
                      {Object.entries(preview.deleted).filter(([, n]) => n > 0).map(([t, n]) => (
                        <li key={t}><strong>{n}</strong> {labelForTable(t, isEs)}</li>
                      ))}
                      {Object.entries(preview.anonymized).filter(([, n]) => n > 0).map(([t, n]) => (
                        <li key={`a-${t}`}><strong>{n}</strong> {labelForTable(t, isEs)} {T.anonSuffix}</li>
                      ))}
                    </ul>
                  </div>
                )}

                {hasAnyData && (
                  <label className="flex items-start gap-2 text-[14px]">
                    <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} disabled={loading} className="mt-1" />
                    <span>{T.confirmCheck}</span>
                  </label>
                )}

                {error && (
                  <p className="text-[14px] text-destructive flex items-center gap-2">
                    <ShieldAlert className="w-4 h-4" /> {error}
                  </p>
                )}

                <div className="flex gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    onClick={onBackToInput}
                    disabled={loading}
                    className="h-9 w-9 p-0 border-foreground/80 text-foreground hover:bg-foreground/10 shrink-0"
                    aria-label={T.btnBack}
                    title={T.btnBack}
                  >
                    <ArrowLeft className="w-4 h-4" />
                  </Button>
                  {hasAnyData && (
                    <Button type="button" variant="destructive" onClick={onConfirm} disabled={!confirmed || loading} className="flex-1">
                      {loading ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Trash2 className="w-4 h-4 mr-2" />}
                      {T.btnDelete}
                    </Button>
                  )}
                </div>
              </div>
            )}

            {step === "done" && result && (
              <div className="not-prose rounded-md border border-team-nos/40 bg-team-nos/10 p-4 text-[14px] flex flex-col gap-2">
                <p className="flex items-center gap-2 font-medium text-team-nos text-[16px]">
                  <CheckCircle2 className="w-5 h-5" /> {T.doneTitle}
                </p>
                <p className="text-[14px]">{T.doneP}</p>
                <ul className="text-[12px] ml-4 list-disc space-y-0.5">
                  {Object.entries(result.deleted).filter(([, n]) => n > 0).map(([t, n]) => (
                    <li key={t}>{T.deletedPrefix} <strong>{n}</strong> {labelForTable(t, isEs)}</li>
                  ))}
                  {Object.entries(result.anonymized).filter(([, n]) => n > 0).map(([t, n]) => (
                    <li key={`a-${t}`}>{T.anonPrefix} <strong>{n}</strong> {labelForTable(t, isEs)}</li>
                  ))}
                  {totalToDelete + totalToAnonymize === 0 && <li>{T.noneFound}</li>}
                </ul>
                <p className="text-[12px] mt-2">{T.doneSmall}</p>
              </div>
            )}
          </section>

          <section className="mt-8 text-[14px]">
            <p>{T.moreInfo}</p>
          </section>

        </article>
      </div>
    </main>
  );
};

export default EsborrarDades;