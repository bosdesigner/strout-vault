import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { Pencil } from "lucide-react";
import { cn } from "@/lib/utils";

interface Props {
  value: string;
  onSave: (v: string) => Promise<unknown> | void;
  as?: "h1" | "span";
  className?: string;
  inputClassName?: string;
  placeholder?: string;
  label: string;
  testId?: string;
}

/** Click (or press Enter) to edit in place; Enter saves, Escape cancels. */
export function InlineEdit({ value, onSave, as = "span", className, inputClassName, placeholder, label, testId }: Props) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const [saving, setSaving] = useState(false);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => setDraft(value), [value]);
  useEffect(() => {
    if (editing) {
      ref.current?.focus();
      ref.current?.select();
    }
  }, [editing]);

  const commit = async () => {
    const v = draft.trim();
    setEditing(false);
    if (!v || v === value) {
      setDraft(value);
      return;
    }
    setSaving(true);
    try {
      await onSave(v);
    } finally {
      setSaving(false);
    }
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") void commit();
    if (e.key === "Escape") {
      setDraft(value);
      setEditing(false);
    }
  };

  if (editing) {
    return (
      <input
        ref={ref}
        aria-label={label}
        value={draft}
        placeholder={placeholder}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => void commit()}
        onKeyDown={onKey}
        data-testid={testId ? `${testId}-input` : undefined}
        className={cn("w-full rounded-md border border-input bg-background px-2 py-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring", inputClassName)}
      />
    );
  }
  const Tag = as;
  return (
    <button
      type="button"
      onClick={() => setEditing(true)}
      aria-label={`Edit ${label.toLowerCase()}`}
      data-testid={testId}
      className={cn("group inline-flex max-w-full items-start gap-2 rounded-md text-left hover:bg-accent/60 -mx-1 px-1", saving && "opacity-60")}
    >
      <Tag className={cn("min-w-0 break-words", className)}>{value || <span className="text-muted-foreground">{placeholder}</span>}</Tag>
      <Pencil className="mt-1.5 h-3.5 w-3.5 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100" aria-hidden />
    </button>
  );
}
