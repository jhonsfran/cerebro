import type { ChatControl } from "@cerebro/contracts/session-service";
import type { BackgroundWorkSnapshot } from "@cerebro/contracts/work";
import { Badge } from "@cerebro/ui/components/badge";
import { Button } from "@cerebro/ui/components/button";
import { useRef } from "react";

import { operationFor } from "./intent";
import type { OperationIntent } from "./intent";

const states = {
  accepted: "Accepted",
  running: "Running",
  cancelled: "Cancelled",
  completed: "Completed",
  failed: "Failed",
} satisfies Record<BackgroundWorkSnapshot["status"]["kind"], string>;

export const BackgroundWork = ({
  work,
  disabled,
  control,
}: {
  work: BackgroundWorkSnapshot;
  disabled: boolean;
  control: (command: ChatControl) => Promise<boolean>;
}) => {
  const intent = useRef<OperationIntent | null>(null);
  return (
    <section
      aria-label="Background work"
      className="bg-card flex flex-wrap items-center gap-2 rounded-md border px-3 py-2"
    >
      <span className="font-medium">Background work</span>
      <Badge
        variant={work.status.kind === "failed" ? "destructive" : "outline"}
      >
        {states[work.status.kind]}
      </Badge>
      {work.canCancel ? (
        <Button
          className="ml-auto"
          disabled={disabled}
          size="sm"
          type="button"
          variant="outline"
          onClick={async () => {
            const input = { kind: "stop-work", workId: work.workId } as const;
            const confirmed = await control({
              ...input,
              operationId: operationFor(intent, input),
            });
            if (confirmed) {
              intent.current = null;
            }
          }}
        >
          Stop background work
        </Button>
      ) : null}
    </section>
  );
};
