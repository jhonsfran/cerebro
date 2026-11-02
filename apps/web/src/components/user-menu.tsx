import { Button, buttonVariants } from "@cerebro/ui/components/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@cerebro/ui/components/dropdown-menu";
import { Skeleton } from "@cerebro/ui/components/skeleton";
import { cn } from "@cerebro/ui/lib/utils";
import { Link, useNavigate } from "@tanstack/react-router";

import { clearProductCache } from "@/features/product/api";
import { authClient } from "@/lib/auth-client";

// Ghost buttons on the dark top bar keep its light text.
const onShell =
  "text-shell-foreground hover:bg-shell-border hover:text-shell-foreground aria-expanded:bg-shell-border aria-expanded:text-shell-foreground";

const UserMenu = () => {
  const navigate = useNavigate();
  const { data: session, isPending } = authClient.useSession();

  if (isPending) {
    return <Skeleton className="h-9 w-24" />;
  }

  if (!session) {
    return (
      <Link
        to="/login"
        className={cn(buttonVariants({ variant: "ghost" }), onShell)}
      >
        Sign In
      </Link>
    );
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={<Button variant="ghost" className={onShell} />}
      >
        {session.user.name}
      </DropdownMenuTrigger>
      <DropdownMenuContent className="bg-card">
        <DropdownMenuGroup>
          <DropdownMenuLabel>My Account</DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuItem>{session.user.email}</DropdownMenuItem>
          <DropdownMenuItem
            variant="destructive"
            onClick={() => {
              clearProductCache();
              authClient.signOut({
                fetchOptions: {
                  onSuccess: () => {
                    navigate({
                      to: "/",
                    });
                  },
                },
              });
            }}
          >
            Sign Out
          </DropdownMenuItem>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
};

export default UserMenu;
