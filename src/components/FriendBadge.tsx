import { Users } from "lucide-react";
import { cn } from "@/lib/utils";

interface FriendBadgeProps {
  className?: string;
  title?: string;
  variant?: "seat" | "chat";
}

export function FriendBadge({
  className,
  title = "Amic",
  variant = "chat",
}: FriendBadgeProps) {
  const isSeat = variant === "seat";

  return (
    <span
      className={cn(
        isSeat
          ? "inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-amber-300/80 bg-amber-700/60 backdrop-blur-sm text-amber-200 shadow-[0_1px_3px_rgba(0,0,0,0.5)] ring-1 ring-black/10"
          : "inline-flex h-4 w-4 shrink-0 items-center justify-center text-amber-500",
        className,
      )}
      title={title}
      aria-label={title}
    >
      <Users className={cn(isSeat ? "h-3 w-3" : "h-3.5 w-3.5")} strokeWidth={2.6} />
    </span>
  );
}