import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AtSign, Building2, Globe, Mail, MapPin, Pencil, Phone, Plus, User } from "lucide-react";
import { api } from "@/lib/api";
import type { PersonDetail } from "@shared/types";
import { ROLE_LABEL } from "@/lib/format";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { EmptyState } from "@/components/EmptyState";
import { InlineEdit } from "@/components/InlineEdit";
import { FactList } from "@/components/FactList";
import { RecordingList } from "@/components/RecordingList";
import { PartyPicker } from "@/components/PartyPicker";
import { useWorkspace } from "@/lib/workspace";

const ROLES = Object.keys(ROLE_LABEL);
const STATUSES = ["prospect", "active", "paused", "former"];

export default function PersonPage() {
  const { id } = useParams();
  const pid = Number(id);
  const qc = useQueryClient();
  const { workspaces } = useWorkspace();
  const party = useQuery({ queryKey: ["party", pid], queryFn: () => api<PersonDetail>(`/parties/${pid}`), enabled: pid > 0 });
  const [editing, setEditing] = useState(false);
  const [addingRole, setAddingRole] = useState(false);
  const [addingOrg, setAddingOrg] = useState(false);

  useEffect(() => {
    document.title = `${party.data?.name ?? "Person"} · Strout Vault`;
  }, [party.data?.name]);

  const refresh = (data: PersonDetail) => {
    qc.setQueryData(["party", pid], data);
    void qc.invalidateQueries({ queryKey: ["people"] });
  };
  const patch = useMutation({
    mutationFn: (body: Record<string, unknown>) => api<PersonDetail>(`/parties/${pid}`, { method: "PATCH", json: body }),
    onSuccess: refresh,
  });
  const addRole = useMutation({
    mutationFn: (body: { workspaceId: string; role: string; status: string; market: string | null; detail: string | null }) => api<PersonDetail>(`/parties/${pid}/roles`, { method: "POST", json: body }),
    onSuccess: (d) => {
      refresh(d);
      setAddingRole(false);
    },
  });
  const roleStatus = useMutation({
    mutationFn: ({ roleId, status }: { roleId: number; status: string }) => api<PersonDetail>(`/roles/${roleId}`, { method: "PATCH", json: { status } }),
    onSuccess: refresh,
  });
  const addOrg = useMutation({
    mutationFn: (body: { orgId: number; title: string | null }) => api<PersonDetail>(`/parties/${pid}/affiliations`, { method: "POST", json: body }),
    onSuccess: (d) => {
      refresh(d);
      setAddingOrg(false);
    },
  });

  if (party.isError) {
    return (
      <div className="mx-auto max-w-5xl px-4 py-10">
        <EmptyState title="Person not found" action={<Button asChild variant="outline"><Link to="/people">All people</Link></Button>} />
      </div>
    );
  }
  const p = party.data;
  if (!p) {
    return (
      <div className="mx-auto max-w-5xl px-4 py-6 space-y-3">
        <Skeleton className="h-7 w-56" />
        <Skeleton className="h-4 w-80" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }
  const openFacts = p.facts.filter((f) => f.status === "open");

  return (
    <div className="mx-auto max-w-5xl px-4 py-6">
      <div className="flex items-start gap-3">
        <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground">
          {p.kind === "org" ? <Building2 className="h-5 w-5" /> : <User className="h-5 w-5" />}
        </div>
        <div className="min-w-0 flex-1">
          <InlineEdit as="h1" label="Name" value={p.name} className="text-xl font-semibold tracking-tight" inputClassName="text-xl font-semibold" testId="person-name" onSave={(name) => patch.mutateAsync({ name })} />
          <p className="text-sm text-muted-foreground">{p.kind === "org" ? "Company" : "Person"}{p.location ? ` · ${p.location}` : ""}</p>
        </div>
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
        <div className="space-y-6">
          {/* Contact */}
          <section className="rounded-lg border p-4">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-medium">Contact</h2>
              {!editing && (
                <Button variant="ghost" size="sm" className="h-7" onClick={() => setEditing(true)} data-testid="edit-contact">
                  <Pencil className="h-3.5 w-3.5" /> Edit
                </Button>
              )}
            </div>
            {editing ? (
              <ContactForm
                p={p}
                saving={patch.isPending}
                onCancel={() => setEditing(false)}
                onSave={async (body) => {
                  await patch.mutateAsync(body);
                  setEditing(false);
                }}
              />
            ) : (
              <dl className="mt-2 space-y-1.5 text-sm">
                {p.emails.map((e) => (
                  <div key={e} className="flex items-center gap-2"><Mail className="h-4 w-4 text-muted-foreground" /><a className="truncate hover:underline" href={`mailto:${e}`}>{e}</a></div>
                ))}
                {p.phones.map((ph) => (
                  <div key={ph} className="flex items-center gap-2"><Phone className="h-4 w-4 text-muted-foreground" /><a className="hover:underline tabular" href={`tel:${ph}`}>{ph}</a></div>
                ))}
                {(p.handles ?? []).map((h) => {
                  const [platform, user] = h.split(":");
                  const href = platform === "tiktok" ? `https://www.tiktok.com/@${user}` : `https://www.instagram.com/${user}/`;
                  return (
                    <div key={h} className="flex items-center gap-2">
                      <AtSign className="h-4 w-4 text-muted-foreground" />
                      <a className="truncate hover:underline" href={href} target="_blank" rel="noreferrer">
                        {user}
                      </a>
                      <span className="text-xs text-muted-foreground">{platform === "tiktok" ? "TikTok" : "Instagram"}</span>
                    </div>
                  );
                })}
                {p.location && <div className="flex items-center gap-2"><MapPin className="h-4 w-4 text-muted-foreground" />{p.location}</div>}
                {p.website && <div className="flex items-center gap-2"><Globe className="h-4 w-4 text-muted-foreground" /><a className="truncate hover:underline" href={p.website} target="_blank" rel="noreferrer">{p.website.replace(/^https?:\/\//, "")}</a></div>}
                {p.notes && <p className="whitespace-pre-wrap pt-1 text-muted-foreground">{p.notes}</p>}
                {!p.emails.length && !p.phones.length && !(p.handles ?? []).length && !p.location && !p.website && !p.notes && <p className="text-muted-foreground">No contact details yet.</p>}
              </dl>
            )}
          </section>

          {/* Roles */}
          <section className="rounded-lg border p-4">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-medium">Roles</h2>
              <Button variant="ghost" size="sm" className="h-7" onClick={() => setAddingRole((v) => !v)} data-testid="add-role">
                <Plus className="h-3.5 w-3.5" /> Add role
              </Button>
            </div>
            {p.roles.length === 0 && !addingRole && <p className="mt-2 text-sm text-muted-foreground">No role in any workspace yet.</p>}
            <ul className="mt-2 space-y-2">
              {p.roles.map((r) => (
                <li key={r.id} className="flex flex-wrap items-center gap-2 text-sm" data-testid="role-row">
                  <span className="font-medium">{r.workspaceName}</span>
                  <Badge variant="muted">{r.role}</Badge>
                  {r.market && <span className="text-muted-foreground">{r.market}</span>}
                  {r.detail && <span className="text-xs text-muted-foreground">— {r.detail}</span>}
                  <Select value={r.status} onValueChange={(status) => roleStatus.mutate({ roleId: r.id, status })}>
                    <SelectTrigger className="ml-auto h-7 w-[7.5rem] text-xs" aria-label={`Status of ${r.workspaceName} ${r.role} role`}><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {STATUSES.map((s) => (
                        <SelectItem key={s} value={s}>{s}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </li>
              ))}
            </ul>
            {addingRole && (
              <RoleForm
                workspaces={workspaces}
                saving={addRole.isPending}
                onCancel={() => setAddingRole(false)}
                onSave={(body) => addRole.mutate(body)}
              />
            )}
          </section>

          {/* Affiliations */}
          <section className="rounded-lg border p-4">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-medium">{p.kind === "org" ? "People" : "Organizations"}</h2>
              <Button variant="ghost" size="sm" className="h-7" onClick={() => setAddingOrg((v) => !v)}>
                <Plus className="h-3.5 w-3.5" /> {p.kind === "org" ? "Add person" : "Add organization"}
              </Button>
            </div>
            {p.affiliations.length === 0 && !addingOrg && <p className="mt-2 text-sm text-muted-foreground">None linked yet.</p>}
            <ul className="mt-2 flex flex-wrap gap-2">
              {p.affiliations.map((a) => (
                <li key={a.id}>
                  <Link to={`/p/${a.other.id}`} className="inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-sm hover:bg-accent">
                    {a.other.kind === "org" ? <Building2 className="h-3.5 w-3.5 text-muted-foreground" /> : <User className="h-3.5 w-3.5 text-muted-foreground" />}
                    {a.other.name}
                    {a.title && <span className="text-xs text-muted-foreground">· {a.title}</span>}
                  </Link>
                </li>
              ))}
            </ul>
            {addingOrg && <AffiliationForm kind={p.kind === "org" ? "person" : "org"} saving={addOrg.isPending} onCancel={() => setAddingOrg(false)} onSave={(b) => addOrg.mutate(b)} />}
          </section>

          {/* Projects */}
          <section className="rounded-lg border p-4">
            <h2 className="text-sm font-medium">Projects</h2>
            {p.projects.length === 0 ? (
              <p className="mt-2 text-sm text-muted-foreground">Not on any project yet.</p>
            ) : (
              <ul className="mt-2 space-y-1">
                {p.projects.map((pr) => (
                  <li key={pr.id}>
                    <Link to={`/projects/${pr.id}`} className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-accent/50">
                      <span className="font-medium">{pr.name}</span>
                      <Badge variant="muted">{pr.role}</Badge>
                      <span className="ml-auto text-xs text-muted-foreground">{pr.workspaceName}{pr.status ? ` · ${pr.status}` : ""}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>

        <div className="space-y-6 min-w-0">
          <section>
            <h2 className="mb-2 text-sm font-medium">Open facts <span className="text-muted-foreground tabular">({openFacts.length})</span></h2>
            <FactList facts={openFacts} emptyText="No open commitments, follow-ups or decisions involve them." />
          </section>
          <section>
            <h2 className="mb-2 text-sm font-medium">Timeline <span className="text-muted-foreground tabular">({p.interactions.length})</span></h2>
            <RecordingList items={p.interactions} emptyText="Not tagged on any recording yet." />
          </section>
        </div>
      </div>
    </div>
  );
}

function ContactForm({ p, saving, onCancel, onSave }: { p: PersonDetail; saving: boolean; onCancel: () => void; onSave: (body: Record<string, unknown>) => Promise<unknown> }) {
  const [emails, setEmails] = useState(p.emails.join(", "));
  const [phones, setPhones] = useState(p.phones.join(", "));
  const handlesOf = (platform: string) =>
    (p.handles ?? [])
      .filter((h) => h.startsWith(`${platform}:`))
      .map((h) => `@${h.slice(platform.length + 1)}`)
      .join(", ");
  const [tiktok, setTiktok] = useState(handlesOf("tiktok"));
  const [instagram, setInstagram] = useState(handlesOf("instagram"));
  const [location, setLocation] = useState(p.location ?? "");
  const [website, setWebsite] = useState(p.website ?? "");
  const [notes, setNotes] = useState(p.notes ?? "");
  const split = (s: string) => s.split(/[,\n;]+/).map((x) => x.trim()).filter(Boolean);
  return (
    <form
      className="mt-3 space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        const handles = [...split(tiktok).map((u) => `tiktok:${u}`), ...split(instagram).map((u) => `instagram:${u}`)];
        // Only sent when there are handles to keep or remove, so editing contacts works before migration 0011 too.
        const handleChange = handles.length || (p.handles ?? []).length ? { handles } : {};
        void onSave({ emails: split(emails), phones: split(phones), ...handleChange, location: location.trim() || null, website: website.trim() || null, notes: notes.trim() || null });
      }}
    >
      <div className="space-y-1">
        <Label htmlFor="c-emails">Emails</Label>
        <Input id="c-emails" value={emails} onChange={(e) => setEmails(e.target.value)} placeholder="comma separated" />
      </div>
      <div className="space-y-1">
        <Label htmlFor="c-phones">Phones</Label>
        <Input id="c-phones" value={phones} onChange={(e) => setPhones(e.target.value)} placeholder="comma separated" />
      </div>
      <div className="grid grid-cols-2 gap-2">
        <div className="space-y-1">
          <Label htmlFor="c-tiktok">TikTok</Label>
          <Input id="c-tiktok" value={tiktok} onChange={(e) => setTiktok(e.target.value)} placeholder="@username" />
        </div>
        <div className="space-y-1">
          <Label htmlFor="c-instagram">Instagram</Label>
          <Input id="c-instagram" value={instagram} onChange={(e) => setInstagram(e.target.value)} placeholder="@username" />
        </div>
      </div>
      <div className="space-y-1">
        <Label htmlFor="c-location">Location</Label>
        <Input id="c-location" value={location} onChange={(e) => setLocation(e.target.value)} />
      </div>
      <div className="space-y-1">
        <Label htmlFor="c-website">Website</Label>
        <Input id="c-website" value={website} onChange={(e) => setWebsite(e.target.value)} placeholder="https://" />
      </div>
      <div className="space-y-1">
        <Label htmlFor="c-notes">Notes</Label>
        <Textarea id="c-notes" value={notes} onChange={(e) => setNotes(e.target.value)} rows={3} />
      </div>
      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" size="sm" onClick={onCancel}>Cancel</Button>
        <Button type="submit" size="sm" disabled={saving} data-testid="save-contact">Save</Button>
      </div>
    </form>
  );
}

function RoleForm({ workspaces, saving, onCancel, onSave }: { workspaces: Array<{ id: string; name: string }>; saving: boolean; onCancel: () => void; onSave: (b: { workspaceId: string; role: string; status: string; market: string | null; detail: string | null }) => void }) {
  const [workspaceId, setWorkspaceId] = useState(workspaces[0]?.id ?? "");
  const [role, setRole] = useState("client");
  const [status, setStatus] = useState("active");
  const [market, setMarket] = useState("");
  const [detail, setDetail] = useState("");
  return (
    <form
      className="mt-3 grid gap-2 sm:grid-cols-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (workspaceId) onSave({ workspaceId, role, status, market: market.trim() || null, detail: detail.trim() || null });
      }}
    >
      <div className="space-y-1">
        <Label htmlFor="r-ws">Workspace</Label>
        <Select value={workspaceId} onValueChange={setWorkspaceId}>
          <SelectTrigger id="r-ws" className="h-8"><SelectValue /></SelectTrigger>
          <SelectContent>
            {workspaces.map((w) => (
              <SelectItem key={w.id} value={w.id}>{w.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="space-y-1">
        <Label htmlFor="r-role">Role</Label>
        <Select value={role} onValueChange={setRole}>
          <SelectTrigger id="r-role" className="h-8"><SelectValue /></SelectTrigger>
          <SelectContent>
            {ROLES.map((r) => (
              <SelectItem key={r} value={r}>{r}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="space-y-1">
        <Label htmlFor="r-status">Status</Label>
        <Select value={status} onValueChange={setStatus}>
          <SelectTrigger id="r-status" className="h-8"><SelectValue /></SelectTrigger>
          <SelectContent>
            {STATUSES.map((s) => (
              <SelectItem key={s} value={s}>{s}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="space-y-1">
        <Label htmlFor="r-market">Market</Label>
        <Input id="r-market" className="h-8" value={market} onChange={(e) => setMarket(e.target.value)} placeholder="Houston (Conroe)" />
      </div>
      <div className="space-y-1 sm:col-span-2">
        <Label htmlFor="r-detail">Detail</Label>
        <Input id="r-detail" className="h-8" value={detail} onChange={(e) => setDetail(e.target.value)} placeholder="camera operator, drone" />
      </div>
      <div className="flex justify-end gap-2 sm:col-span-2">
        <Button type="button" variant="outline" size="sm" onClick={onCancel}>Cancel</Button>
        <Button type="submit" size="sm" disabled={saving || !workspaceId} data-testid="save-role">Save role</Button>
      </div>
    </form>
  );
}

function AffiliationForm({ kind, saving, onCancel, onSave }: { kind: "person" | "org"; saving: boolean; onCancel: () => void; onSave: (b: { orgId: number; title: string | null }) => void }) {
  const [other, setOther] = useState<Array<{ id: number; name: string }>>([]);
  const [title, setTitle] = useState("");
  return (
    <form
      className="mt-3 grid gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (other[0]) onSave({ orgId: other[0].id, title: title.trim() || null });
      }}
    >
      <PartyPicker kind={kind} multiple={false} value={other} onChange={setOther} placeholder={kind === "org" ? "Find an organization…" : "Find a person…"} />
      <Input className="h-8" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Title (optional)" aria-label="Title" />
      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" size="sm" onClick={onCancel}>Cancel</Button>
        <Button type="submit" size="sm" disabled={saving || !other[0]}>Link</Button>
      </div>
    </form>
  );
}
