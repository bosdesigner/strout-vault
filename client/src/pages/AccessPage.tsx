import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { KeyRound, Mail, Phone, Plus, Send } from "lucide-react";
import { api, ApiError } from "@/lib/api";
import { useWorkspace } from "@/lib/workspace";
import { formatDate, formatDuration, formatRelative } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { PartyPicker } from "@/components/PartyPicker";
import { StatusChip } from "@/components/StatusChip";

interface Membership {
  id: number;
  email: string;
  role: string;
  workspaceId: string | null;
  workspaceName: string | null;
  partyId: number | null;
  partyName: string | null;
  status: "invited" | "active" | "disabled" | string;
  displayName: string | null;
  createdAt: string | null;
  lastLoginAt: string | null;
  trackedNumbers: number;
}
interface TrackedNumber {
  id: number;
  workspaceId: string | null;
  workspaceName: string | null;
  membershipId: number | null;
  membershipEmail: string | null;
  partyId: number | null;
  partyName: string | null;
  phoneNumber: string;
  forwardTo: string;
  recordingNotice: string | null;
  status: "active" | "paused" | "released" | string;
  callCount: number;
  lastCallAt: string | null;
}
interface Call {
  id: number;
  from: string | null;
  to: string | null;
  startedAt: string | null;
  durationSec: number | null;
  status: string | null;
  recordingStatus: string | null;
  recordingError: string | null;
  interactionId: number | null;
  interactionTitle: string | null;
  pipelineStatus: string | null;
  caller: { id: number; name: string } | null;
  trackedNumber: string | null;
  owner: { id: number; name: string } | null;
}

/** Owner only: contractor logins and the tracked phone numbers that record their calls. */
export default function AccessPage() {
  const qc = useQueryClient();
  const { workspaces } = useWorkspace();
  useEffect(() => {
    document.title = "Access & numbers · Strout Vault";
  }, []);
  const memberships = useQuery({ queryKey: ["memberships"], queryFn: () => api<{ items: Membership[] }>("/memberships") });
  const numbers = useQuery({ queryKey: ["tracked-numbers"], queryFn: () => api<{ items: TrackedNumber[]; webhookUrl: string | null; twilioConfigured: boolean }>("/tracked-numbers") });
  const calls = useQuery({ queryKey: ["calls"], queryFn: () => api<{ items: Call[] }>("/calls?limit=30"), refetchInterval: 30_000 });

  const setStatus = useMutation({
    mutationFn: ({ id, status }: { id: number; status: string }) => api<Membership>(`/memberships/${id}`, { method: "PATCH", json: { status } }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["memberships"] }),
  });
  const sendLink = useMutation({
    mutationFn: (id: number) => api(`/memberships/${id}/send-link`, { method: "POST" }),
  });
  const numberStatus = useMutation({
    mutationFn: ({ id, status }: { id: number; status: string }) => api<TrackedNumber>(`/tracked-numbers/${id}`, { method: "PATCH", json: { status } }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["tracked-numbers"] }),
  });

  return (
    <div className="mx-auto max-w-5xl px-4 py-6 space-y-10">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Access & numbers</h1>
        <p className="text-sm text-muted-foreground">Contractor logins (sign-in links by email) and the forwarding numbers that record their calls.</p>
      </div>

      {/* Logins */}
      <section>
        <div className="mb-3 flex items-center justify-between">
          <h2 className="flex items-center gap-2 text-sm font-medium"><KeyRound className="h-4 w-4 text-muted-foreground" /> Contractor logins</h2>
        </div>
        {memberships.isPending ? (
          <Skeleton className="h-32" />
        ) : (
          <ul className="divide-y rounded-lg border" data-testid="memberships">
            {memberships.data!.items.length === 0 && <li className="px-3 py-6 text-center text-sm text-muted-foreground">No contractor logins yet.</li>}
            {memberships.data!.items.map((m) => (
              <li key={m.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2.5 text-sm" data-testid="membership-row" data-status={m.status}>
                <span className="min-w-0 flex-1">
                  <span className="font-medium">{m.displayName || m.email}</span>
                  {m.displayName && <span className="ml-2 text-muted-foreground">{m.email}</span>}
                  <span className="block text-xs text-muted-foreground">
                    {m.workspaceName ?? "All workspaces"}
                    {m.partyName && <> · as <Link to={`/p/${m.partyId}`} className="hover:underline">{m.partyName}</Link></>}
                    {m.lastLoginAt ? ` · signed in ${formatRelative(m.lastLoginAt)}` : " · never signed in"}
                    {m.trackedNumbers > 0 && ` · ${m.trackedNumbers} number${m.trackedNumbers === 1 ? "" : "s"}`}
                  </span>
                </span>
                <Badge variant={m.status === "active" ? "success" : m.status === "disabled" ? "muted" : "warning"}>{m.status}</Badge>
                <Button size="sm" variant="outline" className="h-7" disabled={m.status === "disabled" || sendLink.isPending} onClick={() => sendLink.mutate(m.id)} aria-label={`Send sign-in link to ${m.email}`}>
                  <Send className="h-3.5 w-3.5" /> {sendLink.variables === m.id && sendLink.isSuccess ? "Sent" : "Send link"}
                </Button>
                <Button size="sm" variant="ghost" className="h-7 text-muted-foreground" onClick={() => setStatus.mutate({ id: m.id, status: m.status === "disabled" ? "active" : "disabled" })}>
                  {m.status === "disabled" ? "Enable" : "Disable"}
                </Button>
              </li>
            ))}
          </ul>
        )}
        <InviteForm workspaces={workspaces} onDone={() => void qc.invalidateQueries({ queryKey: ["memberships"] })} />
      </section>

      {/* Numbers */}
      <section>
        <div className="mb-3 flex items-center justify-between">
          <h2 className="flex items-center gap-2 text-sm font-medium"><Phone className="h-4 w-4 text-muted-foreground" /> Tracked numbers</h2>
        </div>
        {numbers.isPending ? (
          <Skeleton className="h-24" />
        ) : (
          <>
            {!numbers.data!.twilioConfigured && (
              <p className="mb-3 rounded-md border border-amber-300/60 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200">
                Twilio is not configured: add <code>TWILIO_ACCOUNT_SID</code> and <code>TWILIO_AUTH_TOKEN</code> to the Secrets before pointing a number here.
              </p>
            )}
            <p className="mb-3 text-xs text-muted-foreground">
              Buy numbers in the Twilio console (nothing here spends money). For each one set the voice webhook to{" "}
              <code className="rounded bg-muted px-1">{numbers.data!.webhookUrl ?? "<PUBLIC_URL>/webhooks/twilio/voice"}</code> (HTTP POST), then record it below.
            </p>
            <ul className="divide-y rounded-lg border" data-testid="tracked-numbers">
              {numbers.data!.items.length === 0 && <li className="px-3 py-6 text-center text-sm text-muted-foreground">No tracked numbers yet.</li>}
              {numbers.data!.items.map((n) => (
                <li key={n.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2.5 text-sm" data-testid="number-row" data-status={n.status}>
                  <span className="min-w-0 flex-1">
                    <span className="font-medium tabular">{n.phoneNumber}</span>
                    <span className="text-muted-foreground"> → <span className="tabular">{n.forwardTo}</span></span>
                    <span className="block text-xs text-muted-foreground">
                      {n.partyName && <Link to={`/p/${n.partyId}`} className="hover:underline">{n.partyName}</Link>}
                      {n.workspaceName && ` · ${n.workspaceName}`} · {n.callCount} call{n.callCount === 1 ? "" : "s"}
                      {n.lastCallAt && ` · last ${formatRelative(n.lastCallAt)}`}
                    </span>
                  </span>
                  <Badge variant={n.status === "active" ? "success" : "muted"}>{n.status}</Badge>
                  {n.status !== "released" && (
                    <Button size="sm" variant="ghost" className="h-7 text-muted-foreground" onClick={() => numberStatus.mutate({ id: n.id, status: n.status === "active" ? "paused" : "active" })}>
                      {n.status === "active" ? "Pause" : "Resume"}
                    </Button>
                  )}
                </li>
              ))}
            </ul>
            <NumberForm workspaces={workspaces} memberships={memberships.data?.items ?? []} onDone={() => void qc.invalidateQueries({ queryKey: ["tracked-numbers"] })} />
          </>
        )}
      </section>

      {/* Calls */}
      <section>
        <h2 className="mb-3 flex items-center gap-2 text-sm font-medium"><Mail className="h-4 w-4 text-muted-foreground" /> Recent calls</h2>
        {calls.isPending ? (
          <Skeleton className="h-24" />
        ) : calls.data!.items.length === 0 ? (
          <p className="text-sm text-muted-foreground">No calls yet. They appear here as soon as a tracked number rings.</p>
        ) : (
          <ul className="divide-y rounded-lg border text-sm" data-testid="calls">
            {calls.data!.items.map((c) => (
              <li key={c.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2.5">
                <span className="min-w-0 flex-1">
                  <span className="font-medium">{c.caller ? <Link to={`/p/${c.caller.id}`} className="hover:underline">{c.caller.name}</Link> : <span className="tabular">{c.from ?? "unknown"}</span>}</span>
                  <span className="text-muted-foreground"> → {c.owner?.name ?? c.to}</span>
                  <span className="block text-xs text-muted-foreground tabular">
                    {formatDate(c.startedAt, { withTime: true })}{c.durationSec != null ? ` · ${formatDuration(c.durationSec)}` : ""}{c.status ? ` · ${c.status}` : ""}
                  </span>
                </span>
                {c.interactionId ? (
                  <Link to={`/r/${c.interactionId}`} className="inline-flex items-center gap-2 text-xs hover:underline">
                    {c.interactionTitle ?? "Open recording"} <StatusChip status={c.pipelineStatus} />
                  </Link>
                ) : c.recordingStatus === "failed" ? (
                  <Badge variant="destructive" title={c.recordingError ?? undefined}>recording failed</Badge>
                ) : (
                  <span className="text-xs text-muted-foreground">{c.recordingStatus === "pending" ? "fetching recording…" : "no recording"}</span>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function InviteForm({ workspaces, onDone }: { workspaces: Array<{ id: string; name: string }>; onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState("");
  const [workspaceId, setWorkspaceId] = useState(workspaces[0]?.id ?? "");
  const [party, setParty] = useState<Array<{ id: number; name: string }>>([]);
  useEffect(() => {
    if (!workspaceId && workspaces[0]) setWorkspaceId(workspaces[0].id);
  }, [workspaces, workspaceId]);
  const invite = useMutation({
    mutationFn: () => api<Membership>("/memberships", { method: "POST", json: { email: email.trim(), workspaceId, partyId: party[0]?.id ?? null, displayName: party[0]?.name ?? null, sendLink: true } }),
    onSuccess: () => {
      onDone();
      setOpen(false);
      setEmail("");
      setParty([]);
    },
  });
  if (!open) {
    return (
      <Button variant="outline" size="sm" className="mt-3" onClick={() => setOpen(true)} data-testid="invite-open">
        <Plus /> Invite a contractor
      </Button>
    );
  }
  return (
    <form
      className="mt-3 grid gap-3 rounded-lg border p-4 sm:grid-cols-3"
      data-testid="invite-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (email.trim() && workspaceId) invite.mutate();
      }}
    >
      <div className="space-y-1">
        <Label htmlFor="inv-email">Email</Label>
        <Input id="inv-email" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} autoFocus />
      </div>
      <div className="space-y-1">
        <Label htmlFor="inv-ws">Workspace</Label>
        <Select value={workspaceId} onValueChange={setWorkspaceId}>
          <SelectTrigger id="inv-ws"><SelectValue /></SelectTrigger>
          <SelectContent>
            {workspaces.map((w) => (
              <SelectItem key={w.id} value={w.id}>{w.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="space-y-1">
        <Label htmlFor="inv-party">Their person row</Label>
        <PartyPicker id="inv-party" kind="person" multiple={false} value={party} onChange={setParty} placeholder="So their calls are theirs…" />
      </div>
      {invite.isError && <p className="text-sm text-destructive sm:col-span-3">{invite.error instanceof ApiError ? invite.error.message : "Could not invite"}</p>}
      <div className="flex justify-end gap-2 sm:col-span-3">
        <Button type="button" variant="outline" size="sm" onClick={() => setOpen(false)}>Cancel</Button>
        <Button type="submit" size="sm" disabled={!email.trim() || !workspaceId || invite.isPending} data-testid="invite-save">
          <Send /> Invite and send link
        </Button>
      </div>
    </form>
  );
}

function NumberForm({ workspaces, memberships, onDone }: { workspaces: Array<{ id: string; name: string }>; memberships: Membership[]; onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [phoneNumber, setPhoneNumber] = useState("");
  const [forwardTo, setForwardTo] = useState("");
  const [workspaceId, setWorkspaceId] = useState(workspaces[0]?.id ?? "");
  const [party, setParty] = useState<Array<{ id: number; name: string }>>([]);
  const [membershipId, setMembershipId] = useState<string>("");
  const [notice, setNotice] = useState("");
  useEffect(() => {
    if (!workspaceId && workspaces[0]) setWorkspaceId(workspaces[0].id);
  }, [workspaces, workspaceId]);
  const add = useMutation({
    mutationFn: () =>
      api<TrackedNumber>("/tracked-numbers", {
        method: "POST",
        json: { phoneNumber, forwardTo, workspaceId, partyId: party[0]?.id, membershipId: membershipId ? Number(membershipId) : null, recordingNotice: notice.trim() || null },
      }),
    onSuccess: () => {
      onDone();
      setOpen(false);
      setPhoneNumber("");
      setForwardTo("");
      setParty([]);
      setNotice("");
    },
  });
  if (!open) {
    return (
      <Button variant="outline" size="sm" className="mt-3" onClick={() => setOpen(true)} data-testid="number-open">
        <Plus /> Add a tracked number
      </Button>
    );
  }
  return (
    <form
      className="mt-3 grid gap-3 rounded-lg border p-4 sm:grid-cols-2"
      data-testid="number-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (phoneNumber && forwardTo && party[0] && workspaceId) add.mutate();
      }}
    >
      <div className="space-y-1">
        <Label htmlFor="tn-number">Twilio number</Label>
        <Input id="tn-number" type="tel" required value={phoneNumber} onChange={(e) => setPhoneNumber(e.target.value)} placeholder="+1 936 555 0199" autoFocus />
      </div>
      <div className="space-y-1">
        <Label htmlFor="tn-forward">Forward to (their phone)</Label>
        <Input id="tn-forward" type="tel" required value={forwardTo} onChange={(e) => setForwardTo(e.target.value)} placeholder="+1 936 555 0142" />
      </div>
      <div className="space-y-1">
        <Label htmlFor="tn-ws">Workspace</Label>
        <Select value={workspaceId} onValueChange={setWorkspaceId}>
          <SelectTrigger id="tn-ws"><SelectValue /></SelectTrigger>
          <SelectContent>
            {workspaces.map((w) => (
              <SelectItem key={w.id} value={w.id}>{w.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="space-y-1">
        <Label htmlFor="tn-party">Contractor</Label>
        <PartyPicker id="tn-party" kind="person" multiple={false} value={party} onChange={setParty} placeholder="Whose number is this?" />
      </div>
      <div className="space-y-1">
        <Label htmlFor="tn-membership">Login (optional)</Label>
        <Select value={membershipId || "__none"} onValueChange={(v) => setMembershipId(v === "__none" ? "" : v)}>
          <SelectTrigger id="tn-membership"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="__none">None</SelectItem>
            {memberships.map((m) => (
              <SelectItem key={m.id} value={String(m.id)}>{m.displayName || m.email}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="space-y-1">
        <Label htmlFor="tn-notice">Recording notice (what callers hear)</Label>
        <Input id="tn-notice" value={notice} onChange={(e) => setNotice(e.target.value)} placeholder="This call may be recorded…" />
      </div>
      {add.isError && <p className="text-sm text-destructive sm:col-span-2">{add.error instanceof ApiError ? add.error.message : "Could not add"}</p>}
      <div className="flex justify-end gap-2 sm:col-span-2">
        <Button type="button" variant="outline" size="sm" onClick={() => setOpen(false)}>Cancel</Button>
        <Button type="submit" size="sm" disabled={!phoneNumber || !forwardTo || !party[0] || !workspaceId || add.isPending} data-testid="number-save">Add number</Button>
      </div>
    </form>
  );
}
