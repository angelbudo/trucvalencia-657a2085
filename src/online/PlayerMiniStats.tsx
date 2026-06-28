import { Star, Award, ThumbsDown, Flame } from "lucide-react";
import type { PlayerMiniStats as Stats } from "@/online/usePlayerMiniStats";

/** Compact inline stats badge: level · win% · ratxa · abandoned. */
export function PlayerMiniStatsRow({ stats, className }: { stats: Stats | null | undefined; className?: string }) {
  if (!stats) return null;
  const total = stats.wins + stats.losses;
  const winRate = total > 0 ? Math.round((stats.wins / total) * 100) : 0;
  return (
    <span className={`inline-flex items-baseline gap-1 leading-none whitespace-nowrap ${className ?? ""}`}>
      <span className="inline-flex items-baseline gap-0.5 text-orange-500 font-bold text-sm" title="Nivell">
        <Star className="self-center translate-y-[1px] w-[15px] h-[15px] -mt-[3px]" /> {stats.level}
      </span>
      <span className="inline-flex items-baseline gap-0.5 text-[#e6b033] text-[12px] -translate-y-[1px]" title="% Victòries">
        <Award className="w-[14px] h-[14px] self-center translate-y-[1px] -mt-[2px]" /> {winRate}%
      </span>
      <span className="inline-flex items-baseline gap-0.5 text-[#66a50d] text-[12px] -translate-y-[1px]" title="Ratxa màx.">
        <Flame className="w-[14px] h-[14px] self-center translate-y-[1px] -mt-[2px]" /> {stats.max_streak}
      </span>
      <span className="inline-flex items-baseline gap-0.5 text-background/50 text-[12px] -translate-y-[1px]" title="Abandonades">
        <ThumbsDown className="w-[14px] h-[14px] self-center translate-y-[1px] -mt-[2px]" /> {stats.abandoned}
      </span>
    </span>
  );
}