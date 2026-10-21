import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";

export default function NotFoundPage() {
  return (
    <div className="mx-auto max-w-7xl px-4 py-24 text-center">
      <h1 className="text-2xl font-semibold">Nothing here</h1>
      <p className="mt-2 text-muted-foreground">That page does not exist in the vault.</p>
      <Button asChild className="mt-6">
        <Link to="/">Back to the library</Link>
      </Button>
    </div>
  );
}
