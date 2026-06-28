import { useCallback, useRef, useState } from "react";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { useT } from "@/i18n/useT";

/**
 * Confirmation dialog with the same visual style as PlayerProfileDialog
 * (rounded border, gold accents) but with no title and a height that adapts
 * to the message. Exposed via a hook with an imperative `confirm()` returning
 * a Promise<boolean> so the call site can `await` the user's decision.
 */
export function useConfirm() {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState<string>("");
  const resolverRef = useRef<((value: boolean) => void) | null>(null);

  const confirm = useCallback((msg: string) => {
    setMessage(msg);
    setOpen(true);
    return new Promise<boolean>((resolve) => {
      resolverRef.current = resolve;
    });
  }, []);

  const handleClose = (value: boolean) => {
    setOpen(false);
    const r = resolverRef.current;
    resolverRef.current = null;
    r?.(value);
  };

  const dialog = (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) handleClose(false);
      }}
    >
      <DialogContent
        className="w-[90vw] sm:max-w-md rounded-2xl border-primary/30 p-5 [&>button]:hidden"
      >
        <DialogTitle className="sr-only">{t("common.confirm")}</DialogTitle>
        <p className="text-sm text-foreground whitespace-pre-line text-center">
          {message}
        </p>
        <div className="flex justify-center gap-2 pt-1">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="text-gold"
            onClick={() => handleClose(false)}
          >
            {t("common.cancel")}
          </Button>
          <Button
            type="button"
            variant="default"
            size="sm"
            onClick={() => handleClose(true)}
          >
            {t("common.accept")}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );

  return { confirm, dialog };
}