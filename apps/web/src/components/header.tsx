import { Link } from "@tanstack/react-router";

import UserMenu from "./user-menu";

const Header = () => (
  <header className="flex min-h-16 items-center justify-between border-b border-white/10 bg-[#193327] px-6 text-[#e9f1e3]">
    <nav
      aria-label="Main navigation"
      className="flex items-center gap-6 text-sm"
    >
      <Link to="/" className="font-semibold tracking-tight">
        Cerebro
      </Link>
      <Link to="/dashboard" className="text-[#bfd0b5]">
        Workspace
      </Link>
    </nav>
    <UserMenu />
  </header>
);

export default Header;
