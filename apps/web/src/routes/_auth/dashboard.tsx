import { createFileRoute } from "@tanstack/react-router";

import { ProductWorkspace } from "@/features/product/workspace";

const Dashboard = () => {
  const { session } = Route.useRouteContext();
  const { conversation } = Route.useSearch();
  const navigate = Route.useNavigate();
  return (
    <ProductWorkspace
      userId={session.data?.user.id ?? ""}
      userName={session.data?.user.name ?? ""}
      conversationId={conversation}
      onConversation={(conversationId) => {
        navigate({ search: { conversation: conversationId } });
      }}
    />
  );
};

export const Route = createFileRoute("/_auth/dashboard")({
  validateSearch: (
    search: Record<string, unknown>
  ): { conversation?: string } => ({
    conversation:
      typeof search.conversation === "string" ? search.conversation : undefined,
  }),
  component: Dashboard,
});
