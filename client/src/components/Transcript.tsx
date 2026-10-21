import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { ArrowDownToLine, ChevronDown, ChevronUp, Search, X } from "lucide-react";
import type { TranscriptLine } from "@shared/types";
import { formatTimestamp } from "@/lib/format";
import { cn } from "@/lib/utils";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";

interface Props {
  lines: TranscriptLine[] | undefined;
  anchored: boolean;
  currentTime: number;
  onSeek: (sec: number) => void;
  /** Segment to flash + scroll to (from ?t= or a search hit). */
  initialSeconds?: number | null;
}

/** Index of the line playing at `t` (last line whose start <= t). */
export function lineIndexAt(lines: TranscriptLine[], t: number): number {
  let lo = 0;
  let hi = lines.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (lines[mid].startSec <= t + 0.05) {
      ans = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return ans;
}

export function Transcript({ lines, anchored, currentTime, onSeek, initialSeconds }: Props) {
  const [find, setFind] = useState("");
  const [findOpen, setFindOpen] = useState(false);
  const [matchPos, setMatchPos] = useState(0);
  const [follow, setFollow] = useState(true);
  const listRef = useRef<HTMLOListElement>(null);
  const findRef = useRef<HTMLInputElement>(null);
  const programmaticScroll = useRef(false);

  const current = useMemo(() => (lines && anchored ? lineIndexAt(lines, currentTime) : -1), [lines, anchored, currentTime]);
  const matches = useMemo(() => {
    const term = find.trim().toLowerCase();
    if (!term || !lines) return [];
    return lines.map((l, i) => (l.text.toLowerCase().includes(term) || (l.speaker ?? "").toLowerCase().includes(term) ? i : -1)).filter((i) => i >= 0);
  }, [find, lines]);
  const matchSet = useMemo(() => new Set(matches), [matches]);
  useEffect(() => setMatchPos(0), [find]);

  const scrollTo = useCallback((idx: number, behavior: ScrollBehavior = "smooth") => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-idx="${idx}"]`);
    if (!el) return;
    programmaticScroll.current = true;
    el.scrollIntoView({ block: "center", behavior });
    window.setTimeout(() => (programmaticScroll.current = false), 600);
  }, []);

  // Follow playback.
  useEffect(() => {
    if (follow && current >= 0) scrollTo(current);
  }, [current, follow, scrollTo]);

  // Jump to the initial line once lines are loaded.
  const didInitial = useRef(false);
  useLayoutEffect(() => {
    if (didInitial.current || !lines?.length || initialSeconds == null) return;
    didInitial.current = true;
    const idx = lineIndexAt(lines, initialSeconds);
    if (idx >= 0) scrollTo(idx, "auto");
  }, [lines, initialSeconds, scrollTo]);

  // Jump to current find match.
  useEffect(() => {
    if (matches.length) scrollTo(matches[Math.min(matchPos, matches.length - 1)]);
  }, [matchPos, matches, scrollTo]);

  // A manual scroll pauses following until the user clicks a line or "Follow".
  useEffect(() => {
    const onWheel = () => {
      if (!programmaticScroll.current) setFollow(false);
    };
    window.addEventListener("wheel", onWheel, { passive: true });
    window.addEventListener("touchmove", onWheel, { passive: true });
    return () => {
      window.removeEventListener("wheel", onWheel);
      window.removeEventListener("touchmove", onWheel);
    };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "f" && lines?.length) {
        e.preventDefault();
        setFindOpen(true);
        setTimeout(() => findRef.current?.focus(), 0);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [lines]);

  const onLineKey = (e: React.KeyboardEvent<HTMLOListElement>) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    const active = document.activeElement as HTMLElement | null;
    const idx = Number(active?.closest("[data-idx]")?.getAttribute("data-idx"));
    if (!Number.isInteger(idx)) return;
    e.preventDefault();
    const next = idx + (e.key === "ArrowDown" ? 1 : -1);
    listRef.current?.querySelector<HTMLElement>(`[data-idx="${next}"] button`)?.focus();
  };

  if (!lines) {
    return (
      <div className="space-y-3 p-4" aria-busy="true" aria-label="Loading transcript">
        {Array.from({ length: 14 }).map((_, i) => (
          <div key={i} className="flex gap-3">
            <Skeleton className="h-4 w-10" />
            <div className="flex-1 space-y-1.5">
              <Skeleton className="h-3 w-24" />
              <Skeleton className={cn("h-4", i % 3 === 0 ? "w-11/12" : i % 3 === 1 ? "w-2/3" : "w-4/5")} />
            </div>
          </div>
        ))}
      </div>
    );
  }
  if (lines.length === 0) {
    return (
      <div className="p-8 text-center text-sm text-muted-foreground">
        <p className="font-medium text-foreground">No transcript yet</p>
        <p className="mt-1">It will appear here once processing finishes.</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col">
      <div className="lg:sticky lg:top-14 z-10 flex items-center gap-2 border-b bg-background/95 px-3 py-2 backdrop-blur">
        {findOpen ? (
          <>
            <div className="relative flex-1">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                ref={findRef}
                aria-label="Find in transcript"
                placeholder="Find in transcript"
                className="h-8 pl-8 pr-20"
                value={find}
                onChange={(e) => setFind(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") setMatchPos((p) => (matches.length ? (p + (e.shiftKey ? matches.length - 1 : 1)) % matches.length : 0));
                  if (e.key === "Escape") {
                    setFind("");
                    setFindOpen(false);
                  }
                }}
                autoFocus
              />
              {find && (
                <span className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-xs text-muted-foreground tabular" data-testid="find-count">
                  {matches.length ? `${Math.min(matchPos + 1, matches.length)} / ${matches.length}` : "0"}
                </span>
              )}
            </div>
            <Button variant="ghost" size="icon-sm" aria-label="Previous match" disabled={!matches.length} onClick={() => setMatchPos((p) => (p + matches.length - 1) % matches.length)}>
              <ChevronUp className="h-4 w-4" />
            </Button>
            <Button variant="ghost" size="icon-sm" aria-label="Next match" disabled={!matches.length} onClick={() => setMatchPos((p) => (p + 1) % matches.length)}>
              <ChevronDown className="h-4 w-4" />
            </Button>
            <Button variant="ghost" size="icon-sm" aria-label="Close find" onClick={() => { setFind(""); setFindOpen(false); }}>
              <X className="h-4 w-4" />
            </Button>
          </>
        ) : (
          <>
            <Button variant="outline" size="sm" className="h-8" onClick={() => setFindOpen(true)} data-testid="find-open">
              <Search className="h-3.5 w-3.5" /> Find in transcript
            </Button>
            <span className="ml-auto text-xs text-muted-foreground tabular">{lines.length} lines</span>
            {anchored && !follow && (
              <Button variant="ghost" size="sm" className="h-8" onClick={() => { setFollow(true); if (current >= 0) scrollTo(current); }}>
                <ArrowDownToLine className="h-3.5 w-3.5" /> Follow
              </Button>
            )}
          </>
        )}
      </div>
      <ol ref={listRef} className="px-2 py-2" aria-label="Transcript" onKeyDown={onLineKey}>
        {lines.map((l, i) => (
          <Line
            key={l.id}
            line={l}
            idx={i}
            anchored={anchored}
            active={i === current}
            matched={matchSet.has(i)}
            focusedMatch={matches.length > 0 && matches[Math.min(matchPos, matches.length - 1)] === i}
            onSeek={(s) => {
              setFollow(true);
              onSeek(s);
            }}
          />
        ))}
      </ol>
    </div>
  );
}

const Line = memo(function Line({ line, idx, anchored, active, matched, focusedMatch, onSeek }: { line: TranscriptLine; idx: number; anchored: boolean; active: boolean; matched: boolean; focusedMatch: boolean; onSeek: (s: number) => void }) {
  return (
    <li
      data-idx={idx}
      data-segment-id={line.id}
      data-active={active || undefined}
      className={cn(
        "group flex gap-3 rounded-md px-2 py-1.5 transition-colors",
        active && "bg-primary/10",
        matched && !active && "bg-amber-100/70 dark:bg-amber-500/15",
        focusedMatch && "ring-1 ring-amber-500/60",
      )}
    >
      <button
        type="button"
        onClick={() => onSeek(line.startSec)}
        disabled={!anchored}
        aria-label={`Jump to ${formatTimestamp(line.startSec)}`}
        className={cn("mt-0.5 h-5 shrink-0 w-12 text-left text-xs tabular text-muted-foreground hover:text-primary disabled:hover:text-muted-foreground disabled:cursor-default", active && "text-primary font-medium")}
      >
        {anchored ? formatTimestamp(line.startSec) : ""}
      </button>
      <div className="min-w-0 flex-1 text-sm leading-relaxed">
        {line.speaker && (
          <span className="mr-2 text-xs font-medium text-muted-foreground">
            {line.speakerPartyId ? (
              <Link to={`/p/${line.speakerPartyId}`} className="hover:text-primary hover:underline underline-offset-2">
                {line.speaker}
              </Link>
            ) : (
              line.speaker
            )}
          </span>
        )}
        <span className={cn(active && "text-foreground")}>{line.text}</span>
      </div>
    </li>
  );
});
