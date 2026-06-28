/**
 * Gestor central del AudioContext compartit.
 *
 * Els navegadors bloquegen la creació o reanudació d'un AudioContext si no hi
 * ha hagut cap gest d'usuari previ. Aquest mòdul:
 *   1. NO crea cap AudioContext fins que l'usuari ha interactuat amb la pàgina
 *      (o fins que `getAudioCtx()` es crida després del primer gest).
 *   2. Registra listeners globals que, al primer click/touch/keydown, marquen
 *      que la pàgina està desbloquejada i reanuden qualsevol context existent.
 */

let sharedAudioCtx: AudioContext | null = null;
let userInteracted = false;

type Win = Window & {
  AudioContext?: typeof AudioContext;
  webkitAudioContext?: typeof AudioContext;
};

function getCtor(): typeof AudioContext | null {
  if (typeof window === "undefined") return null;
  const w = window as Win;
  return w.AudioContext ?? w.webkitAudioContext ?? null;
}

function unlock() {
  userInteracted = true;
  if (sharedAudioCtx && sharedAudioCtx.state === "suspended") {
    void sharedAudioCtx.resume().catch(() => {
      /* ignore */
    });
  }
  removeListeners();
}

function onGesture() {
  unlock();
}

function removeListeners() {
  if (typeof window === "undefined") return;
  window.removeEventListener("pointerdown", onGesture);
  window.removeEventListener("touchstart", onGesture);
  window.removeEventListener("keydown", onGesture);
  window.removeEventListener("click", onGesture);
}

if (typeof window !== "undefined") {
  window.addEventListener("pointerdown", onGesture, { passive: true });
  window.addEventListener("touchstart", onGesture, { passive: true });
  window.addEventListener("keydown", onGesture);
  window.addEventListener("click", onGesture);
}

/**
 * Retorna l'AudioContext compartit, creant-lo de forma mandrosa NOMÉS si
 * l'usuari ja ha interactuat amb la pàgina. Si encara no s'ha produït cap
 * gest, retorna `null` perquè la crida silenciosa no provoque el warning
 * "AudioContext was not allowed to start".
 */
export function getAudioCtx(): AudioContext | null {
  try {
    if (typeof window === "undefined") return null;
    if (!userInteracted) return null;
    const Ctor = getCtor();
    if (!Ctor) return null;
    if (!sharedAudioCtx || sharedAudioCtx.state === "closed") {
      sharedAudioCtx = new Ctor();
    }
    if (sharedAudioCtx.state === "suspended") {
      void sharedAudioCtx.resume().catch(() => {
        /* ignore */
      });
    }
    return sharedAudioCtx;
  } catch {
    return null;
  }
}