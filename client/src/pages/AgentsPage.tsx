import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Bot, Check, Copy, KeyRound, Plug, ScrollText, ShieldAlert } from "lucide-react";
import { api } from "@/lib/api";
import { formatDate, formatRelative } from "@/lib/format";
import { useWorkspace } from "@/lib/workspace";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { EmptyState } from "@/components/EmptyState";
import { cn } from "@/lib/utils";

interface Status {
  enabled: boolean;
  disabledReason: string | null;
  endpoint: string | null;
  oauthEnabled: boolean;
  rolesConfigured: { reader: boolean; proposer: boolean };
  embeddingProvider: { name: string; model: string } | null;
  embeddingsError: string | null;
  rateLimitPerMin: number;
  restrictedWorkspaces: string[];
  unassignedScope: string;
  unassignedRecordings: number;
  tools: Array<{ name: string; title: string; readOnly: boolean }>;
  embeddings: { embedded: number; pending: number; failed: number; noTranscript: number; chunks: number; lastEmbeddedAt: string | null };
  counts: { tokens: number; clients: number; calls_24h: number; errors_24h: number };
}
interface ApiToken {
  id: number;
  name: string;
  tokenPrefix: string;
  workspaceScope: string[];
  /** vault:read + vault:propose (MCP), or one ingest scope alone (ingest:messages, ingest:device). */
  scopes?: string[];
  purpose?: "mcp" | "imessage" | "mac_media" | "ios_shortcut" | null;
  createdBy: string | null;
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
  calls: number;
}
interface OAuthClient {
  clientId: string;
  clientName: string | null;
  redirectUris: string[];
  workspaceScope: string[];
  consentedBy: string | null;
  consentedAt: string | null;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
  activeGrants: number;
  calls: number;
}
interface AuditRow {
  id: number;
  tokenId: string;
  clientName: string | null;
  tool: string;
  args: Record<string, unknown>;
  workspaceScope: string[];
  resultCount: number | null;
  durationMs: number | null;
  error: string | null;
  createdAt: string;
}

const TABS = ["tokens", "apps", "audit"] as const;
type Tab = (typeof TABS)[number];

/** Owner only: personal access tokens, connected OAuth apps and the MCP audit log. */
export default function AgentsPage() {
  const [tab, setTab] = useState<Tab>(() => {
    const h = window.location.hash.replace("#", "");
    return (TABS as readonly string[]).includes(h) ? (h as Tab) : "tokens";
  });
  useEffect(() => {
    document.title = "Agents & API · Strout Vault";
  }, []);
  const status = useQuery({ queryKey: ["mcp-status"], queryFn: () => api<Status>("/mcp/status"), refetchInterval: 60_000 });

  return (
    <main className="mx-auto w-full max-w-5xl px-4 py-6 pb-24 lg:pb-10">
      <header className="mb-6">
        <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
          <Bot className="h-6 w-6 text-primary" /> Agents &amp; API
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Claude.ai, Claude Code and scheduled jobs reach the vault through one MCP endpoint. Every token carries a workspace scope, every call is logged here, and the only write an agent can make is a proposal for your review queue.
        </p>
      </header>

      <StatusCards status={status.data} loading={status.isPending} />

      <Tabs
        value={tab}
        onValueChange={(v) => {
          setTab(v as Tab);
          window.location.hash = v;
        }}
        className="mt-8"
      >
        <TabsList>
          <TabsTrigger value="tokens">
            <KeyRound className="h-4 w-4" /> API tokens
          </TabsTrigger>
          <TabsTrigger value="apps">
            <Plug className="h-4 w-4" /> Connected apps
          </TabsTrigger>
          <TabsTrigger value="audit">
            <ScrollText className="h-4 w-4" /> Audit log
          </TabsTrigger>
        </TabsList>
        <TabsContent value="tokens" className="mt-4">
          <TokensTab status={status.data} />
        </TabsContent>
        <TabsContent value="apps" className="mt-4">
          <AppsTab />
        </TabsContent>
        <TabsContent value="audit" className="mt-4">
          <AuditTab />
        </TabsContent>
      </Tabs>
    </main>
  );
}

function StatusCards({ status, loading }: { status: Status | undefined; loading: boolean }) {
  if (loading || !status) {
    return (
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-24" />
        ))}
      </div>
    );
  }
  const e = status.embeddings;
  return (
    <section aria-label="MCP status" className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
      <Card title="Endpoint">
        {status.enabled ? (
          <>
            <p className="break-all font-mono text-sm">{status.endpoint ?? "(set PUBLIC_URL)"}</p>
            <p className="mt-1 text-xs text-muted-foreground">
              {status.oauthEnabled ? "OAuth for Claude.ai on" : "OAuth off (PUBLIC_URL must be https)"} · {status.rateLimitPerMin} calls/min per token
            </p>
          </>
        ) : (
          <p className="flex items-start gap-1.5 text-sm text-destructive">
            <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" /> {status.disabledReason}
          </p>
        )}
      </Card>
      <Card title="Database roles">
        <ul className="space-y-1 text-sm">
          <li className="flex items-center justify-between">
            <span>mcp_reader</span>
            {status.rolesConfigured.reader ? <Badge variant="success">configured</Badge> : <Badge variant="warning">app role</Badge>}
          </li>
          <li className="flex items-center justify-between">
            <span>mcp_proposer</span>
            {status.rolesConfigured.proposer ? <Badge variant="success">configured</Badge> : <Badge variant="warning">app role</Badge>}
          </li>
        </ul>
      </Card>
      <Card title="Semantic index">
        <p className="text-lg font-medium" data-testid="embedding-counts">
          {e.embedded} embedded · {e.pending} pending
        </p>
        <p className="text-xs text-muted-foreground">
          {e.failed} failed · {e.chunks} chunks · {status.embeddingProvider ? `${status.embeddingProvider.name} ${status.embeddingProvider.model}` : status.embeddingsError ?? "no embedding provider (keyword search only)"}
        </p>
      </Card>
      <Card title="Last 24 hours">
        <p className="text-lg font-medium">{status.counts.calls_24h} calls</p>
        <p className="text-xs text-muted-foreground">
          {status.counts.errors_24h} errors · {status.counts.tokens} active token{status.counts.tokens === 1 ? "" : "s"} · {status.counts.clients} connected app{status.counts.clients === 1 ? "" : "s"}
        </p>
      </Card>
    </section>
  );
}

const UNASSIGNED = "unassigned";

function ScopeBadges({ scope, restricted }: { scope: string[]; restricted?: string[] }) {
  if (!scope.length) return <Badge variant="destructive">no workspaces</Badge>;
  return (
    <span className="flex flex-wrap gap-1">
      {scope.map((s) => (
        <Badge key={s} variant={s === "*" ? "default" : s === UNASSIGNED || restricted?.includes(s) ? "warning" : "secondary"}>
          {s === "*" ? "all workspaces" : s === UNASSIGNED ? "unassigned recordings" : s}
        </Badge>
      ))}
    </span>
  );
}

// ---------------------------------------------------------------- tokens --
function TokensTab({ status }: { status: Status | undefined }) {
  const qc = useQueryClient();
  const { workspaces } = useWorkspace();
  const restricted = status?.restrictedWorkspaces ?? ["phalanx"];
  const tokens = useQuery({ queryKey: ["mcp-tokens"], queryFn: async () => (await api<{ items: ApiToken[] }>("/mcp/tokens")).items });
  const [name, setName] = useState("");
  const [all, setAll] = useState(true);
  const [picked, setPicked] = useState<string[]>([]);
  const [expires, setExpires] = useState<string>("never");
  const [kind, setKind] = useState<TokenKind>("mcp");
  const [minted, setMinted] = useState<{ token: string; item: ApiToken } | null>(null);
  const [copied, setCopied] = useState(false);

  const scope = useMemo(() => {
    if (all) return ["*", ...picked.filter((p) => restricted.includes(p) || p === UNASSIGNED)];
    return picked;
  }, [all, picked, restricted]);

  const create = useMutation({
    mutationFn: () =>
      api<{ token: string; item: ApiToken }>("/mcp/tokens", {
        method: "POST",
        json: {
          name: name.trim(),
          workspaceScope: kind === "mcp" ? scope : [],
          scopes: TOKEN_KINDS[kind].scopes,
          purpose: TOKEN_KINDS[kind].purpose,
          expiresInDays: expires === "never" ? null : Number(expires),
        },
      }),
    onSuccess: (out) => {
      setMinted(out);
      setCopied(false);
      setName("");
      void qc.invalidateQueries({ queryKey: ["mcp-tokens"] });
      void qc.invalidateQueries({ queryKey: ["mcp-status"] });
    },
  });
  const revoke = useMutation({
    mutationFn: (id: number) => api<ApiToken>(`/mcp/tokens/${id}/revoke`, { method: "POST" }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["mcp-tokens"] });
      void qc.invalidateQueries({ queryKey: ["mcp-status"] });
    },
  });

  const toggle = (id: string) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_22rem]">
      <section>
        <h2 className="text-base font-semibold">Personal access tokens</h2>
        <p className="mb-3 mt-0.5 text-sm text-muted-foreground">For Claude Code and scheduled jobs. Sent as <code className="rounded bg-muted px-1">Authorization: Bearer</code>. A token is shown once; only its hash is stored.</p>
        {tokens.isPending ? (
          <Skeleton className="h-32" />
        ) : !tokens.data?.length ? (
          <EmptyState icon={<KeyRound />} title="No tokens yet">Create one on the right. New tokens default to no workspaces until you pick some.</EmptyState>
        ) : (
          <ul className="divide-y rounded-lg border">
            {tokens.data.map((t) => (
              <li key={t.id} className={cn("flex flex-col gap-2 p-3 sm:flex-row sm:items-start sm:justify-between", t.revokedAt && "opacity-60")} data-testid="api-token">
                <div className="min-w-0 space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{t.name}</span>
                    <code className="rounded bg-muted px-1.5 text-xs">{t.tokenPrefix}…</code>
                    {t.revokedAt ? <Badge variant="muted">revoked {formatRelative(t.revokedAt)}</Badge> : t.expiresAt && new Date(t.expiresAt) < new Date() ? <Badge variant="muted">expired</Badge> : <Badge variant="success">active</Badge>}
                  </div>
                  {t.scopes?.includes("ingest:messages") ? (
                    <Badge variant="secondary">message ingest only: no reads, no MCP</Badge>
                  ) : t.scopes?.includes("ingest:device") ? (
                    <Badge variant="secondary">{t.purpose === "ios_shortcut" ? "iPhone Shortcut" : "Mac media collector"}: device ingest only, no reads, no MCP</Badge>
                  ) : (
                    <ScopeBadges scope={t.workspaceScope} restricted={restricted} />
                  )}
                  <p className="text-xs text-muted-foreground">
                    created {formatDate(t.createdAt)}{t.createdBy ? ` by ${t.createdBy}` : ""} · {t.lastUsedAt ? `last used ${formatRelative(t.lastUsedAt)}` : "never used"} · {t.calls} call{t.calls === 1 ? "" : "s"}
                    {t.expiresAt ? ` · expires ${formatDate(t.expiresAt)}` : ""}
                  </p>
                </div>
                {!t.revokedAt && (
                  <Button size="sm" variant="outline" className="shrink-0" onClick={() => revoke.mutate(t.id)} disabled={revoke.isPending} data-testid="revoke-token">
                    Revoke
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <aside className="rounded-lg border bg-card p-4">
        <h3 className="text-sm font-semibold">New token</h3>
        {minted ? (
          <div className="mt-3 space-y-3" data-testid="minted-token">
            <p className="text-sm">
              Copy <strong>{minted.item.name}</strong> now; it will not be shown again.
            </p>
            <div className="flex items-stretch gap-2">
              <Input readOnly value={minted.token} className="font-mono text-xs" onFocus={(e) => e.currentTarget.select()} aria-label="New token" />
              <Button
                variant="outline"
                size="icon"
                aria-label="Copy token"
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(minted.token);
                    setCopied(true);
                  } catch {
                    /* select-and-copy fallback: the field is selectable */
                  }
                }}
              >
                {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
              </Button>
            </div>
            {minted.item.scopes?.includes("ingest:messages") ? (
              <p className="text-xs text-muted-foreground">
                On the Mac: <code className="rounded bg-muted px-1">pbpaste &gt; ~/.strout-vault/imessage-token &amp;&amp; chmod 600 ~/.strout-vault/imessage-token</code> (collectors/imessage/README.md).
              </p>
            ) : minted.item.purpose === "mac_media" ? (
              <p className="text-xs text-muted-foreground">
                On the Mac, into the Keychain: <code className="rounded bg-muted px-1">security add-generic-password -U -s strout-vault -a apple-media -w "$(pbpaste)"</code> (collectors/apple-media/README.md).
              </p>
            ) : minted.item.purpose === "ios_shortcut" ? (
              <p className="text-xs text-muted-foreground">Paste it into the Shortcut's Token text action (collectors/ios/SHORTCUT.md).</p>
            ) : (
              <p className="text-xs text-muted-foreground">
                Claude Code: <code className="rounded bg-muted px-1">claude mcp add --transport http strout-vault {status?.endpoint ?? "<PUBLIC_URL>/mcp"} --header "Authorization: Bearer &lt;token&gt;"</code>
              </p>
            )}
            <Button size="sm" variant="outline" onClick={() => setMinted(null)}>
              Done
            </Button>
          </div>
        ) : (
          <form
            className="mt-3 space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              if (!name.trim() || create.isPending) return;
              create.mutate();
            }}
          >
            <div>
              <Label htmlFor="token-name">Name</Label>
              <Input id="token-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Claude Code on the laptop" maxLength={100} required />
            </div>
            <div>
              <Label htmlFor="token-kind">Kind</Label>
              <Select value={kind} onValueChange={(v) => setKind(v as TokenKind)}>
                <SelectTrigger id="token-kind" data-testid="token-kind">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="mcp">MCP: read and propose</SelectItem>
                  <SelectItem value="ingest">iMessage collector: send texts only</SelectItem>
                  <SelectItem value="mac_media">Mac media collector: voice memos, call recordings, notes</SelectItem>
                  <SelectItem value="ios_shortcut">iPhone Shortcut: send audio only</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {kind === "mcp" && (
              <fieldset>
                <legend className="text-sm font-medium">Workspaces</legend>
                <label className="mt-1 flex items-center gap-2 text-sm">
                  <Checkbox checked={all} onCheckedChange={(v) => setAll(v === true)} /> All workspaces
                  <span className="text-xs text-muted-foreground">(never includes {restricted.join(", ")})</span>
                </label>
                <ul className="mt-1 space-y-1 pl-6">
                  {workspaces.map((w) => {
                    const isRestricted = restricted.includes(w.id);
                    const checked = picked.includes(w.id);
                    const disabled = all && !isRestricted;
                    return (
                      <li key={w.id}>
                        <label className={cn("flex items-center gap-2 text-sm", disabled && "text-muted-foreground")}>
                          <Checkbox checked={disabled ? true : checked} disabled={disabled} onCheckedChange={() => toggle(w.id)} data-testid={`scope-${w.id}`} />
                          {w.name}
                          {isRestricted && <Badge variant="warning">explicit</Badge>}
                        </label>
                      </li>
                    );
                  })}
                  <li>
                    <label className="flex items-start gap-2 text-sm">
                      <Checkbox className="mt-0.5" checked={picked.includes(UNASSIGNED)} onCheckedChange={() => toggle(UNASSIGNED)} data-testid="scope-unassigned" />
                      <span>
                        Unassigned recordings <Badge variant="warning">explicit</Badge>
                        <span className="block text-xs text-muted-foreground">
                          {status?.unassignedRecordings ?? 0} recording{status?.unassignedRecordings === 1 ? "" : "s"} not filed under a workspace yet. They can be about any venture, so "all workspaces" never includes them.
                        </span>
                      </span>
                    </label>
                  </li>
                </ul>
              </fieldset>
            )}
            <div>
              <Label htmlFor="token-expiry">Expires</Label>
              <Select value={expires} onValueChange={setExpires}>
                <SelectTrigger id="token-expiry">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="never">Never (revoke by hand)</SelectItem>
                  <SelectItem value="30">In 30 days</SelectItem>
                  <SelectItem value="90">In 90 days</SelectItem>
                  <SelectItem value="365">In a year</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {kind === "mcp" ? (
              <p className="text-xs text-muted-foreground">Scope: <ScopeBadges scope={scope} restricted={restricted} /></p>
            ) : (
              <p className="text-xs text-muted-foreground">Can only call {kind === "ingest" ? "POST /api/ingest/messages" : "/api/ingest/device/*"}. It reads nothing and cannot call any MCP tool.</p>
            )}
            {create.isError && <p className="text-sm text-destructive">{(create.error as Error).message}</p>}
            <Button type="submit" disabled={!name.trim() || create.isPending || (kind === "mcp" && !scope.length)} data-testid="create-token">
              Create token
            </Button>
          </form>
        )}
      </aside>
    </div>
  );
}

type TokenKind = "mcp" | "ingest" | "mac_media" | "ios_shortcut";
const TOKEN_KINDS: Record<TokenKind, { scopes: string[] | undefined; purpose: string | undefined }> = {
  mcp: { scopes: undefined, purpose: undefined },
  ingest: { scopes: ["ingest:messages"], purpose: "imessage" },
  mac_media: { scopes: ["ingest:device"], purpose: "mac_media" },
  ios_shortcut: { scopes: ["ingest:device"], purpose: "ios_shortcut" },
};

// ------------------------------------------------------------------ apps --
function AppsTab() {
  const qc = useQueryClient();
  const clients = useQuery({ queryKey: ["mcp-clients"], queryFn: async () => (await api<{ items: OAuthClient[] }>("/mcp/clients")).items });
  const revoke = useMutation({
    mutationFn: (id: string) => api(`/mcp/clients/${encodeURIComponent(id)}/revoke`, { method: "POST" }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["mcp-clients"] });
      void qc.invalidateQueries({ queryKey: ["mcp-status"] });
    },
  });
  return (
    <section>
      <h2 className="text-base font-semibold">Connected apps</h2>
      <p className="mb-3 mt-0.5 text-sm text-muted-foreground">OAuth clients that registered themselves (Claude.ai custom connectors). The scope is what you ticked on the consent screen; revoking cuts off every token the app holds.</p>
      {clients.isPending ? (
        <Skeleton className="h-32" />
      ) : !clients.data?.length ? (
        <EmptyState icon={<Plug />} title="Nothing connected yet">
          In Claude.ai, add a custom connector with the endpoint above; it will register here once you approve it.
        </EmptyState>
      ) : (
        <ul className="divide-y rounded-lg border">
          {clients.data.map((c) => (
            <li key={c.clientId} className={cn("flex flex-col gap-2 p-3 sm:flex-row sm:items-start sm:justify-between", c.revokedAt && "opacity-60")} data-testid="oauth-client">
              <div className="min-w-0 space-y-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{c.clientName ?? "Unnamed client"}</span>
                  <code className="truncate rounded bg-muted px-1.5 text-xs">{c.clientId}</code>
                  {c.revokedAt ? <Badge variant="muted">revoked</Badge> : c.consentedAt ? <Badge variant="success">{c.activeGrants} active grant{c.activeGrants === 1 ? "" : "s"}</Badge> : <Badge variant="warning">registered, not approved</Badge>}
                </div>
                <ScopeBadges scope={c.workspaceScope} />
                <p className="truncate text-xs text-muted-foreground">
                  {c.redirectUris.map((u) => safeHost(u)).join(", ")} · registered {formatDate(c.createdAt)}
                  {c.consentedAt ? ` · approved ${formatDate(c.consentedAt)}${c.consentedBy ? ` by ${c.consentedBy}` : ""}` : ""} · {c.lastUsedAt ? `last used ${formatRelative(c.lastUsedAt)}` : "never used"} · {c.calls} call{c.calls === 1 ? "" : "s"}
                </p>
              </div>
              {!c.revokedAt && (
                <Button size="sm" variant="outline" className="shrink-0" onClick={() => revoke.mutate(c.clientId)} disabled={revoke.isPending}>
                  Revoke
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function safeHost(u: string): string {
  try {
    return new URL(u).host;
  } catch {
    return u;
  }
}

// ----------------------------------------------------------------- audit --
function AuditTab() {
  const [token, setToken] = useState<string>("all");
  const [tool, setTool] = useState<string>("all");
  const qs = new URLSearchParams({ limit: "500" });
  if (token !== "all") qs.set("token", token);
  if (tool !== "all") qs.set("tool", tool);
  const audit = useQuery({ queryKey: ["mcp-audit", token, tool], queryFn: async () => (await api<{ items: AuditRow[] }>(`/mcp/audit?${qs}`)).items, placeholderData: (prev) => prev, refetchInterval: 30_000 });
  const all = useQuery({ queryKey: ["mcp-audit", "all", "all"], queryFn: async () => (await api<{ items: AuditRow[] }>("/mcp/audit?limit=500")).items });
  const tokenOptions = useMemo(() => {
    const m = new Map<string, string>();
    for (const r of all.data ?? []) m.set(r.tokenId, r.clientName ?? r.tokenId);
    return [...m.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  }, [all.data]);
  const toolOptions = useMemo(() => [...new Set((all.data ?? []).map((r) => r.tool))].sort(), [all.data]);

  return (
    <section>
      <div className="mb-3 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h2 className="text-base font-semibold">Audit log</h2>
          <p className="mt-0.5 text-sm text-muted-foreground">The last 500 tool calls: who, what, how many results, how long. Arguments are redacted and truncated.</p>
        </div>
        <div className="flex gap-2">
          <Select value={token} onValueChange={setToken}>
            <SelectTrigger className="w-44" aria-label="Filter by token">
              <SelectValue placeholder="All tokens" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All tokens</SelectItem>
              {tokenOptions.map(([id, label]) => (
                <SelectItem key={id} value={id}>
                  {label} <span className="text-muted-foreground">({id})</span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={tool} onValueChange={setTool}>
            <SelectTrigger className="w-48" aria-label="Filter by tool">
              <SelectValue placeholder="All tools" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All tools</SelectItem>
              {toolOptions.map((t) => (
                <SelectItem key={t} value={t}>
                  {t}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>
      {audit.isPending ? (
        <Skeleton className="h-40" />
      ) : !audit.data?.length ? (
        <EmptyState icon={<ScrollText />} title="No calls yet">Every MCP tool call will be listed here.</EmptyState>
      ) : (
        <div className="overflow-x-auto rounded-lg border">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-3 py-2">When</th>
                <th className="px-3 py-2">Token</th>
                <th className="px-3 py-2">Tool</th>
                <th className="px-3 py-2">Arguments</th>
                <th className="px-3 py-2 text-right">Results</th>
                <th className="px-3 py-2 text-right">ms</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {audit.data.map((r) => (
                <tr key={r.id} className={r.error ? "bg-destructive/5" : undefined} data-testid="audit-row">
                  <td className="whitespace-nowrap px-3 py-2 text-muted-foreground" title={r.createdAt}>
                    {formatDate(r.createdAt, { withTime: true })}
                  </td>
                  <td className="whitespace-nowrap px-3 py-2">
                    <span className="font-medium">{r.clientName ?? r.tokenId}</span>
                    <span className="block text-xs text-muted-foreground">{r.tokenId} · {r.workspaceScope.length ? r.workspaceScope.join(", ") : "no workspaces"}</span>
                  </td>
                  <td className="whitespace-nowrap px-3 py-2 font-mono text-xs">{r.tool}</td>
                  <td className="max-w-md px-3 py-2">
                    <code className="block truncate text-xs" title={JSON.stringify(r.args)}>
                      {JSON.stringify(r.args)}
                    </code>
                    {r.error && <span className="block text-xs text-destructive">{r.error}</span>}
                  </td>
                  <td className="px-3 py-2 text-right tabular">{r.resultCount ?? "–"}</td>
                  <td className="px-3 py-2 text-right tabular text-muted-foreground">{r.durationMs ?? "–"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border bg-card p-4">
      <h2 className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">{title}</h2>
      {children}
    </div>
  );
}
