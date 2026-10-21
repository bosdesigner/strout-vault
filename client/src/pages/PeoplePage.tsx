import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Building2, Plus, Search, User, Users, X } from "lucide-react";
import { api } from "@/lib/api";
import type { PersonListItem } from "@shared/types";
import { useWorkspace } from "@/lib/workspace";
import { formatRelative, ROLE_LABEL } from "@/lib/format";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { EmptyState } from "@/components/EmptyState";
import { RoleChips } from "@/components/RoleChips";

const ALL = "__all";
const ROLES = Object.keys(ROLE_LABEL);
const STATUSES = ["prospect", "active", "paused", "former"];

export default function PeoplePage() {
  const [params, setParams] = useSearchParams();
  const { workspaceId, param, workspaces, current } = useWorkspace();
  const q = params.get("q") ?? "";
  const kind = params.get("kind") ?? "";
  const role = params.get("role") ?? "";
  const status = params.get("status") ?? "";
  const market = params.get("market") ?? "";
  const [addOpen, setAddOpen] = useState(false);

  useEffect(() => {
    document.title = "People · Strout Vault";
  }, []);

  const update = (patch: Record<string, string | null>) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) (v ? next.set(k, v) : next.delete(k));
    setParams(next, { replace: true });
  };

  const qs = new URLSearchParams();
  if (q) qs.set("q", q);
  if (kind) qs.set("kind", kind);
  if (role) qs.set("role", role);
  if (status) qs.set("status", status);
  if (market) qs.set("market", market);
  const list = useQuery({
    queryKey: ["people", qs.toString(), param],
    queryFn: () => api<{ items: PersonListItem[] }>(`/parties?${qs.toString()}${param}`),
    placeholderData: (prev) => prev,
  });
  const markets = useQuery({
    queryKey: ["markets", param],
    queryFn: () => api<{ items: string[] }>(`/parties/markets?${param.slice(1)}`),
    staleTime: 5 * 60_000,
  });
  const active = !!(q || kind || role || status || market);

  return (
    <div className="mx-auto max-w-5xl px-4 py-6">
      <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">People & companies</h1>
          <p className="text-sm text-muted-foreground">
            {current ? `Everyone with a role in ${current.name}.` : "Everyone across all workspaces, with their role in each."}
          </p>
        </div>
        <Button size="sm" onClick={() => setAddOpen(true)} data-testid="add-person">
          <Plus /> Add person
        </Button>
      </div>

      <div className="mb-5 flex flex-wrap items-end gap-3" role="group" aria-label="Filters">
        <div className="relative min-w-[12rem] flex-1 max-w-xs">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input aria-label="Search people" placeholder="Name or email" className="h-8 pl-8" value={q} onChange={(e) => update({ q: e.target.value || null })} />
        </div>
        <div className="space-y-1">
          <Label htmlFor="p-kind" className="text-xs text-muted-foreground">Type</Label>
          <Select value={kind || ALL} onValueChange={(v) => update({ kind: v === ALL ? null : v })}>
            <SelectTrigger id="p-kind" className="h-8 w-[8.5rem]"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>Everyone</SelectItem>
              <SelectItem value="person">People</SelectItem>
              <SelectItem value="org">Companies</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <Label htmlFor="p-role" className="text-xs text-muted-foreground">Role</Label>
          <Select value={role || ALL} onValueChange={(v) => update({ role: v === ALL ? null : v })}>
            <SelectTrigger id="p-role" className="h-8 w-[8.5rem]"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>Any role</SelectItem>
              {ROLES.map((r) => (
                <SelectItem key={r} value={r}>{r}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <Label htmlFor="p-status" className="text-xs text-muted-foreground">Status</Label>
          <Select value={status || ALL} onValueChange={(v) => update({ status: v === ALL ? null : v })}>
            <SelectTrigger id="p-status" className="h-8 w-[8.5rem]"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>Any status</SelectItem>
              {STATUSES.map((s) => (
                <SelectItem key={s} value={s}>{s}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <Label htmlFor="p-market" className="text-xs text-muted-foreground">Market</Label>
          <Select value={market || ALL} onValueChange={(v) => update({ market: v === ALL ? null : v })}>
            <SelectTrigger id="p-market" className="h-8 w-[10rem]"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>Any market</SelectItem>
              {(markets.data?.items ?? []).map((m) => (
                <SelectItem key={m} value={m}>{m}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        {active && (
          <Button variant="ghost" size="sm" className="h-8 text-muted-foreground" onClick={() => setParams(new URLSearchParams(), { replace: true })}>
            <X className="h-3.5 w-3.5" /> Clear
          </Button>
        )}
      </div>

      {list.isPending ? (
        <ul className="divide-y rounded-lg border" aria-busy="true" aria-label="Loading people">
          {Array.from({ length: 8 }).map((_, i) => (
            <li key={i} className="flex items-center gap-3 px-3 py-3">
              <Skeleton className="h-8 w-8 rounded-full" />
              <div className="flex-1 space-y-1.5">
                <Skeleton className="h-4 w-40" />
                <Skeleton className="h-3 w-64" />
              </div>
            </li>
          ))}
        </ul>
      ) : list.isError ? (
        <EmptyState title="Could not load people">{(list.error as Error).message}</EmptyState>
      ) : list.data!.items.length === 0 ? (
        <EmptyState icon={<Users />} title={active || workspaceId ? "No one matches" : "No people yet"} action={<Button onClick={() => setAddOpen(true)}><Plus /> Add person</Button>}>
          {active || workspaceId ? "Try clearing a filter or switching workspace." : "People appear here as they are tagged on recordings, or add one by hand."}
        </EmptyState>
      ) : (
        <ul className="divide-y rounded-lg border" data-testid="people-list">
          {list.data!.items.map((p) => (
            <li key={p.id} data-testid="person-row" data-id={p.id}>
              <Link to={`/p/${p.id}`} className="flex items-start gap-3 px-3 py-3 hover:bg-accent/50">
                <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground">
                  {p.kind === "org" ? <Building2 className="h-4 w-4" /> : <User className="h-4 w-4" />}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex flex-wrap items-baseline gap-x-2">
                    <span className="font-medium">{p.name}</span>
                    {p.orgs.map((o) => (
                      <span key={o.id} className="text-xs text-muted-foreground">{o.name}</span>
                    ))}
                    {p.location && <span className="text-xs text-muted-foreground">· {p.location}</span>}
                  </span>
                  <RoleChips roles={workspaceId ? p.roles.filter((r) => r.workspaceId === workspaceId) : p.roles} className="mt-1" />
                </span>
                <span className="hidden shrink-0 text-right text-xs text-muted-foreground tabular sm:block">
                  {p.interactionCount} recording{p.interactionCount === 1 ? "" : "s"}
                  {p.lastSeenAt && <span className="block">{formatRelative(p.lastSeenAt)}</span>}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
      <AddPersonDialog open={addOpen} onOpenChange={setAddOpen} defaultWorkspaceId={workspaceId} workspaces={workspaces} />
    </div>
  );
}

function AddPersonDialog({ open, onOpenChange, defaultWorkspaceId, workspaces }: { open: boolean; onOpenChange: (o: boolean) => void; defaultWorkspaceId: string; workspaces: Array<{ id: string; name: string }> }) {
  const qc = useQueryClient();
  const [kind, setKind] = useState<"person" | "org">("person");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [location, setLocation] = useState("");
  const [workspaceId, setWorkspaceId] = useState(defaultWorkspaceId);
  const [role, setRole] = useState("client");
  const [market, setMarket] = useState("");
  useEffect(() => setWorkspaceId(defaultWorkspaceId), [defaultWorkspaceId, open]);

  const create = useMutation({
    mutationFn: () =>
      api<{ id: number }>("/parties", {
        method: "POST",
        json: {
          kind,
          name: name.trim(),
          emails: email.trim() ? [email.trim()] : [],
          phones: phone.trim() ? [phone.trim()] : [],
          location: location.trim() || null,
          role: workspaceId ? { workspaceId, role, market: market.trim() || null } : undefined,
        },
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["people"] });
      void qc.invalidateQueries({ queryKey: ["parties"] });
      onOpenChange(false);
      setName("");
      setEmail("");
      setPhone("");
      setLocation("");
      setMarket("");
    },
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add a person or company</DialogTitle>
          <DialogDescription>Give them a role in a workspace so they show up in the right lists.</DialogDescription>
        </DialogHeader>
        <form
          className="grid gap-3 sm:grid-cols-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (name.trim()) create.mutate();
          }}
        >
          <div className="space-y-1">
            <Label htmlFor="np-kind">Type</Label>
            <Select value={kind} onValueChange={(v) => setKind(v as "person" | "org")}>
              <SelectTrigger id="np-kind"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="person">Person</SelectItem>
                <SelectItem value="org">Company</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="np-name">Name</Label>
            <Input id="np-name" value={name} onChange={(e) => setName(e.target.value)} required autoFocus />
          </div>
          <div className="space-y-1">
            <Label htmlFor="np-email">Email</Label>
            <Input id="np-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="np-phone">Phone</Label>
            <Input id="np-phone" type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} />
          </div>
          <div className="space-y-1 sm:col-span-2">
            <Label htmlFor="np-location">Location</Label>
            <Input id="np-location" value={location} onChange={(e) => setLocation(e.target.value)} placeholder="Houston, TX" />
          </div>
          <div className="space-y-1">
            <Label htmlFor="np-ws">Workspace</Label>
            <Select value={workspaceId || ALL} onValueChange={(v) => setWorkspaceId(v === ALL ? "" : v)}>
              <SelectTrigger id="np-ws"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>No role yet</SelectItem>
                {workspaces.map((w) => (
                  <SelectItem key={w.id} value={w.id}>{w.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="np-role">Role</Label>
            <Select value={role} onValueChange={setRole} disabled={!workspaceId}>
              <SelectTrigger id="np-role"><SelectValue /></SelectTrigger>
              <SelectContent>
                {ROLES.map((r) => (
                  <SelectItem key={r} value={r}>{r}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1 sm:col-span-2">
            <Label htmlFor="np-market">Market</Label>
            <Input id="np-market" value={market} onChange={(e) => setMarket(e.target.value)} placeholder="Houston (Conroe)" disabled={!workspaceId} />
          </div>
          {create.isError && <p className="text-sm text-destructive sm:col-span-2">{(create.error as Error).message}</p>}
          <DialogFooter className="sm:col-span-2">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" disabled={!name.trim() || create.isPending} data-testid="save-person">Add</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
