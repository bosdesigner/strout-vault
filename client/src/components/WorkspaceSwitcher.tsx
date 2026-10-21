import { Layers } from "lucide-react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useWorkspace } from "@/lib/workspace";
import { cn } from "@/lib/utils";

const ALL = "__all";

/** Scopes every list (library, search, people, projects, review) to one workspace. */
export function WorkspaceSwitcher({ className }: { className?: string }) {
  const { workspaceId, setWorkspaceId, workspaces } = useWorkspace();
  return (
    <Select value={workspaceId || ALL} onValueChange={(v) => setWorkspaceId(v === ALL ? "" : v)}>
      <SelectTrigger className={cn("h-8 gap-1.5 border-transparent bg-muted/60 text-sm font-medium hover:bg-muted", className)} aria-label="Workspace" data-testid="workspace-switcher">
        <Layers className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={ALL}>All workspaces</SelectItem>
        {workspaces.map((w) => (
          <SelectItem key={w.id} value={w.id}>{w.name}</SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
