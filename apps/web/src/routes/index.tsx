import { buttonVariants } from "@cerebro/ui/components/button";
import { createFileRoute, Link } from "@tanstack/react-router";

const Home = () => (
  <main className="flex min-h-full items-center justify-center px-6 py-16">
    <div className="flex max-w-3xl flex-col gap-8">
      <h1 className="font-display text-5xl leading-tight tracking-tight sm:text-7xl">
        Your company knowledge.
        <br />A clear answer.
      </h1>
      <p className="text-muted-foreground max-w-xl text-base leading-8">
        Ask questions in a private conversation. Check the sources. Review tool
        activity and approve controlled actions before they continue.
      </p>
      <div className="flex flex-wrap gap-3">
        <Link to="/dashboard" className={buttonVariants({ size: "lg" })}>
          Open your workspace
        </Link>
        <Link
          to="/login"
          className={buttonVariants({ size: "lg", variant: "outline" })}
        >
          Sign in or create an account
        </Link>
      </div>
      <p className="text-muted-foreground text-xs">
        Self-hosted. Company-scoped access. Web and linked Slack direct
        messages.
      </p>
    </div>
  </main>
);

export const Route = createFileRoute("/")({ component: Home });
