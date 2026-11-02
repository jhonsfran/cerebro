import { Spinner } from "@cerebro/ui/components/spinner";

const Loader = () => (
  <div className="flex h-full items-center justify-center pt-8">
    <Spinner className="size-6" />
    <span className="sr-only">Loading…</span>
  </div>
);

export default Loader;
