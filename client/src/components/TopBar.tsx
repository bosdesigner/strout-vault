import { useEffect, useRef, useState, type FormEvent } from "react";
import { Link, useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { LogOut, Moon, Search, Sun, Upload, Vault } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useLogout } from "@/hooks/useAuth";
import { useTheme } from "@/lib/theme";
import { uploadStore, useUploads, uploadsInProgress } from "@/lib/uploads";

export function TopBar({ user }: { user: { email: string } }) {
  const navigate = useNavigate();
  const location = useLocation();
  const [params] = useSearchParams();
  const [q, setQ] = useState(params.get("q") ?? "");
  const inputRef = useRef<HTMLInputElement>(null);
  const logout = useLogout();
  const { isDark, toggle } = useTheme();
  const uploads = useUploads();
  const busy = uploadsInProgress(uploads.items);

  // Keep the box in sync with the URL when navigating between searches.
  useEffect(() => {
    if (location.pathname === "/search") setQ(params.get("q") ?? "");
  }, [location.pathname, params]);

  // "/" focuses search from anywhere (unless already typing).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "/" || e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      const tag = t?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || t?.isContentEditable) return;
      e.preventDefault();
      inputRef.current?.focus();
      inputRef.current?.select();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const term = q.trim();
    if (!term) return;
    navigate(`/search?q=${encodeURIComponent(term)}`);
  };

  return (
    <header className="sticky top-0 z-40 border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80">
      <div className="mx-auto flex h-14 max-w-7xl items-center gap-2 px-4 sm:gap-3">
        <Link to="/" className="flex shrink-0 items-center gap-2 font-semibold tracking-tight" aria-label="Strout Vault home">
          <Vault className="h-5 w-5 text-primary" />
          <span className="hidden md:inline">Strout Vault</span>
        </Link>
        <form onSubmit={submit} role="search" className="relative mx-auto min-w-0 flex-1 max-w-xl">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            ref={inputRef}
            type="search"
            name="q"
            aria-label="Search transcripts"
            placeholder="Search transcripts"
            className="pl-9"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
          <kbd className="pointer-events-none absolute right-2.5 top-1/2 hidden -translate-y-1/2 rounded border bg-muted px-1.5 text-[11px] text-muted-foreground sm:inline-block">/</kbd>
        </form>
        <div className="flex shrink-0 items-center gap-1">
          <Button onClick={() => uploadStore.openDialog()} size="sm" className="gap-1.5 px-2.5 sm:px-3" data-testid="upload-button" aria-label="Upload">
            <Upload className="h-4 w-4" />
            <span className="hidden sm:inline">Upload</span>
            {busy > 0 && <span className="rounded-full bg-primary-foreground/20 px-1.5 text-[11px] tabular">{busy}</span>}
          </Button>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon" onClick={toggle} aria-label={isDark ? "Switch to light mode" : "Switch to dark mode"} className="hidden sm:inline-flex">
                {isDark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
              </Button>
            </TooltipTrigger>
            <TooltipContent>{isDark ? "Light mode" : "Dark mode"}</TooltipContent>
          </Tooltip>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" aria-label="Account menu">
                <span className="flex h-7 w-7 items-center justify-center rounded-full bg-muted text-xs font-medium uppercase">{user.email.slice(0, 1)}</span>
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuLabel className="max-w-[14rem] truncate">{user.email}</DropdownMenuLabel>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={toggle} className="sm:hidden">
                {isDark ? <Sun /> : <Moon />} {isDark ? "Light mode" : "Dark mode"}
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => logout.mutate(undefined, { onSettled: () => navigate("/login") })}>
                <LogOut /> Sign out
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
    </header>
  );
}
