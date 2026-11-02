import { cn } from "@cerebro/ui/lib/utils";
import { Loader2Icon } from "lucide-react";

const Spinner = ({ className, ...props }: React.ComponentProps<"svg">) => (
  <Loader2Icon
    data-slot="spinner"
    aria-hidden="true"
    className={cn("size-4 animate-spin", className)}
    {...props}
  />
);

export { Spinner };
