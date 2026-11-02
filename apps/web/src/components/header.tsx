import { Link } from "@tanstack/react-router";

import UserMenu from "./user-menu";

const navLink =
  "text-shell-muted hover:text-shell-foreground focus-visible:outline-shell-foreground focus-visible:outline-2 focus-visible:outline-offset-4 [&.active]:text-shell-foreground";

const Header = () => (
  <header className="bg-shell text-shell-foreground border-shell-border flex h-(--header-height) items-center justify-between border-b px-4 md:px-6">
    <nav
      aria-label="Main navigation"
      className="flex items-center gap-6 text-sm"
    >
      <Link
        to="/"
        className="font-display focus-visible:outline-shell-foreground text-lg tracking-tight focus-visible:outline-2 focus-visible:outline-offset-4"
      >
        Cerebro
      </Link>
      <Link to="/dashboard" className={navLink}>
        Workspace
      </Link>
    </nav>
    <UserMenu />
  </header>
);

export default Header;
