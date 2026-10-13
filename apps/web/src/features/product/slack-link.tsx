import { useEffect, useState } from "react";

import { client } from "../../utils/orpc";
import { assertCurrentAccess, currentAccessGeneration } from "./api";
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
    <div className="sidebar-footer">
      <button
        className="text-button"
        type="button"
        disabled={!setup?.principalId || busy}
        onClick={link}
      >
        Link your Slack account
      </button>
      {errorMessage ? (
        <p className="error-banner" role="alert">
          {errorMessage}
        </p>
      ) : null}
      {code ? (
        <div className="slack-link-code">
          <p>
            Send this complete command to the configured Slack bot in a direct
            message.
          </p>
          <code>link {code.code}</code>
          <p>Expires {new Date(code.expiresAt).toLocaleTimeString()}</p>
          <button
            className="text-button"
            type="button"
            onClick={() => setCode(null)}
          >
            Hide code
          </button>
        </div>
      ) : null}
    </div>
  );
};
