import { useState } from "react";
import { Plus, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";

export function TagEditor({ tags, onChange }: { tags: string[]; onChange: (tags: string[]) => Promise<unknown> | void }) {
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState("");
  const add = () => {
    const t = draft.trim().toLowerCase();
    setDraft("");
    setAdding(false);
    if (t && !tags.includes(t)) void onChange([...tags, t]);
  };
  return (
    <div className="flex flex-wrap items-center gap-1.5" data-testid="tags">
      {tags.map((t) => (
        <Badge key={t} variant="secondary" className="pr-1">
          {t}
          <button type="button" aria-label={`Remove tag ${t}`} className="rounded-full p-0.5 hover:bg-foreground/10" onClick={() => void onChange(tags.filter((x) => x !== t))}>
            <X className="h-3 w-3" />
          </button>
        </Badge>
      ))}
      {adding ? (
        <input
          autoFocus
          aria-label="New tag"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={add}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === ",") {
              e.preventDefault();
              add();
            }
            if (e.key === "Escape") {
              setDraft("");
              setAdding(false);
            }
          }}
          className="h-6 w-28 rounded-full border border-input bg-background px-2 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          placeholder="tag"
        />
      ) : (
        <button type="button" onClick={() => setAdding(true)} className="inline-flex h-6 items-center gap-1 rounded-full border border-dashed px-2 text-xs text-muted-foreground hover:border-foreground/40 hover:text-foreground" aria-label="Add tag">
          <Plus className="h-3 w-3" /> tag
        </button>
      )}
    </div>
  );
}
