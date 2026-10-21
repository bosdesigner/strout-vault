import { useSearchParams } from "react-router-dom";
import { X } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { PartyPicker } from "./PartyPicker";
import { SOURCE_LABEL } from "@/lib/format";

export interface LibraryFilterState {
  from: string;
  to: string;
  source: string;
  party: { id: number; name: string } | null;
  hasVideo: boolean;
}

export function readFilters(params: URLSearchParams): LibraryFilterState {
  const partyId = Number(params.get("party"));
  return {
    from: params.get("from") ?? "",
    to: params.get("to") ?? "",
    source: params.get("source") ?? "",
    party: partyId > 0 ? { id: partyId, name: params.get("partyName") ?? `#${partyId}` } : null,
    hasVideo: params.get("hasVideo") === "true",
  };
}

const ALL = "__all";
const YEARS = ["2026", "2025", "2024", "2023", "2022"];

export function LibraryFilters() {
  const [params, setParams] = useSearchParams();
  const f = readFilters(params);

  const update = (patch: Partial<Record<string, string | null>>) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) {
      if (v) next.set(k, v);
      else next.delete(k);
    }
    setParams(next, { replace: true });
  };
  const year = f.from.endsWith("-01-01") && f.to === `${f.from.slice(0, 4)}-12-31` ? f.from.slice(0, 4) : "";
  const active = Object.values(f).some((v) => (typeof v === "boolean" ? v : !!v));

  return (
    <div className="flex flex-wrap items-end gap-3" role="group" aria-label="Filters">
      <div className="space-y-1">
        <Label htmlFor="f-year" className="text-xs text-muted-foreground">Year</Label>
        <Select value={year || ALL} onValueChange={(v) => update(v === ALL ? { from: null, to: null } : { from: `${v}-01-01`, to: `${v}-12-31` })}>
          <SelectTrigger id="f-year" className="h-8 w-[7.5rem]" aria-label="Year">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>Any year</SelectItem>
            {YEARS.map((y) => (
              <SelectItem key={y} value={y}>{y}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="space-y-1">
        <Label htmlFor="f-from" className="text-xs text-muted-foreground">From</Label>
        <Input id="f-from" type="date" className="h-8 w-[9.5rem]" value={f.from} onChange={(e) => update({ from: e.target.value || null })} />
      </div>
      <div className="space-y-1">
        <Label htmlFor="f-to" className="text-xs text-muted-foreground">To</Label>
        <Input id="f-to" type="date" className="h-8 w-[9.5rem]" value={f.to} onChange={(e) => update({ to: e.target.value || null })} />
      </div>
      <div className="space-y-1">
        <Label htmlFor="f-source" className="text-xs text-muted-foreground">Source</Label>
        <Select value={f.source || ALL} onValueChange={(v) => update({ source: v === ALL ? null : v })}>
          <SelectTrigger id="f-source" className="h-8 w-[9rem]" aria-label="Source">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>Any source</SelectItem>
            {Object.entries(SOURCE_LABEL).map(([k, v]) => (
              <SelectItem key={k} value={k}>{v}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="space-y-1 min-w-[12rem] flex-1 max-w-xs">
        <Label htmlFor="f-person" className="text-xs text-muted-foreground">Person</Label>
        <PartyPicker
          id="f-person"
          multiple={false}
          placeholder="Anyone"
          value={f.party ? [f.party] : []}
          onChange={(v) => update(v[0] ? { party: String(v[0].id), partyName: v[0].name } : { party: null, partyName: null })}
        />
      </div>
      <label className="flex h-8 items-center gap-2 text-sm">
        <Checkbox checked={f.hasVideo} onCheckedChange={(c) => update({ hasVideo: c === true ? "true" : null })} aria-label="Has video" />
        Has video
      </label>
      {active && (
        <Button variant="ghost" size="sm" className="h-8 text-muted-foreground" onClick={() => setParams(new URLSearchParams(), { replace: true })}>
          <X className="h-3.5 w-3.5" /> Clear
        </Button>
      )}
    </div>
  );
}
