import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FolderKanban, Plus, Search } from "lucide-react";
import { api } from "@/lib/api";
import type { ProjectListItem } from "@shared/types";
import { useWorkspace } from "@/lib/workspace";
import { formatRelative } from "@/lib/format";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { EmptyState } from "@/components/EmptyState";

const ALL = "__all";

export default function ProjectsPage() {
  const [params, setParams] = useSearchParams();
  const { workspaceId, param, workspaces, current } = useWorkspace();
  const q = params.get("q") ?? "";
  const status = params.get("status") ?? "";
  const [addOpen, setAddOpen] = useState(false);
  useEffect(() => {
    document.title = "Projects · Strout Vault";
  }, []);
  const update = (patch: Record<string, string | null>) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) (v ? next.set(k, v) : next.delete(k));
    setParams(next, { replace: true });
  };
  const qs = new URLSearchParams();
  if (q) qs.set("q", q);
  if (status) qs.set("status", status);
  const list = useQuery({
    queryKey: ["projects", qs.toString(), param],
    queryFn: () => api<{ items: ProjectListItem[] }>(`/projects?${qs.toString()}${param}`),
    placeholderData: (prev) => prev,
  });
  const statuses = [...new Set((list.data?.items ?? []).map((p) => p.status).filter((s): s is string => !!s))].sort();

  return (
    <div className="mx-auto max-w-5xl px-4 py-6">
      <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Projects</h1>
          <p className="text-sm text-muted-foreground">{current ? `Projects in ${current.name}.` : "Projects across all workspaces."}</p>
        </div>
        <Button size="sm" onClick={() => setAddOpen(true)} data-testid="add-project">
          <Plus /> New project
        </Button>
      </div>
      <div className="mb-5 flex flex-wrap items-end gap-3" role="group" aria-label="Filters">
        <div className="relative min-w-[12rem] flex-1 max-w-xs">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input aria-label="Search projects" placeholder="Name or address" className="h-8 pl-8" value={q} onChange={(e) => update({ q: e.target.value || null })} />
        </div>
        <div className="space-y-1">
          <Label htmlFor="pr-status" className="text-xs text-muted-foreground">Status</Label>
          <Select value={status || ALL} onValueChange={(v) => update({ status: v === ALL ? null : v })}>
            <SelectTrigger id="pr-status" className="h-8 w-[9rem]"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>Any status</SelectItem>
              {[...new Set([...statuses, status].filter(Boolean))].map((s) => (
                <SelectItem key={s} value={s}>{s}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {list.isPending ? (
        <div className="grid gap-3 sm:grid-cols-2" aria-busy="true" aria-label="Loading projects">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-28" />
          ))}
        </div>
      ) : list.isError ? (
        <EmptyState title="Could not load projects">{(list.error as Error).message}</EmptyState>
      ) : list.data!.items.length === 0 ? (
        <EmptyState icon={<FolderKanban />} title="No projects" action={<Button onClick={() => setAddOpen(true)}><Plus /> New project</Button>}>
          {workspaceId || q || status ? "Nothing matches these filters." : "Create a project to group recordings, people and facts."}
        </EmptyState>
      ) : (
        <ul className="grid min-w-0 gap-3 sm:grid-cols-2" data-testid="projects-list">
          {list.data!.items.map((p) => (
            <li key={p.id} className="min-w-0">
              <Link to={`/projects/${p.id}`} className="flex h-full min-w-0 flex-col rounded-lg border bg-card p-4 hover:bg-accent/40" data-testid="project-card">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <h3 className="font-medium leading-snug">{p.name}</h3>
                    <p className="truncate text-xs text-muted-foreground">{p.workspaceName}{p.address ? ` · ${p.address}` : ""}</p>
                  </div>
                  {p.status && <Badge variant="outline" className="shrink-0">{p.status}</Badge>}
                </div>
                {p.parties.length > 0 && (
                  <p className="mt-2 line-clamp-2 break-words text-xs text-muted-foreground">{p.parties.map((x) => `${x.name} (${x.role})`).join(", ")}</p>
                )}
                <p className="mt-auto pt-3 text-xs text-muted-foreground tabular">
                  {p.interactionCount} recording{p.interactionCount === 1 ? "" : "s"} · {p.openFacts} open fact{p.openFacts === 1 ? "" : "s"}
                  {p.lastActivityAt && ` · ${formatRelative(p.lastActivityAt)}`}
                </p>
              </Link>
            </li>
          ))}
        </ul>
      )}
      <NewProjectDialog open={addOpen} onOpenChange={setAddOpen} defaultWorkspaceId={workspaceId || workspaces[0]?.id || ""} workspaces={workspaces} />
    </div>
  );
}

function NewProjectDialog({ open, onOpenChange, defaultWorkspaceId, workspaces }: { open: boolean; onOpenChange: (o: boolean) => void; defaultWorkspaceId: string; workspaces: Array<{ id: string; name: string }> }) {
  const qc = useQueryClient();
  const [workspaceId, setWorkspaceId] = useState(defaultWorkspaceId);
  const [name, setName] = useState("");
  const [address, setAddress] = useState("");
  const [status, setStatus] = useState("active");
  useEffect(() => setWorkspaceId(defaultWorkspaceId), [defaultWorkspaceId, open]);
  const create = useMutation({
    mutationFn: () => api<{ id: number }>("/projects", { method: "POST", json: { workspaceId, name: name.trim(), address: address.trim() || null, status: status.trim() || null } }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["projects"] });
      onOpenChange(false);
      setName("");
      setAddress("");
    },
  });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New project</DialogTitle>
          <DialogDescription>A project groups the recordings, people and facts for one job.</DialogDescription>
        </DialogHeader>
        <form
          className="grid gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (name.trim() && workspaceId) create.mutate();
          }}
        >
          <div className="space-y-1">
            <Label htmlFor="pj-ws">Workspace</Label>
            <Select value={workspaceId} onValueChange={setWorkspaceId}>
              <SelectTrigger id="pj-ws"><SelectValue /></SelectTrigger>
              <SelectContent>
                {workspaces.map((w) => (
                  <SelectItem key={w.id} value={w.id}>{w.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="pj-name">Name</Label>
            <Input id="pj-name" value={name} onChange={(e) => setName(e.target.value)} required autoFocus />
          </div>
          <div className="space-y-1">
            <Label htmlFor="pj-address">Address</Label>
            <Input id="pj-address" value={address} onChange={(e) => setAddress(e.target.value)} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="pj-status">Status</Label>
            <Input id="pj-status" value={status} onChange={(e) => setStatus(e.target.value)} placeholder="proposal, schematic, construction…" />
          </div>
          {create.isError && <p className="text-sm text-destructive">{(create.error as Error).message}</p>}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" disabled={!name.trim() || !workspaceId || create.isPending} data-testid="save-project">Create</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
