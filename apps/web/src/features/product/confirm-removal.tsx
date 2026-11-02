import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@cerebro/ui/components/alert-dialog";
import type { ReactNode } from "react";

// One dialog per list: `target` names the record awaiting confirmation.
export const ConfirmRemoval = ({
  target,
  busy,
  children,
  onCancel,
  onConfirm,
}: {
  target: string | null;
  busy: boolean;
  children: ReactNode;
  onCancel: () => void;
  onConfirm: (target: string) => void;
}) => (
  <AlertDialog
    open={target !== null}
    onOpenChange={(open) => {
      if (!open) {
        onCancel();
      }
    }}
  >
    <AlertDialogContent>
      <AlertDialogHeader>
        <AlertDialogTitle>Remove {target}?</AlertDialogTitle>
        <AlertDialogDescription>{children}</AlertDialogDescription>
      </AlertDialogHeader>
      <AlertDialogFooter>
        <AlertDialogCancel disabled={busy}>Keep</AlertDialogCancel>
        <AlertDialogAction
          variant="destructive"
          disabled={busy}
          onClick={() => {
            if (target !== null) {
              onConfirm(target);
            }
          }}
        >
          Remove {target}
        </AlertDialogAction>
      </AlertDialogFooter>
    </AlertDialogContent>
  </AlertDialog>
);
