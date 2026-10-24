import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Building2, Check, Clock, Download, Film, FolderOpen, ListOrdered, Scissors, ThumbsDown, ThumbsUp, User, Users } from "lucide-react";
import { api } from "@/lib/api";
import type { ClipCandidateItem, RecordingDetail, TranscriptLine } from "@shared/types";
import { formatBytes, formatDate, formatDuration, formatTimestamp, isReady, SOURCE_LABEL, statusLabel } from "@/lib/format";
import { cn } from "@/lib/utils";
import { useMediaQuery } from "@/hooks/useMediaQuery";
import { useMe } from "@/hooks/useAuth";
import { VideoPlayer, type VideoHandle } from "@/components/VideoPlayer";
import { Transcript } from "@/components/Transcript";
import { InlineEdit } from "@/components/InlineEdit";
import { TagEditor } from "@/components/TagEditor";
import { SourceIcon } from "@/components/SourceIcon";
import { StatusChip } from "@/components/StatusChip";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { EmptyState } from "@/components/EmptyState";
import { PartyPicker } from "@/components/PartyPicker";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { ProjectListItem } from "@shared/types";

export default function RecordingPage() {
  const { id } = useParams();
  const recId = Number(id);
  const [params, setParams] = useSearchParams();
  const qc = useQueryClient();
  const startAt = params.get("t") != null ? Number(params.get("t")) : null;
  const video = useRef<VideoHandle>(null);
  const [time, setTime] = useState(startAt ?? 0);
  const isDesktop = useMediaQuery("(min-width: 1024px)");
  const me = useMe();
  const owner = me.data?.user.role === "owner";
  const [newPerson, setNewPerson] = useState<Array<{ id: number; name: string }>>([]);
  const [newLabel, setNewLabel] = useState<string>("");
  const [newProject, setNewProject] = useState<string>("");

  const detail = useQuery({
    queryKey: ["recording", recId],
    queryFn: () => api<RecordingDetail>(`/interactions/${recId}`),
    enabled: Number.isInteger(recId) && recId > 0,
    refetchInterval: (q) => (q.state.data && !isReady(q.state.data.pipelineStatus) ? 10_000 : false),
  });
  const segments = useQuery({
    queryKey: ["segments", recId],
    queryFn: () => api<{ lines: TranscriptLine[]; anchored: boolean }>(`/interactions/${recId}/segments`),
    enabled: detail.isSuccess,
    staleTime: 5 * 60_000,
  });

  useEffect(() => {
    document.title = `${detail.data?.title?.trim() || "Recording"} · Strout Vault`;
  }, [detail.data?.title]);

  const patch = useMutation({
    mutationFn: (body: { title?: string; tags?: string[] }) => api<RecordingDetail>(`/interactions/${recId}`, { method: "PATCH", json: body }),
    onSuccess: (data) => {
      qc.setQueryData(["recording", recId], data);
      void qc.invalidateQueries({ queryKey: ["library"] });
    },
  });
  const addParticipant = useMutation({
    mutationFn: (body: { partyId: number; speakerLabel: string | null }) => api<{ linesAssigned: number; recording: RecordingDetail }>(`/interactions/${recId}/participants`, { method: "POST", json: body }),
    onSuccess: ({ recording }) => {
      qc.setQueryData(["recording", recId], recording);
      void qc.invalidateQueries({ queryKey: ["segments", recId] });
      void qc.invalidateQueries({ queryKey: ["library"] });
      setNewPerson([]);
      setNewLabel("");
    },
  });
  const linkProject = useMutation({
    mutationFn: (projectId: number) => api<RecordingDetail>(`/interactions/${recId}/projects`, { method: "POST", json: { projectId } }),
    onSuccess: (data) => {
      qc.setQueryData(["recording", recId], data);
      setNewProject("");
    },
  });
  const projectOptions = useQuery({
    queryKey: ["projects", "", detail.data?.workspace?.id ? `&workspace=${detail.data.workspace.id}` : ""],
    queryFn: () => api<{ items: ProjectListItem[] }>(`/projects?${detail.data?.workspace?.id ? `workspace=${encodeURIComponent(detail.data.workspace.id)}` : ""}`),
    enabled: detail.isSuccess && owner,
    staleTime: 60_000,
  });
  const clipStatus = useMutation({
    mutationFn: ({ clipId, status }: { clipId: number; status: "approved" | "rejected" | "new" }) =>
      api<ClipCandidateItem>(`/clips/${clipId}`, { method: "PATCH", json: { status } }),
    onSuccess: (clip) => {
      qc.setQueryData<RecordingDetail>(["recording", recId], (old) => (old ? { ...old, clips: old.clips.map((c) => (c.id === clip.id ? clip : c)) } : old));
    },
  });

  const seek = useCallback(
    (sec: number, play = true) => {
      video.current?.seek(sec, play);
      setTime(sec);
      const next = new URLSearchParams(params);
      next.set("t", String(Math.floor(sec)));
      setParams(next, { replace: true });
    },
    [params, setParams],
  );
  const onTime = useCallback((t: number) => setTime(t), []);

  if (detail.isError) {
    return (
      <div className="mx-auto max-w-7xl px-4 py-10">
        <EmptyState icon={<AlertTriangle />} title="Recording not found" action={<Button asChild variant="outline"><Link to="/">Back to the library</Link></Button>}>
          It may have been renumbered, or the link is wrong.
        </EmptyState>
      </div>
    );
  }
  const r = detail.data;

  const transcript = (
    <Transcript lines={segments.data?.lines} anchored={segments.data?.anchored ?? true} currentTime={time} onSeek={(s) => seek(s, true)} initialSeconds={startAt} linkSpeakers={owner} />
  );

  return (
    <div className="mx-auto max-w-7xl px-4 pb-6 lg:py-6">
      <div className="grid gap-6 lg:grid-cols-[minmax(0,7fr)_minmax(0,5fr)] lg:items-start">
        {/* Left column (whole page on phones): video, title, tabs. Sticky as a block on desktop; only the video sticks on phones. */}
        <div className="min-w-0 lg:sticky lg:top-20">
          <div className="sticky top-14 z-20 -mx-4 bg-background px-4 pb-2 pt-3 lg:static lg:mx-0 lg:p-0">
            {r ? (
              <VideoPlayer ref={video} src={r.video?.url ?? null} mimeType={r.video?.mimeType} audioOnly={r.video?.kind === "audio"} startAt={startAt} onTime={onTime} />
            ) : (
              <Skeleton className="aspect-video w-full" />
            )}
          </div>
          <div className="mt-3 space-y-3">
            {r ? (
              <>
                <div className="flex items-start gap-2">
                  <SourceIcon source={r.source} className="mt-2" />
                  {owner ? (
                    <InlineEdit
                      as="h1"
                      label="Title"
                      value={r.title ?? ""}
                      placeholder="Untitled recording"
                      className="text-lg font-semibold leading-snug tracking-tight"
                      inputClassName="text-lg font-semibold"
                      testId="title"
                      onSave={(title) => patch.mutateAsync({ title })}
                    />
                  ) : (
                    <h1 className="text-lg font-semibold leading-snug tracking-tight" data-testid="title">{r.title?.trim() || "Untitled recording"}</h1>
                  )}
                </div>
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground">
                  <time dateTime={r.occurredAt ?? undefined} className="tabular">{formatDate(r.occurredAt, { withTime: true }) || "Undated"}</time>
                  {r.durationSec != null && (
                    <span className="inline-flex items-center gap-1 tabular">
                      <Clock className="h-3.5 w-3.5" aria-hidden />
                      {formatDuration(r.durationSec)}
                    </span>
                  )}
                  {r.workspace && <Badge variant="outline">{r.workspace.name}</Badge>}
                  <StatusChip status={r.pipelineStatus} error={r.pipelineError} />
                </div>
                {owner ? (
                  <TagEditor tags={r.tags} onChange={(tags) => patch.mutateAsync({ tags })} />
                ) : r.tags.length > 0 ? (
                  <div className="flex flex-wrap gap-1.5">{r.tags.map((t) => <Badge key={t} variant="secondary">{t}</Badge>)}</div>
                ) : null}
                {r.pipelineStatus === "failed" && r.pipelineError && (
                  <p className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">{r.pipelineError}</p>
                )}
              </>
            ) : (
              <>
                <Skeleton className="h-6 w-2/3" />
                <Skeleton className="h-4 w-1/2" />
              </>
            )}
          </div>

          {r && (
            <Tabs key={isDesktop ? "desktop" : "mobile"} defaultValue={isDesktop ? "people" : "transcript"} className="mt-5">
              <TabsList className="w-full max-w-full justify-start overflow-x-auto scrollbar-thin">
                {!isDesktop && (
                  <TabsTrigger value="transcript"><ListOrdered className="h-3.5 w-3.5" /> Transcript</TabsTrigger>
                )}
                <TabsTrigger value="people"><Users className="h-3.5 w-3.5" /> People <Count n={r.participants.length} /></TabsTrigger>
                <TabsTrigger value="facts"><Check className="h-3.5 w-3.5" /> Facts <Count n={r.facts.length} /></TabsTrigger>
                <TabsTrigger value="clips"><Scissors className="h-3.5 w-3.5" /> Clips <Count n={r.clips.length} /></TabsTrigger>
                <TabsTrigger value="details"><FolderOpen className="h-3.5 w-3.5" /> Details</TabsTrigger>
              </TabsList>
              {!isDesktop && (
                <TabsContent value="transcript">
                  <section aria-label="Transcript" className="min-w-0 rounded-lg border bg-card">{transcript}</section>
                </TabsContent>
              )}
              <TabsContent value="people">
                {r.participants.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No one has been tagged on this recording yet.</p>
                ) : null}
                {r.participants.length > 0 && (
                  <ul className="divide-y rounded-lg border">
                    {r.participants.map((p) => (
                      <li key={p.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2.5">
                        {p.kind === "org" ? <Building2 className="h-4 w-4 text-muted-foreground" /> : <User className="h-4 w-4 text-muted-foreground" />}
                        {owner ? <Link to={`/p/${p.id}`} className="font-medium underline-offset-2 hover:underline">{p.name}</Link> : <span className="font-medium">{p.name}</span>}
                        {p.speakerLabel && p.speakerLabel !== p.name && <span className="text-xs text-muted-foreground">as {p.speakerLabel}</span>}
                        <span className="flex flex-wrap gap-1 sm:ml-auto">
                          {p.roles.map((role) => (
                            <Badge key={`${role.workspaceId}-${role.role}`} variant="muted" title={role.detail ?? undefined}>
                              {role.workspaceName} · {role.role}
                              {role.market ? ` · ${role.market}` : ""}
                            </Badge>
                          ))}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
                {/* Tag a person by hand, optionally naming which speaker label is theirs. */}
                {owner && (
                <form
                  className="mt-3 flex flex-wrap items-end gap-2 rounded-lg border border-dashed p-3"
                  data-testid="tag-person"
                  onSubmit={(e) => {
                    e.preventDefault();
                    if (newPerson[0]) addParticipant.mutate({ partyId: newPerson[0].id, speakerLabel: newLabel || null });
                  }}
                >
                  <div className="min-w-[12rem] flex-1 space-y-1">
                    <span className="text-xs text-muted-foreground">Tag a person</span>
                    <PartyPicker multiple={false} value={newPerson} onChange={setNewPerson} placeholder="Who else was on this call?" />
                  </div>
                  {r.speakers.length > 0 && (
                    <div className="space-y-1">
                      <span className="text-xs text-muted-foreground">Speaking as</span>
                      <Select value={newLabel || "__none"} onValueChange={(v) => setNewLabel(v === "__none" ? "" : v)}>
                        <SelectTrigger className="h-8 w-[11rem]" aria-label="Speaker label"><SelectValue /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="__none">No speaker label</SelectItem>
                          {r.speakers.map((s) => (
                            <SelectItem key={s.label} value={s.label}>
                              {s.label} · {s.lines} line{s.lines === 1 ? "" : "s"}{s.partyId ? " · assigned" : ""}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  )}
                  <Button type="submit" size="sm" className="h-8" disabled={!newPerson[0] || addParticipant.isPending} data-testid="tag-person-save">Add</Button>
                  {addParticipant.data && addParticipant.data.linesAssigned > 0 && (
                    <span className="w-full text-xs text-muted-foreground">{addParticipant.data.linesAssigned} transcript lines assigned.</span>
                  )}
                </form>
                )}

                {owner && <h3 className="mb-1.5 mt-5 text-sm font-medium">Projects</h3>}
                {owner && r.projects.length > 0 && (
                  <ul className="mb-2 flex flex-wrap gap-1.5" data-testid="linked-projects">
                    {r.projects.map((pr) => (
                      <li key={pr.id}>
                        <Link to={`/projects/${pr.id}`} className="inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-sm hover:bg-accent">
                          {pr.name} <span className="text-xs text-muted-foreground">{pr.workspaceName}</span>
                        </Link>
                      </li>
                    ))}
                  </ul>
                )}
                {owner && (
                <form
                  className="flex flex-wrap items-center gap-2"
                  data-testid="link-project"
                  onSubmit={(e) => {
                    e.preventDefault();
                    if (newProject) linkProject.mutate(Number(newProject));
                  }}
                >
                  <Select value={newProject || "__none"} onValueChange={(v) => setNewProject(v === "__none" ? "" : v)}>
                    <SelectTrigger className="h-8 w-[16rem]" aria-label="Project to link"><SelectValue placeholder="Link a project…" /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__none">Link a project…</SelectItem>
                      {(projectOptions.data?.items ?? [])
                        .filter((pr) => !r.projects.some((x) => x.id === pr.id))
                        .map((pr) => (
                          <SelectItem key={pr.id} value={String(pr.id)}>{pr.name} · {pr.workspaceName}</SelectItem>
                        ))}
                    </SelectContent>
                  </Select>
                  <Button type="submit" size="sm" variant="outline" className="h-8" disabled={!newProject || linkProject.isPending} data-testid="link-project-save">Link</Button>
                </form>
                )}
              </TabsContent>
              <TabsContent value="facts">
                {r.facts.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No commitments, decisions or prices were pulled from this call.</p>
                ) : (
                  <ul className="space-y-1.5">
                    {r.facts.map((f) => (
                      <li key={f.id}>
                        <button
                          type="button"
                          onClick={() => f.quoteStartSec != null && seek(f.quoteStartSec)}
                          disabled={f.quoteStartSec == null}
                          className="flex w-full items-start gap-3 rounded-md border px-3 py-2 text-left text-sm hover:bg-accent/50 disabled:hover:bg-transparent"
                        >
                          <span className="mt-0.5 w-11 shrink-0 text-xs tabular text-muted-foreground">{f.quoteStartSec != null ? formatTimestamp(f.quoteStartSec) : ""}</span>
                          <span className="min-w-0 flex-1">
                            <span className="mr-2 inline-block"><Badge variant={f.status === "open" ? "warning" : "muted"}>{f.kind}</Badge></span>
                            {f.text}
                            {(f.ownerParty || f.dueDate) && (
                              <span className="mt-0.5 block text-xs text-muted-foreground">
                                {f.ownerParty?.name}
                                {f.ownerParty && f.dueDate ? " · " : ""}
                                {f.dueDate ? `due ${f.dueDate}` : ""}
                              </span>
                            )}
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </TabsContent>
              <TabsContent value="clips">
                {r.clips.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No clip candidates yet. Scouting runs after transcription.</p>
                ) : (
                  <ul className="space-y-2">
                    {r.clips.map((c) => (
                      <li key={c.id} className="rounded-md border p-3" data-testid="clip" data-status={c.status}>
                        <div className="flex items-start gap-3">
                          <button type="button" onClick={() => seek(c.startSec)} className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-xs tabular hover:bg-accent" aria-label={`Play clip from ${formatTimestamp(c.startSec)}`}>
                            {formatTimestamp(c.startSec)}–{formatTimestamp(c.endSec)}
                          </button>
                          <div className="min-w-0 flex-1">
                            <p className="text-sm font-medium">{c.hook ?? "Clip"}</p>
                            {c.why && <p className="mt-0.5 text-xs text-muted-foreground">{c.why}</p>}
                          </div>
                          <Badge variant={c.status === "approved" ? "success" : c.status === "rejected" ? "muted" : c.status === "cut" ? "default" : "outline"} className="shrink-0" data-testid="clip-status">
                            {c.status === "new" ? `score ${c.score}` : c.status}
                          </Badge>
                        </div>
                        {c.clipMediaId ? (

                          <div className="mt-2">

                            <Button size="sm" variant="outline" onClick={() => api<{ url: string }>(`/clips/${c.id}/download`).then((d) => window.open(d.url, "_blank", "noopener"))} data-testid="download-clip">

                              <Download /> Download clip

                            </Button>

                          </div>

                        ) : null}
                        {owner && c.status !== "cut" && (
                          <div className="mt-2 flex gap-2">
                            <Button size="sm" variant={c.status === "approved" ? "secondary" : "outline"} disabled={c.status === "approved" || clipStatus.isPending} onClick={() => clipStatus.mutate({ clipId: c.id, status: "approved" })} data-testid="approve-clip">
                              <ThumbsUp /> Approve
                            </Button>
                            <Button size="sm" variant={c.status === "rejected" ? "secondary" : "outline"} disabled={c.status === "rejected" || clipStatus.isPending} onClick={() => clipStatus.mutate({ clipId: c.id, status: "rejected" })} data-testid="reject-clip">
                              <ThumbsDown /> Reject
                            </Button>
                          </div>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </TabsContent>
              <TabsContent value="details">
                <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-sm">
                  <dt className="text-muted-foreground">Source</dt>
                  <dd className="min-w-0">
                    {r.source ? SOURCE_LABEL[r.source] ?? r.source : "—"}
                    {r.vaultId && <span className="ml-2 break-all text-xs text-muted-foreground">vault {r.vaultId}</span>}
                  </dd>
                  <dt className="text-muted-foreground">Pipeline</dt>
                  <dd className="min-w-0">{statusLabel(r.pipelineStatus)}{r.pipelineError && <span className="ml-2 text-destructive">{r.pipelineError}</span>}</dd>
                  <dt className="text-muted-foreground">Transcript</dt>
                  <dd className="min-w-0">
                    {r.transcript
                      ? `${r.transcript.source}${r.transcript.model ? ` · ${r.transcript.model}` : ""} · ${r.transcript.segmentCount ?? r.segmentCount} lines${r.transcript.wordCount ? ` · ${r.transcript.wordCount.toLocaleString()} words` : ""}`
                      : r.segmentCount ? `${r.segmentCount} lines` : "none yet"}
                  </dd>
                  {r.originalFilename && (
                    <>
                      <dt className="text-muted-foreground">Original file</dt>
                      <dd className="min-w-0 break-all">{r.originalFilename}</dd>
                    </>
                  )}
                </dl>
                <h3 className="mb-1.5 mt-4 text-sm font-medium">Files</h3>
                {r.files.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No stored files.</p>
                ) : (
                  <ul className="divide-y rounded-lg border text-sm">
                    {r.files.map((f) => (
                      <li key={f.id} className="grid gap-x-3 gap-y-0.5 px-3 py-2 sm:grid-cols-[auto_minmax(0,1fr)_auto]">
                        <span className="flex items-center gap-1.5">
                          <Film className={cn("h-3.5 w-3.5", f.playable ? "text-primary" : "text-muted-foreground")} aria-hidden />
                          <Badge variant="outline" className="uppercase tracking-wide">{f.storage}</Badge>
                          {f.role && <span className="text-xs text-muted-foreground">{f.role}</span>}
                          {f.kind && f.kind !== "video" && <span className="text-xs text-muted-foreground">{f.kind}</span>}
                        </span>
                        <span className="min-w-0 break-all font-mono text-xs text-muted-foreground" title={f.storageKey}>
                          {f.bucket ? `${f.bucket}/` : ""}{f.storageKey}
                        </span>
                        <span className="text-xs tabular text-muted-foreground sm:text-right">
                          {formatBytes(f.bytes)}{f.status ? ` · ${f.status}` : ""}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
                {r.jobs.length > 0 && (
                  <>
                    <h3 className="mb-1.5 mt-4 text-sm font-medium">Processing jobs</h3>
                    <ul className="divide-y rounded-lg border text-sm">
                      {r.jobs.map((j) => (
                        <li key={j.id} className="flex flex-wrap items-center gap-x-3 gap-y-0.5 px-3 py-2">
                          <span className="font-medium">{j.stage}</span>
                          <Badge variant={j.status === "done" ? "success" : j.status === "failed" ? "destructive" : j.status === "running" ? "warning" : "muted"}>{j.status}</Badge>
                          {j.attempts ? <span className="text-xs tabular text-muted-foreground">{j.attempts} attempt{j.attempts === 1 ? "" : "s"}</span> : null}
                          {j.error && <span className="w-full text-xs text-destructive">{j.error}</span>}
                        </li>
                      ))}
                    </ul>
                  </>
                )}
              </TabsContent>
            </Tabs>
          )}
        </div>

        {/* Right column: transcript (desktop only; on phones it is the first tab above). */}
        {isDesktop && (
          <section aria-label="Transcript" className="min-w-0 rounded-lg border bg-card">
            {transcript}
          </section>
        )}
      </div>
    </div>
  );
}

function Count({ n }: { n: number }) {
  if (!n) return null;
  return <span className="ml-0.5 rounded-full bg-foreground/10 px-1.5 text-[11px] tabular">{n}</span>;
}
