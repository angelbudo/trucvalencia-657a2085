import { useRef, useEffect, useCallback } from "react";

interface TimerDef {
  at: number;
  fn: () => void;
  key?: string; // Propiedad opcional para etiquetar el timer
}

export function usePausableTimers(paused: boolean = false) {
  // Usamos un Map para identificar los timers por una clave de texto única
  const timersRef = useRef<Map<string, number>>(new Map());

  const clearAll = useCallback(() => {
    timersRef.current.forEach((id) => window.clearTimeout(id));
    timersRef.current.clear();
  }, []);

  // Función quirúrgica para borrar un timer concreto por su etiqueta sin tocar los demás
  const clearByKey = useCallback((key: string) => {
    if (timersRef.current.has(key)) {
      window.clearTimeout(timersRef.current.get(key)!);
      timersRef.current.delete(key);
    }
  }, []);

  const start = useCallback(
    (defs: TimerDef[]) => {
      if (paused) return;

      defs.forEach((def, index) => {
        const timerKey = def.key || `auto-${Date.now()}-${index}`;

        if (def.key && timersRef.current.has(def.key)) {
          window.clearTimeout(timersRef.current.get(def.key)!);
        }

        const id = window.setTimeout(() => {
          timersRef.current.delete(timerKey);
          def.fn();
        }, def.at);

        timersRef.current.set(timerKey, id);
      });
    },
    [paused],
  );

  useEffect(() => {
    if (paused) {
      clearAll();
    }
  }, [paused, clearAll]);

  return { start, clearAll, clearByKey };
}