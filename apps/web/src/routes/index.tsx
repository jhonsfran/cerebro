import { createFileRoute, Link } from "@tanstack/react-router";

const Home = () => (
  <main className="flex min-h-[calc(100svh-65px)] items-center justify-center bg-[#f0f3e9] px-6 py-16 text-[#183026]">
    <div className="max-w-3xl">
      <p className="mb-7 text-xs font-semibold tracking-[.2em] text-[#64735f]">
        CEREBRO · COMPANY ASSISTANT
      </p>
      <h1 className="font-serif text-5xl leading-tight tracking-tight sm:text-7xl">
        Your company knowledge.
        <br />A clear answer.
      </h1>
      <p className="mt-8 max-w-xl text-base leading-8 text-[#627267]">
        Ask questions in a private conversation. Check the sources. Review tool
        activity and approve controlled actions before they continue.
      </p>
      <div className="mt-10 flex gap-4">
        <Link
          to="/dashboard"
          className="rounded-md bg-[#23543b] px-6 py-3 text-sm font-medium text-white"
        >
          Open your workspace
        </Link>
        <Link
          to="/login"
          className="rounded-md border border-[#cbd8c3] px-6 py-3 text-sm font-medium"
        >
          Sign in or create an account
        </Link>
      </div>
      <p className="mt-14 text-xs text-[#72806b]">
        Self-hosted. Company-scoped access. Web and linked Slack direct
        messages.
      </p>
    </div>
  </main>
);

export const Route = createFileRoute("/")({ component: Home });
