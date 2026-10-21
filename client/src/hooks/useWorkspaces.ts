import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import type { WorkspaceRef } from "@shared/types";

export function useWorkspaces() {
  return useQuery({
    queryKey: ["workspaces"],
    queryFn: async () => (await api<{ items: WorkspaceRef[] }>("/workspaces")).items,
    staleTime: 10 * 60_000,
  });
}
