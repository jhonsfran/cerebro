import { Checkbox } from "@cerebro/ui/components/checkbox";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@cerebro/ui/components/table";
import { useRef, useState } from "react";

import { encoded, mutate, productPath } from "./api";
import { ErrorAlert, PageBody, PageIntro } from "./feedback";
import { operationFor } from "./intent";
import type { OperationIntent } from "./intent";
import { accessMutationSchema } from "./types";
import type { AccessAction, AgentDetail } from "./types";

const accessActions = ["read", "execute", "approve"] as const;
const actionLabels = {
  approve: "Approve",
  execute: "Execute",
  read: "Read",
} satisfies Record<(typeof accessActions)[number], string>;

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : "The request failed.";

export const AccessPanel = ({
  agent,
  refresh,
}: {
  agent: AgentDetail;
  refresh: () => Promise<void>;
}) => {
  const [errorMessage, setErrorMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const accessIntent = useRef<OperationIntent | null>(null);
  const change = async (principalId: string, actions: AccessAction[]) => {
    setBusy(true);
    setErrorMessage("");
    try {
      await mutate(
        productPath(
          `agents/${encoded(agent.agentId)}/access/${encoded(principalId)}`
        ),
        {
          actions,
          operationId: operationFor(accessIntent, {
            actions,
            agentId: agent.agentId,
            principalId,
          }),
        },
        accessMutationSchema,
        "PUT"
      );
      await refresh();
      accessIntent.current = null;
    } catch (error) {
      setErrorMessage(messageOf(error));
    }
    setBusy(false);
  };
  return (
    <PageBody>
      <PageIntro id="access-title" title={`Who can use ${agent.name}?`}>
        Changes apply to the next action in web and linked Slack conversations.
      </PageIntro>
      {errorMessage ? <ErrorAlert>{errorMessage}</ErrorAlert> : null}
      <div className="bg-card border">
        <Table aria-labelledby="access-title" aria-busy={busy}>
          <TableHeader>
            <TableRow>
              <TableHead scope="col">Account</TableHead>
              {accessActions.map((action) => (
                <TableHead
                  scope="col"
                  className="w-24 text-center"
                  key={action}
                >
                  {actionLabels[action]}
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {agent.access.map((entry) => (
              <TableRow key={entry.principalId}>
                <TableHead scope="row" className="h-auto py-2 font-normal">
                  <span className="flex flex-col">
                    <span className="font-medium">{entry.name}</span>
                    {entry.email && entry.email !== entry.name ? (
                      <span className="text-muted-foreground">
                        {entry.email}
                      </span>
                    ) : null}
                  </span>
                </TableHead>
                {accessActions.map((action) => (
                  <TableCell className="text-center" key={action}>
                    <Checkbox
                      className="mx-auto"
                      aria-label={`${action} access for ${entry.name}`}
                      checked={entry.actions.includes(action)}
                      disabled={busy}
                      onCheckedChange={(checked) =>
                        change(
                          entry.principalId,
                          checked
                            ? [...entry.actions, action]
                            : entry.actions.filter((value) => value !== action)
                        )
                      }
                    />
                  </TableCell>
                ))}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </PageBody>
  );
};
