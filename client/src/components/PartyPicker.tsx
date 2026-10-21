import { useEffect, useId, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Check, User, Building2, X } from "lucide-react";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import { Input } from "@/components/ui/input";
import type { ParticipantRef, PartySuggestion } from "@shared/types";

interface Props {
  value: ParticipantRef[];
  onChange: (v: ParticipantRef[]) => void;
  multiple?: boolean;
  placeholder?: string;
  id?: string;
  className?: string;
  /** Restrict suggestions to people or organizations. */
  kind?: "person" | "org";
}

/** Type-ahead over parties. Selected people show as removable chips. */
export function PartyPicker({ value, onChange, multiple = true, placeholder = "Add a person…", id, className, kind }: Props) {
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const listId = useId();
  const wrapRef = useRef<HTMLDivElement>(null);
  const { data } = useQuery({
    queryKey: ["parties", q, kind ?? ""],
    queryFn: () => api<{ items: PartySuggestion[] }>(`/parties?q=${encodeURIComponent(q)}&limit=8${kind ? `&kind=${kind}` : ""}`),
    enabled: open,
    staleTime: 60_000,
  });
  const items = (data?.items ?? []).filter((s) => !value.some((v) => v.id === s.id));

  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);

  const select = (s: PartySuggestion) => {
    onChange(multiple ? [...value, { id: s.id, name: s.name }] : [{ id: s.id, name: s.name }]);
    setQ("");
    setOpen(multiple);
    setActive(0);
  };

  return (
    <div ref={wrapRef} className={cn("relative", className)}>
      <div className="flex flex-wrap items-center gap-1.5">
        {value.map((p) => (
          <span key={p.id} className="inline-flex items-center gap-1 rounded-full bg-secondary px-2 py-0.5 text-xs">
            {p.name}
            <button type="button" aria-label={`Remove ${p.name}`} className="rounded-full hover:bg-foreground/10 p-0.5" onClick={() => onChange(value.filter((v) => v.id !== p.id))}>
              <X className="h-3 w-3" />
            </button>
          </span>
        ))}
        {(multiple || value.length === 0) && (
          <Input
            id={id}
            role="combobox"
            aria-expanded={open}
            aria-controls={listId}
            aria-autocomplete="list"
            autoComplete="off"
            placeholder={placeholder}
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              setOpen(true);
              setActive(0);
            }}
            onFocus={() => setOpen(true)}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setOpen(true);
                setActive((a) => Math.min(a + 1, items.length - 1));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setActive((a) => Math.max(a - 1, 0));
              } else if (e.key === "Enter" && open && items[active]) {
                e.preventDefault();
                select(items[active]);
              } else if (e.key === "Escape") {
                setOpen(false);
              } else if (e.key === "Backspace" && !q && value.length) {
                onChange(value.slice(0, -1));
              }
            }}
            className="h-8 flex-1 min-w-[8rem]"
          />
        )}
      </div>
      {open && (
        <ul id={listId} role="listbox" className="absolute left-0 right-0 z-30 mt-1 max-h-64 overflow-auto rounded-md border bg-popover p-1 text-sm shadow-md">
          {items.length === 0 && <li className="px-2 py-1.5 text-muted-foreground">{q ? "No one matches" : "Type a name"}</li>}
          {items.map((s, i) => (
            <li
              key={s.id}
              role="option"
              aria-selected={i === active}
              className={cn("flex cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5", i === active && "bg-accent text-accent-foreground")}
              onMouseEnter={() => setActive(i)}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => select(s)}
            >
              {s.kind === "org" ? <Building2 className="h-4 w-4 text-muted-foreground" /> : <User className="h-4 w-4 text-muted-foreground" />}
              <span className="flex-1 truncate">
                {s.name}
                {s.detail && <span className="ml-2 text-xs text-muted-foreground">{s.detail}</span>}
              </span>
              {i === active && <Check className="h-4 w-4 opacity-60" />}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
