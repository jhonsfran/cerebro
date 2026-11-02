import { Button } from "@cerebro/ui/components/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@cerebro/ui/components/card";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@cerebro/ui/components/empty";
import { Field, FieldGroup, FieldLabel } from "@cerebro/ui/components/field";
import { Input } from "@cerebro/ui/components/input";
import { SidebarTrigger } from "@cerebro/ui/components/sidebar";
import { Spinner } from "@cerebro/ui/components/spinner";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@cerebro/ui/components/tabs";
import { Bot, MessagesSquare, ShieldAlert, SquarePen } from "lucide-react";
import type { ReactNode } from "react";

import { AccessPanel } from "./access-panel";
import { AgentEditor } from "./agent-editor";
import { ConversationPanel } from "./conversation";
import { LoadingState, PageBody } from "./feedback";
import type { AgentDetail, AgentSummary, Setup } from "./types";
import type { AgentTab, WorkspaceView } from "./workspace-view";

interface WorkspaceBodyProps {
  setup: Setup | null;
  selected: AgentSummary | undefined;
  agent: AgentDetail | null;
  view: Exclude<WorkspaceView, { kind: "admin" }>;
  busy: boolean;
  conversationId: string | undefined;
  conversationPending: boolean;
  userId: string;
  setView: (view: WorkspaceView) => void;
  claimSetup: () => Promise<void>;
  bootstrapToken: string;
  setBootstrapToken: (token: string) => void;
  startConversation: () => Promise<void>;
  refreshAgent: () => Promise<void>;
  onSaved: (agentId: string) => Promise<void>;
  onConversation: (conversationId: string) => void;
}
const agentTabs = ["conversation", "configuration", "access"] as const;
const tabLabels = {
  access: "Access",
  configuration: "Configuration",
  conversation: "Conversation",
} satisfies Record<AgentTab, string>;
const isAgentTab = (value: unknown): value is AgentTab =>
  agentTabs.some((tab) => tab === value);

// A page with nothing in it yet: one message and at most one action.
const EmptyPage = ({
  icon,
  title,
  children,
  action,
}: {
  icon: ReactNode;
  title: string;
  children: ReactNode;
  action?: ReactNode;
}) => (
  <div className="flex min-h-0 flex-1 overflow-y-auto p-4 md:p-6">
    <Empty>
      <EmptyHeader>
        <EmptyMedia variant="icon">{icon}</EmptyMedia>
        <EmptyTitle className="font-display text-xl font-normal">
          {title}
        </EmptyTitle>
        <EmptyDescription>{children}</EmptyDescription>
      </EmptyHeader>
      {action ? <EmptyContent>{action}</EmptyContent> : null}
    </Empty>
  </div>
);

const WelcomePanel = ({
  setup,
  selected,
  busy,
  startConversation,
  create,
}: {
  setup: Setup;
  selected: AgentSummary | undefined;
  busy: boolean;
  startConversation: () => Promise<void>;
  create: () => void;
}) => {
  let action: ReactNode = null;
  if (selected) {
    action = (
      <Button disabled={busy} type="button" onClick={startConversation}>
        {busy ? (
          <Spinner data-icon="inline-start" />
        ) : (
          <SquarePen data-icon="inline-start" aria-hidden="true" />
        )}
        Start a conversation
      </Button>
    );
  } else if (setup.owner) {
    action = (
      <Button type="button" onClick={create}>
        Create your first agent
      </Button>
    );
  }
  return (
    <EmptyPage
      icon={<MessagesSquare aria-hidden="true" />}
      title="Answers with sources. Actions with control."
      action={action}
    >
      {selected ? "Start" : "Choose an agent and start"} a private conversation.
      Review its sources, tools, and approval requests in one place.
    </EmptyPage>
  );
};

const InstallationSetup = ({
  setup,
  busy,
  bootstrapToken,
  setBootstrapToken,
  claimSetup,
}: Pick<
  WorkspaceBodyProps,
  "busy" | "bootstrapToken" | "setBootstrapToken" | "claimSetup"
> & { setup: Setup }) => (
  <PageBody className="max-w-md py-10">
    <Card>
      <CardHeader>
        <CardTitle>
          <h2>Set up your company assistant</h2>
        </CardTitle>
        <CardDescription>
          The first owner configures agents and company access. The database
          permits one owner claim.
        </CardDescription>
      </CardHeader>
      {setup.bootstrapTokenRequired ? (
        <CardContent>
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="installation-token">
                Installation token
              </FieldLabel>
              <Input
                id="installation-token"
                type="password"
                autoComplete="off"
                value={bootstrapToken}
                onChange={(event) => setBootstrapToken(event.target.value)}
              />
            </Field>
          </FieldGroup>
        </CardContent>
      ) : null}
      <CardFooter>
        <Button
          disabled={busy || (setup.bootstrapTokenRequired && !bootstrapToken)}
          type="button"
          onClick={claimSetup}
        >
          {busy ? <Spinner data-icon="inline-start" /> : null}
          {busy ? "Setting up…" : "Set up workspace"}
        </Button>
      </CardFooter>
    </Card>
  </PageBody>
);

const AgentContent = (props: WorkspaceBodyProps & { setup: Setup }) => {
  const {
    setup,
    selected,
    agent,
    view,
    busy,
    conversationId,
    conversationPending,
    userId,
    setView,
    startConversation,
    refreshAgent,
    onSaved,
    onConversation,
  } = props;
  const toConversation = () => setView({ kind: "agent", tab: "conversation" });
  if (view.kind === "create") {
    return (
      <AgentEditor
        key="new"
        agent={null}
        setup={setup}
        onSaved={onSaved}
        onCancel={toConversation}
      />
    );
  }
  if (view.tab === "configuration" && selected?.canManage) {
    return agent?.agentId === selected.agentId ? (
      <AgentEditor
        key={`${agent.agentId}:${agent.definition.version}`}
        agent={agent}
        setup={setup}
        onSaved={onSaved}
        onCancel={toConversation}
      />
    ) : (
      <PageBody>
        <LoadingState>Loading agent configuration…</LoadingState>
      </PageBody>
    );
  }
  if (view.tab === "access" && agent) {
    return <AccessPanel agent={agent} refresh={refreshAgent} />;
  }
  if (view.tab === "conversation" && conversationPending) {
    return (
      <PageBody>
        <LoadingState>Loading the agent for this conversation…</LoadingState>
      </PageBody>
    );
  }
  if (view.tab === "conversation" && conversationId && selected) {
    return (
      <ConversationPanel
        key={conversationId}
        conversationId={conversationId}
        userId={userId}
        agentId={selected.agentId}
        agentName={selected.name}
        onConversation={onConversation}
        onStartConversation={() => {
          void startConversation();
        }}
      />
    );
  }
  return (
    <WelcomePanel
      setup={setup}
      selected={selected}
      busy={busy}
      startConversation={startConversation}
      create={() => {
        setView({ kind: "create" });
      }}
    />
  );
};

const AgentWorkspace = (props: WorkspaceBodyProps & { setup: Setup }) => {
  const { selected, view, setView } = props;
  if (!(selected && view.kind === "agent")) {
    return <AgentContent {...props} />;
  }
  const tabDisabled = (value: AgentTab) =>
    value !== "conversation" && !selected.canManage;
  return (
    <Tabs
      value={view.tab}
      onValueChange={(value) => {
        if (isAgentTab(value)) {
          setView({ kind: "agent", tab: value });
        }
      }}
      className="min-h-0 flex-1 gap-0"
    >
      <div className="border-b px-4">
        <TabsList variant="line" aria-label="Agent views">
          {agentTabs.map((value) => (
            <TabsTrigger
              key={value}
              value={value}
              disabled={tabDisabled(value)}
              title={
                tabDisabled(value)
                  ? "Only people who manage this agent can open this."
                  : undefined
              }
            >
              {tabLabels[value]}
            </TabsTrigger>
          ))}
        </TabsList>
      </div>
      <TabsContent value={view.tab} className="flex min-h-0 flex-col">
        <AgentContent {...props} />
      </TabsContent>
    </Tabs>
  );
};

export const WorkspaceBody = (props: WorkspaceBodyProps) => {
  const { setup, busy, bootstrapToken, setBootstrapToken, claimSetup } = props;
  if (!setup) {
    return (
      <PageBody>
        <LoadingState>Loading your workspace…</LoadingState>
      </PageBody>
    );
  }
  if (setup.setupRequired) {
    return (
      <InstallationSetup
        setup={setup}
        busy={busy}
        bootstrapToken={bootstrapToken}
        setBootstrapToken={setBootstrapToken}
        claimSetup={claimSetup}
      />
    );
  }
  if (!setup.principalId) {
    return (
      <EmptyPage
        icon={<ShieldAlert aria-hidden="true" />}
        title="Company access is required"
      >
        Ask the installation owner to provision your company principal and grant
        access.
      </EmptyPage>
    );
  }
  return <AgentWorkspace {...props} setup={setup} />;
};

const headerTitle = (
  title: string | undefined,
  creating: boolean,
  selected: AgentSummary | undefined
): string => {
  if (title) {
    return title;
  }
  if (creating) {
    return "New agent";
  }
  return selected?.name ?? "Your company, connected.";
};

export const WorkspaceHeader = ({
  title,
  selected,
  creating,
  offerNew,
  busy,
  pending,
  onNew,
}: {
  title?: string;
  selected: AgentSummary | undefined;
  creating: boolean;
  offerNew: boolean;
  busy: boolean;
  pending: boolean;
  onNew: () => Promise<void>;
}) => (
  <header className="flex h-12 shrink-0 items-center gap-2 border-b px-4">
    <SidebarTrigger className="-ml-1" />
    {selected && !creating && !title ? (
      <Bot aria-hidden="true" className="text-muted-foreground size-4" />
    ) : null}
    <h1 className="min-w-0 flex-1 truncate text-sm font-medium">
      {headerTitle(title, creating, selected)}
    </h1>
    {selected && !creating && offerNew ? (
      <Button
        variant="outline"
        size="sm"
        disabled={busy || pending}
        type="button"
        onClick={onNew}
      >
        <SquarePen data-icon="inline-start" aria-hidden="true" />
        New conversation
      </Button>
    ) : null}
  </header>
);
