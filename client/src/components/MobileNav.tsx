import { NavLink } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { ClipboardCheck, FolderKanban, LayoutGrid, Users } from "lucide-react";
import { api } from "@/lib/api";
import { useWorkspace } from "@/lib/workspace";
import { cn } from "@/lib/utils";

/** Bottom tab bar for phones and tablets; the desktop nav lives in the top bar. */
export function MobileNav({ owner }: { owner: boolean }) {
  const { param } = useWorkspace();
  const reviewCount = useQuery({
    queryKey: ["review-count", param],
    queryFn: () => api<{ openCount: number }>(`/review/count?${param.slice(1)}`),
    refetchInterval: 60_000,
    staleTime: 30_000,
    enabled: owner,
  });
  if (!owner) return null;
  const items = [
    { to: "/", label: "Library", icon: LayoutGrid, end: true },
    { to: "/people", label: "People", icon: Users },
    { to: "/projects", label: "Projects", icon: FolderKanban },
    { to: "/review", label: "Review", icon: ClipboardCheck, badge: reviewCount.data?.openCount },
  ];
  return (
    <nav aria-label="Primary" className="fixed inset-x-0 bottom-0 z-40 border-t bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/85 lg:hidden safe-bottom">
      <ul className="mx-auto grid max-w-md grid-cols-4">
        {items.map((it) => (
          <li key={it.to}>
            <NavLink
              to={it.to}
              end={it.end}
              className={({ isActive }) =>
                cn("relative flex h-14 flex-col items-center justify-center gap-0.5 text-[11px] font-medium text-muted-foreground", isActive && "text-primary")
              }
            >
              <it.icon className="h-5 w-5" aria-hidden />
              {it.label}
              {!!it.badge && (
                <span className="absolute right-[calc(50%-1.6rem)] top-1.5 rounded-full bg-primary px-1.5 text-[10px] font-semibold leading-4 text-primary-foreground tabular">{it.badge}</span>
              )}
            </NavLink>
          </li>
        ))}
      </ul>
    </nav>
  );
}
