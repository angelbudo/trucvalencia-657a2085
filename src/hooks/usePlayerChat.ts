import { useState, useCallback, useEffect, useRef } from "react";
import { PlayerId } from "@/game/types";
import { ChatMessage, ChatPhraseId } from "@/game/phrases";

const DEFAULT_MESSAGE_DURATION_MS = 4500;
// Gap entre la DESAPARICIÓ del bocadillo anterior i l'aparició del següent.
// Petit, només per evitar solapaments visuals i mantenir una cadència
// raonable. Si el bocadillo anterior ja ha desaparegut, el nou apareix
// instantàniament (sense afegir cap espera artificial).
const MIN_MESSAGE_GAP_MS = 250;

type QueuedChatMessage = ChatMessage & { durationMs: number; showAt: number };

export function usePlayerChat() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  // Moment (epoch ms) en què apareixerà el PRÒXIM bocadillo de cada
  // jugador. Es manté PER JUGADOR (no global) perquè dos bocadillos
  // de jugadors diferents poden conviure en pantalla simultàniament
  // (regla de convivència: pregunta + resposta visibles a la vegada).
  // Sols s'encolen els bocadillos consecutius del mateix jugador.
  const nextVisibleAtByPlayerRef = useRef<Map<PlayerId, number>>(new Map());
  const timersRef = useRef<number[]>([]);
  const pendingRef = useRef<QueuedChatMessage[]>([]);
  const drainingRef = useRef(false);

  const reset = useCallback(() => {
    timersRef.current.forEach((timer) => window.clearTimeout(timer));
    timersRef.current = [];
    pendingRef.current = [];
    drainingRef.current = false;
    nextVisibleAtByPlayerRef.current.clear();
    setMessages([]);
  }, []);

  useEffect(() => () => {
    reset();
  }, [reset]);

  const drainQueue = useCallback(() => {
    if (drainingRef.current) return;

    const drainNext = () => {
      pendingRef.current.sort((a, b) => a.showAt - b.showAt);
      const msg = pendingRef.current.shift();
      if (!msg) {
        drainingRef.current = false;
        return;
      }

      drainingRef.current = true;
      const now = Date.now();
      const delay = Math.max(0, msg.showAt - now);
      const showTimer = window.setTimeout(() => {
        setMessages(prev => [...prev.filter(m => m.player !== msg.player), { ...msg }].sort((a, b) => a.timestamp - b.timestamp));
        const hideTimer = window.setTimeout(() => {
          setMessages(prev => prev.filter(m => m.id !== msg.id));
        }, msg.durationMs) as unknown as number;
        timersRef.current.push(hideTimer);
        drainingRef.current = false;
        drainNext();
      }, delay) as unknown as number;
      timersRef.current.push(showTimer);
    };

    drainNext();
  }, []);

  const say = useCallback((
    player: PlayerId,
    phraseId: ChatPhraseId,
    durationMs: number = DEFAULT_MESSAGE_DURATION_MS,
    vars?: Record<string, string | number>,
  ): number => {
    const now = Date.now();
    // El bocadillo apareixerà tan prompte com el ANTERIOR DEL MATEIX
    // JUGADOR haja desaparegut + un xicotet marge. Bocadillos d'altres
    // jugadors poden conviure en pantalla simultàniament.
    const prevForPlayer = nextVisibleAtByPlayerRef.current.get(player) ?? 0;
    const showAt = Math.max(now, prevForPlayer);
    nextVisibleAtByPlayerRef.current.set(player, showAt + durationMs + MIN_MESSAGE_GAP_MS);

    const msg: QueuedChatMessage = {
      id: `${now}-${Math.random()}`,
      player,
      phraseId,
      timestamp: now,
      vars,
      durationMs,
      showAt,
    };
    pendingRef.current.push(msg);
    drainQueue();
    return Math.max(0, showAt - now);
  }, [drainQueue]);

  return { messages, say, reset };
}