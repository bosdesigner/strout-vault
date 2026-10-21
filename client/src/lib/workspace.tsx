import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { useWorkspaces } from "@/hooks/useWorkspaces";
import type { WorkspaceRef } from "@shared/types";

const KEY = "sv-workspace";

interface WorkspaceState {
  /** "" means all workspaces. */
  workspaceId: string;
  setWorkspaceId: (id: string) => void;
  workspaces: WorkspaceRef[];
  current: WorkspaceRef | null;
  /** Query-string fragment ("&workspace=x" or "") for list endpoints. */
  param: string;
}

const Ctx = createContext<WorkspaceState | null>(null);

export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const [workspaceId, setState] = useState<string>(() => {
    try {
      return localStorage.getItem(KEY) ?? "";
    } catch {
      return "";
    }
  });
  const workspaces = useWorkspaces();
  const setWorkspaceId = useCallback((id: string) => {
    setState(id);
    try {
      if (id) localStorage.setItem(KEY, id);
      else localStorage.removeItem(KEY);
    } catch {
      /* private mode */
    }
  }, []);
  // Drop a stale id if the workspace no longer exists.
  useEffect(() => {
    if (workspaceId && workspaces.data && !workspaces.data.some((w) => w.id === workspaceId)) setWorkspaceId("");
  }, [workspaceId, workspaces.data, setWorkspaceId]);
  const value = useMemo<WorkspaceState>(
    () => ({
      workspaceId,
      setWorkspaceId,
      workspaces: workspaces.data ?? [],
      current: workspaces.data?.find((w) => w.id === workspaceId) ?? null,
      param: workspaceId ? `&workspace=${encodeURIComponent(workspaceId)}` : "",
    }),
    [workspaceId, setWorkspaceId, workspaces.data],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useWorkspace(): WorkspaceState {
  const v = useContext(Ctx);
  if (!v) throw new Error("useWorkspace outside WorkspaceProvider");
  return v;
}
