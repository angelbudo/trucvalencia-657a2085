import { useEffect } from "react";

/**
 * Detecta un gest de lliscar el dit cap a l'esquerra a tota la finestra
 * i executa l'acció (típicament, tornar enrere).
 */
export function useSwipeLeft(onSwipeLeft: () => void, enabled = true) {
  useEffect(() => {
    if (!enabled) return;
    let startX = 0;
    let startY = 0;
    let startT = 0;
    let tracking = false;

    const onStart = (e: TouchEvent) => {
      if (e.touches.length !== 1) return;
      tracking = true;
      startX = e.touches[0].clientX;
      startY = e.touches[0].clientY;
      startT = Date.now();
    };
    const onEnd = (e: TouchEvent) => {
      if (!tracking) return;
      tracking = false;
      const t = e.changedTouches[0];
      const dx = t.clientX - startX;
      const dy = t.clientY - startY;
      const dt = Date.now() - startT;
      // Llindars: swipe horitzontal cap a l'esquerra clar, no vertical, ràpid.
      if (dx < -60 && Math.abs(dy) < 50 && dt < 600) {
        onSwipeLeft();
      }
    };
    window.addEventListener("touchstart", onStart, { passive: true });
    window.addEventListener("touchend", onEnd, { passive: true });
    return () => {
      window.removeEventListener("touchstart", onStart);
      window.removeEventListener("touchend", onEnd);
    };
  }, [onSwipeLeft, enabled]);
}