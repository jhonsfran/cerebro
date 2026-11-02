import { Button } from "@cerebro/ui/components/button";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@cerebro/ui/components/input-group";
import { Copy, MessageSquareShare } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import { client } from "../../utils/orpc";
import { assertCurrentAccess, currentAccessGeneration } from "./api";
import { ErrorAlert } from "./feedback";
import { slackLinkSchema } from "./types";
import type { Setup } from "./types";

export const SlackLinkPanel = ({ setup }: { setup: Setup | null }) => {
  const [code, setCode] = useState<{ code: string; expiresAt: string } | null>(
    null
  );
  const [busy, setBusy] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");
  useEffect(() => {
    const clear = () => setCode(null);
    window.addEventListener("cerebro:access-cleared", clear);
    return () => window.removeEventListener("cerebro:access-cleared", clear);
  }, []);
  const link = async () => {
    if (!setup?.principalId || busy) {
      return;
    }
    const generation = currentAccessGeneration();
    setBusy(true);
    setErrorMessage("");
    try {
      const value = slackLinkSchema.parse(
        await client.identity.beginSlackLink({
          organizationId: setup.organizationId,
        })
      );
      assertCurrentAccess(generation);
      setCode(value);
    } catch (error) {
      setErrorMessage(
        error instanceof Error ? error.message : "The request failed."
      );
    }
    setBusy(false);
  };
  return (
    <div className="flex flex-col gap-2">
      <Button
        variant="ghost"
        size="sm"
        className="justify-start"
        type="button"
        disabled={!setup?.principalId || busy}
        onClick={link}
      >
        <MessageSquareShare data-icon="inline-start" aria-hidden="true" />
        Link your Slack account
      </Button>
      {errorMessage ? <ErrorAlert>{errorMessage}</ErrorAlert> : null}
      {code ? (
        <div className="bg-background flex flex-col gap-2 border p-2 text-xs/relaxed">
          <p>
            Send this complete command to the configured Slack bot in a direct
            message.
          </p>
          <InputGroup>
            <InputGroupInput
              aria-label="Slack link command"
              className="font-mono"
              readOnly
              value={`link ${code.code}`}
              onFocus={(event) => event.currentTarget.select()}
            />
            <InputGroupAddon align="inline-end">
              <InputGroupButton
                aria-label="Copy command"
                size="icon-xs"
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(`link ${code.code}`);
                    toast.success("Command copied.");
                  } catch {
                    toast.error("Copy failed. Select the command instead.");
                  }
                }}
              >
                <Copy aria-hidden="true" />
              </InputGroupButton>
            </InputGroupAddon>
          </InputGroup>
          <p className="text-muted-foreground">
            Expires at{" "}
            <time dateTime={code.expiresAt}>
              {new Date(code.expiresAt).toLocaleTimeString()}
            </time>
          </p>
          <Button
            variant="link"
            size="xs"
            className="self-start px-0"
            type="button"
            onClick={() => setCode(null)}
          >
            Hide code
          </Button>
        </div>
      ) : null}
    </div>
  );
};
