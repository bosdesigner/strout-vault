import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Building2, MapPin, Pencil, Plus, User } from "lucide-react";
import { api } from "@/lib/api";
import type { ProjectDetail } from "@shared/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/EmptyState";
import { InlineEdit } from "@/components/InlineEdit";
import { FactList } from "@/components/FactList";
import { RecordingList } from "@/components/RecordingList";
import { RoleChips } from "@/components/RoleChips";
import { PartyPicker } from "@/components/PartyPicker";

export default function ProjectPage() {
  const { id } = useParams();
  const pid = Number(id);
  const qc = useQueryClient();
  const project = useQuery({ queryKey: ["project", pid], queryFn: () => api<ProjectDetail>(`/projects/${pid}`), enabled: pid > 0 });
  const [editing, setEditing] = useState(false);
  const [adding, setAdding] = useState(false);
  const [party, setParty] = useState<Array<{ id: number; name: string }>>([]);
  const [role, setRole] = useState("client");

  useEffect(() => {
    document.title = `${project.data?.name ?? "Project"} · Strout Vault`;
  }, [project.data?.name]);

  const refresh = (d: ProjectDetail) => {
    qc.setQueryData(["project", pid], d);
    void qc.invalidateQueries({ queryKey: ["projects"] });
  };
  const patch = useMutation({ mutationFn: (body: Record<string, unknown>) => api<ProjectDetail>(`/projects/${pid}`, { method: "PATCH", json: body }), onSuccess: refresh });
  const addParty = useMutation({
    mutationFn: (body: { partyId: number; role: string }) => api<ProjectDetail>(`/projects/${pid}/parties`, { method: "POST", json: body }),
    onSuccess: (d) => {
      refresh(d);
      setAdding(false);
      setParty([]);
    },
  });

  if (project.isError) {
    return (
      <div className="mx-auto max-w-5xl px-4 py-10">
        <EmptyState title="Project not found" action={<Button asChild variant="outline"><Link to="/projects">All projects</Link></Button>} />
      </div>
    );
  }
  const p = project.data;
  if (!p) {
    return (
      <div className="mx-auto max-w-5xl px-4 py-6 space-y-3">
        <Skeleton className="h-7 w-72" />
        <Skeleton className="h-4 w-56" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-5xl px-4 py-6">
      <div className="min-w-0">
        <InlineEdit as="h1" label="Project name" value={p.name} className="text-xl font-semibold tracking-tight" inputClassName="text-xl font-semibold" testId="project-name" onSave={(name) => patch.mutateAsync({ name })} />
        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground">
          <span>{p.workspaceName}</span>
          {p.status && <Badge variant="outline">{p.status}</Badge>}
          {p.address && <span className="inline-flex items-center gap-1"><MapPin className="h-3.5 w-3.5" />{p.address}</span>}
          <Button variant="ghost" size="sm" className="h-7" onClick={() => setEditing((v) => !v)} data-testid="edit-project">
            <Pencil className="h-3.5 w-3.5" /> Edit
          </Button>
        </div>
        {editing && (
          <ProjectForm
            p={p}
            saving={patch.isPending}
            onCancel={() => setEditing(false)}
            onSave={async (body) => {
              await patch.mutateAsync(body);
              setEditing(false);
            }}
          />
        )}
        {p.notes && !editing && <p className="mt-2 whitespace-pre-wrap text-sm text-muted-foreground">{p.notes}</p>}
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
        <section className="rounded-lg border p-4">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-medium">People <span className="text-muted-foreground tabular">({p.parties.length})</span></h2>
            <Button variant="ghost" size="sm" className="h-7" onClick={() => setAdding((v) => !v)} data-testid="add-project-party">
              <Plus className="h-3.5 w-3.5" /> Add
            </Button>
          </div>
          {p.parties.length === 0 && !adding && <p className="mt-2 text-sm text-muted-foreground">No one on this project yet.</p>}
          <ul className="mt-2 divide-y">
            {p.parties.map((x) => (
              <li key={`${x.id}-${x.projectRole}`} className="flex flex-wrap items-center gap-2 py-2 text-sm">
                {x.kind === "org" ? <Building2 className="h-4 w-4 text-muted-foreground" /> : <User className="h-4 w-4 text-muted-foreground" />}
                <Link to={`/p/${x.id}`} className="font-medium hover:underline underline-offset-2">{x.name}</Link>
                <Badge variant="secondary">{x.projectRole}</Badge>
                <RoleChips roles={x.roles.filter((r) => r.workspaceId === p.workspaceId)} hideWorkspace className="w-full sm:ml-auto sm:w-auto" />
              </li>
            ))}
          </ul>
          {adding && (
            <form
              className="mt-3 grid gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                if (party[0] && role.trim()) addParty.mutate({ partyId: party[0].id, role: role.trim() });
              }}
            >
              <PartyPicker multiple={false} value={party} onChange={setParty} placeholder="Find a person or company…" />
              <div className="flex gap-2">
                <Input className="h-8" value={role} onChange={(e) => setRole(e.target.value)} placeholder="role on the project (client, gc, vendor…)" aria-label="Role on project" />
                <Button type="submit" size="sm" disabled={!party[0] || addParty.isPending} data-testid="save-project-party">Add</Button>
              </div>
            </form>
          )}
        </section>
        <div className="space-y-6 min-w-0">
          <section>
            <h2 className="mb-2 text-sm font-medium">Recordings <span className="text-muted-foreground tabular">({p.interactions.length})</span></h2>
            <RecordingList items={p.interactions} emptyText="No recordings linked yet. Link one from its People tab." />
          </section>
          <section>
            <h2 className="mb-2 text-sm font-medium">Facts <span className="text-muted-foreground tabular">({p.facts.length})</span></h2>
            <FactList facts={p.facts} emptyText="No commitments, decisions or prices on this project yet." />
          </section>
        </div>
      </div>
    </div>
  );
}

function ProjectForm({ p, saving, onCancel, onSave }: { p: ProjectDetail; saving: boolean; onCancel: () => void; onSave: (b: Record<string, unknown>) => Promise<unknown> }) {
  const [address, setAddress] = useState(p.address ?? "");
  const [status, setStatus] = useState(p.status ?? "");
  const [notes, setNotes] = useState(p.notes ?? "");
  return (
    <form
      className="mt-3 grid max-w-xl gap-3 rounded-lg border p-4"
      onSubmit={(e) => {
        e.preventDefault();
        void onSave({ address: address.trim() || null, status: status.trim() || null, notes: notes.trim() || null });
      }}
    >
      <div className="space-y-1">
        <Label htmlFor="pf-address">Address</Label>
        <Input id="pf-address" value={address} onChange={(e) => setAddress(e.target.value)} />
      </div>
      <div className="space-y-1">
        <Label htmlFor="pf-status">Status</Label>
        <Input id="pf-status" value={status} onChange={(e) => setStatus(e.target.value)} />
      </div>
      <div className="space-y-1">
        <Label htmlFor="pf-notes">Notes</Label>
        <Textarea id="pf-notes" value={notes} onChange={(e) => setNotes(e.target.value)} rows={3} />
      </div>
      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" size="sm" onClick={onCancel}>Cancel</Button>
        <Button type="submit" size="sm" disabled={saving} data-testid="save-project-fields">Save</Button>
      </div>
    </form>
  );
}
