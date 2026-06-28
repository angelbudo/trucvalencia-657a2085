import { useLayoutEffect, useRef, useState } from "react";
import { ChatPhraseId, PHRASES_BY_CATEGORY, PHRASES, ChatPhrase } from "@/game/phrases";
import { cn } from "@/lib/utils";
import { useT } from "@/i18n/useT";
import { HelpCircle, MessageSquare, Megaphone, X, LucideIcon } from "lucide-react";
import { TRUC_Z_INDEX } from "@/components/truc/layers";

interface ChatPanelProps {
  onSay: (phraseId: ChatPhraseId) => void;
  highlightPreguntes?: boolean;
  highlightRespostes?: boolean;
  highlightAltres?: boolean;
  /** IDs de frases que s'han d'amagar (per ex. quan l'envit ja s'ha resolt). */
  hiddenPhraseIds?: ReadonlySet<ChatPhraseId>;
  /** IDs de frases concretes que s'han de destacar visualment dins del panell. */
  highlightedPhraseIds?: ReadonlySet<ChatPhraseId>;
  /** Variables d'interpolació per a frases concretes (p. ex. {n} a "Tinc {n}"). */
  phraseVars?: Partial<Record<ChatPhraseId, Record<string, string | number>>>;
}

const TONE_STYLE = {
  neutral:  "bg-yellow-500/25 text-foreground border-yellow-500/60 hover:bg-yellow-500/35",
  positive: "bg-green-600/25 text-foreground border-green-500/60 hover:bg-green-600/35",
  negative: "bg-red-600/25 text-foreground border-red-500/60 hover:bg-red-600/35",
  envit:    "bg-green-600/25 text-foreground border-green-500/60 hover:bg-green-600/35",
};

type GroupKey = "preguntes" | "respostes" | "altres";

const GROUPS: Record<
  GroupKey,
  { labelKey: string; icon: LucideIcon; bottom: string; phrases: ChatPhrase[] }
> = {
  preguntes: {
    labelKey: "chat.preguntes",
    icon: HelpCircle,
    bottom: "bottom-[260px]",
    phrases: PHRASES_BY_CATEGORY.pregunta,
  },
  respostes: {
    labelKey: "chat.respostes",
    icon: MessageSquare,
    bottom: "bottom-[200px]",
    phrases: PHRASES_BY_CATEGORY.resposta,
  },
  altres: {
    labelKey: "chat.altres",
    icon: Megaphone,
    bottom: "bottom-[140px]",
    phrases: PHRASES_BY_CATEGORY.indicacio,
  },
};

export function ChatPanel({ onSay, highlightPreguntes, highlightRespostes, highlightAltres, hiddenPhraseIds, highlightedPhraseIds, phraseVars }: ChatPanelProps) {
  const t = useT();
  const [openGroup, setOpenGroup] = useState<GroupKey | null>(null);

  const toggle = (g: GroupKey) => setOpenGroup((cur) => (cur === g ? null : g));

  const active = openGroup ? GROUPS[openGroup] : null;
  const activePhrases = active
    ? active.phrases.filter((p) => !hiddenPhraseIds || !hiddenPhraseIds.has(p.id))
    : [];

  return (
    <>
      {(Object.keys(GROUPS) as GroupKey[]).map((key) => {
        const g = GROUPS[key];
        const Icon = g.icon;
        const isOpen = openGroup === key;
        // Per defecte (preguntes) usa el daurat del primary.
        // Respostes: més anaronjat. Altres: encara més anaronjat/intens.
        const colorClass =
          key === "respostes"
            ? "bg-orange-500 text-white shadow-[0_4px_16px_-2px_hsl(28_85%_55%/0.55),0_0_24px_hsl(28_85%_60%/0.3)]"
            : key === "altres"
              ? "bg-red-600 text-black shadow-[0_4px_16px_-2px_hsl(0_85%_45%/0.6),0_0_28px_hsl(8_90%_55%/0.35)]"
              : "bg-primary text-primary-foreground gold-glow";
        const ringClass =
          key === "respostes"
            ? "ring-2 ring-orange-400/70"
            : key === "altres"
              ? "ring-2 ring-red-500/80"
              : "ring-2 ring-primary/60";
        const shouldHighlight =
          !isOpen &&
          ((key === "preguntes" && !!highlightPreguntes) ||
            (key === "respostes" && !!highlightRespostes) ||
            (key === "altres" && !!highlightAltres));
        const highlightRingClass =
          key === "respostes"
            ? "animate-pulse-gold ring-2 ring-orange-400 border-orange-400"
            : key === "altres"
              ? "animate-pulse-gold ring-2 ring-red-500 border-red-500"
              : "animate-pulse-gold ring-2 ring-primary border-primary";
        return (
          <button
            key={key}
            onClick={() => toggle(key)}
            aria-label={t(g.labelKey)}
            className={cn(
              "fixed right-3 w-12 h-12 rounded-full",
              "shadow-lg",
              "flex items-center justify-center transition-transform active:scale-90",
              colorClass,
              g.bottom,
              isOpen && cn("rotate-90", ringClass),
              shouldHighlight && highlightRingClass
            )}
            style={{ zIndex: TRUC_Z_INDEX.chatControls }}
          >
            {isOpen ? <X className="w-5 h-5" /> : <Icon className="w-5 h-5 text-primary-foreground" />}
          </button>
        );
      })}

      {active && (
        <div className="fixed inset-x-0 bottom-0 animate-fade-in" style={{ zIndex: TRUC_Z_INDEX.chatDrawer }}>
          <div
            className="absolute inset-0 bg-background/40"
            onClick={() => setOpenGroup(null)}
          />
          <div className="relative wood-surface border-t-2 border-primary/60 rounded-t-2xl pt-2 pb-4 px-3 max-h-[55vh] overflow-y-auto">
            <div className="w-12 h-1 rounded-full bg-primary/50 mx-auto mb-2" />
            <div className="flex items-center justify-center gap-2 mb-3">
              <active.icon className="w-4 h-4 text-primary" />
              <span
                className="font-bold text-[16px] text-gold tracking-wide"
                style={{ fontFamily: "'Cinzel', serif", textTransform: "none", letterSpacing: "0.02em" }}
              >
                {t(active.labelKey)}
              </span>
            </div>
            <div className="grid grid-cols-2 gap-2">
              {activePhrases.map((p) => (
                <button
                  key={p.id}
                  onClick={() => {
                    onSay(p.id);
                    setOpenGroup(null);
                  }}
                  className={cn(
                    "chat-phrase-btn px-3 py-3 rounded-xl border-2 text-[16px] transition-all active:scale-95 text-left",
                    TONE_STYLE[p.tone],
                    highlightedPhraseIds?.has(p.id) && "animate-pulse-gold ring-2 ring-primary border-primary"
                  )}
                >
                  {t(`phrase.${p.id}`, phraseVars?.[p.id])}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
    </>
  );
}

export function ChatBubble({
  phraseId,
  position,
  vars,
}: {
  phraseId: ChatPhraseId;
  position: "bottom" | "top" | "left" | "right" | "bottom-left" | "bottom-right" | "top-left" | "top-right";
  vars?: Record<string, string | number>;
}) {
  const t = useT();
  const phrase = PHRASES.find((p) => p.id === phraseId);

  const wrapperRef = useRef<HTMLDivElement | null>(null);
  // Anchor point of the wrapper in viewport coordinates (x at seat-center
  // axis, y at the side of the avatar facing the bubble). Used to render
  // the bubble box as `position: fixed` so it can hug the screen edge with
  // a strict 10px margin without dragging the tail off the avatar.
  const [anchor, setAnchor] = useState<{ x: number; y: number } | null>(null);

  useLayoutEffect(() => {
    if (!phrase) return;
    const update = () => {
      const el = wrapperRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      setAnchor({ x: r.left, y: r.top });
    };
    update();
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(update) : null;
    if (ro && wrapperRef.current?.parentElement) ro.observe(wrapperRef.current.parentElement);
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    const id = window.setInterval(update, 250);
    return () => {
      ro?.disconnect();
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
      window.clearInterval(id);
    };
  }, [phrase]);

  if (!phrase) return null;

  const isTop = position.startsWith("top");      // bubble RENDERS BELOW avatar (tail up)
  const isBottom = position.startsWith("bottom"); // bubble RENDERS ABOVE avatar (tail down)
  const isLeft = position === "left";
  const isRight = position === "right";
  const isCenteredSideReply =
    (position === "top-left" || position === "top-right" || position === "bottom") &&
    (phraseId === "si" || phraseId === "no" || phraseId === "a-tu");

  // Wrapper origin = seat-center axis, flush with the avatar edge facing
  // the bubble. Tail is drawn at this origin (always on the avatar) while
  // the bubble box uses `position: fixed` independently.
  let wrapperPos = "";
  if (isTop) wrapperPos = "top-full left-1/2";
  else if (isBottom) wrapperPos = "bottom-full left-1/2";
  else if (isLeft) wrapperPos = "left-full top-1/2";
  else if (isRight) wrapperPos = "right-full top-1/2";

  // Tail (CSS triangles) drawn at the wrapper origin. The inner (card-
  // coloured) triangle is shifted 2px INTO the bubble so the bubble's
  // 2px border line is fully covered at the junction → tail + box read
  // as a single comic-strip piece.
  const TAIL_H = 13; // outer triangle height (gap between bubble edge and avatar)
  let tailEl: React.ReactNode = null;
  if (isTop) {
    const raiseTail = position === "top" || position === "top-left";
    tailEl = (
      <>
        <span className={cn("absolute left-0 -translate-x-1/2 z-40 w-0 h-0 border-x-[10px] border-x-transparent border-b-[12px] border-b-primary", raiseTail ? "top-[2px]" : "top-[3px]")} />
        <span className={cn("absolute left-0 -translate-x-1/2 z-[41] w-0 h-0 border-x-[9px] border-x-transparent border-b-[13px] border-b-card", raiseTail ? "top-[5px]" : "top-[6px]")} />
      </>
    );
  } else if (isBottom) {
    tailEl = (
      <>
        <span className="absolute left-0 -translate-x-1/2 bottom-[-2px] z-40 w-0 h-0 border-x-[10px] border-x-transparent border-t-[12px] border-t-primary" />
        <span className="absolute left-0 -translate-x-1/2 bottom-[1px] z-[41] w-0 h-0 border-x-[9px] border-x-transparent border-t-[13px] border-t-card" />
      </>
    );
  } else if (isLeft) {
    tailEl = (
      <>
        <span className="absolute top-0 -translate-y-1/2 left-[-2px] z-40 w-0 h-0 border-y-[10px] border-y-transparent border-r-[12px] border-r-primary" />
        <span className="absolute top-0 -translate-y-1/2 left-[1px] z-[41] w-0 h-0 border-y-[9px] border-y-transparent border-r-[13px] border-r-card" />
      </>
    );
  } else if (isRight) {
    tailEl = (
      <>
        <span className="absolute top-0 -translate-y-1/2 right-[-2px] z-40 w-0 h-0 border-y-[10px] border-y-transparent border-l-[12px] border-l-primary" />
        <span className="absolute top-0 -translate-y-1/2 right-[1px] z-[41] w-0 h-0 border-y-[9px] border-y-transparent border-l-[13px] border-l-card" />
      </>
    );
  }

  // Bubble box rendered fixed so it escapes any clipped parent and can
  // hug the viewport edge with a strict 10px safety margin while the
  // tail stays nailed to the avatar.
  const SIDE_MARGIN = 10;
  const boxStyle: React.CSSProperties = {
    position: "fixed",
    maxWidth: `calc(100vw - ${SIDE_MARGIN * 2}px)`,
  };
  if (anchor) {
    if (isBottom) {
      // Bubble ABOVE avatar (us). Bubble's bottom edge must sit TAIL_H
      // pixels ABOVE the anchor (which is the avatar's top edge), so the
      // gap matches the left/top/right players exactly.
      boxStyle.bottom = `calc(100vh - ${anchor.y - TAIL_H - 1}px)`;
    } else if (position === "top") {
      // Opposite player (front): fixed top per design spec.
      boxStyle.top = `115.5px`;
    } else if (position === "top-right") {
      // Right player: fixed top per design spec.
      boxStyle.top = `116.45px`;
    } else if (isTop) {
      // Other "top-*" variants (e.g. top-left): keep anchor-based positioning.
      boxStyle.top = `${anchor.y + TAIL_H}px`;
    } else if (isLeft || isRight) {
      boxStyle.top = `${anchor.y}px`;
      boxStyle.transform = "translateY(-50%)";
    }

    // Horizontal alignment per spec:
    //  - us + left + plain "top" partner / left-side variants  → left:10px
    //  - right-side variants (top-right, right, bottom-right)  → right:10px
    if (isCenteredSideReply) {
      // En les respostes curtes, centra el globus exactament sobre
      // la cua/fletxa que apunta al jugador.
      if (position === "top-right") {
        boxStyle.left = "31.2px";
      } else {
        boxStyle.left = `${anchor.x}px`;
      }
      boxStyle.transform = `${boxStyle.transform ?? ""} translateX(-50%)`.trim();
    } else if (position === "top-right") {
      boxStyle.right = `-5px`;
    } else if (position === "right" || position === "bottom-right") {
      boxStyle.right = `${SIDE_MARGIN}px`;
    } else if (position === "top") {
      // Partner (top of board): centred but clamped to 10px margins.
      boxStyle.left = "50%";
      boxStyle.transform = `${boxStyle.transform ?? ""} translateX(-50%)`.trim();
      boxStyle.maxWidth = `calc(100vw - ${SIDE_MARGIN * 2}px)`;
    } else {
      // bottom (us), top-left (left player), left, bottom-left
      boxStyle.left = `${SIDE_MARGIN}px`;
    }
  }

  return (
    <>
      <div
        ref={wrapperRef}
        className={cn("absolute pointer-events-none w-0 h-0", wrapperPos)}
      >
        {tailEl}
      </div>
      {anchor && (
        <div
          className={cn(
            "px-3 py-1.5 rounded-2xl pointer-events-none z-40",
            "bg-card text-card-foreground font-semibold text-[16px]",
            "w-max whitespace-normal break-words text-center leading-tight",
            "line-clamp-3 [overflow-wrap:anywhere]",
            "border-2 border-primary shadow-lg",
          )}
          style={boxStyle}
        >
          {t(`phrase.${phraseId}`, vars)}
        </div>
      )}
    </>
  );
}