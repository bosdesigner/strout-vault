import type { NextFunction, Request, RequestHandler, Response } from "express";
import type { SessionData } from "./types.ts";

/**
 * What a login may see. The owner sees everything. A contractor is scoped to
 * one workspace and sees only interactions they took part in or uploaded.
 */
export interface Scope {
  owner: boolean;
  workspaceId: string | null;
  partyId: number | null;
}

export function scopeOf(session: SessionData | null | undefined): Scope {
  if (!session || session.role === "owner") return { owner: true, workspaceId: null, partyId: null };
  return { owner: false, workspaceId: session.workspaceId ?? null, partyId: session.partyId ?? null };
}

/**
 * SQL predicate restricting `alias` (an interactions row) to what the scope may
 * see. Appends its parameters to `params`. Owners get "true".
 */
export function visibleInteractionsSql(scope: Scope, params: unknown[], alias = "i"): string {
  if (scope.owner) return "true";
  const conds: string[] = [];
  if (scope.workspaceId) {
    params.push(scope.workspaceId);
    conds.push(`${alias}.workspace_id = $${params.length}`);
  }
  if (scope.partyId) {
    params.push(scope.partyId);
    const p = `$${params.length}`;
    conds.push(
      `(exists (select 1 from interaction_participants ip where ip.interaction_id = ${alias}.id and ip.party_id = ${p})
        or exists (select 1 from media m where m.interaction_id = ${alias}.id and m.uploaded_by = ${p}))`,
    );
  } else {
    // A contractor login without a party row can see nothing but what they upload, which needs a party. Deny.
    conds.push("false");
  }
  return `(${conds.join(" and ")})`;
}

/** 403 unless the session belongs to the owner. */
export function requireOwner(): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.session || req.session.role !== "owner") {
      res.status(403).json({ error: "owner_only" });
      return;
    }
    next();
  };
}
