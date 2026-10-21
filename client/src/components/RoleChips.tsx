import { Badge } from "@/components/ui/badge";
import type { RoleChip } from "@shared/types";
import { cn } from "@/lib/utils";

/** "Another Story · contractor · Houston (Conroe)" chips, one per role. */
export function RoleChips({ roles, className, hideWorkspace }: { roles: RoleChip[]; className?: string; hideWorkspace?: boolean }) {
  if (!roles.length) return null;
  return (
    <span className={cn("flex flex-wrap gap-1", className)}>
      {roles.map((r) => (
        <Badge key={`${r.workspaceId}-${r.role}`} variant={r.status === "former" ? "outline" : "muted"} title={r.detail ?? undefined} className={cn(r.status === "former" && "line-through opacity-70")}>
          {hideWorkspace ? "" : `${r.workspaceName} · `}
          {r.role}
          {r.market ? ` · ${r.market}` : ""}
          {r.status && r.status !== "active" ? <span className="opacity-70">· {r.status}</span> : null}
        </Badge>
      ))}
    </span>
  );
}
