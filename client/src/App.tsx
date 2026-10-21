import { Navigate, Outlet, Route, Routes, useLocation } from "react-router-dom";
import { useMe } from "@/hooks/useAuth";
import { TopBar } from "@/components/TopBar";
import { UploadDialog } from "@/components/upload/UploadDialog";
import { UploadTray } from "@/components/upload/UploadTray";
import LoginPage from "@/pages/LoginPage";
import LibraryPage from "@/pages/LibraryPage";
import RecordingPage from "@/pages/RecordingPage";
import SearchPage from "@/pages/SearchPage";
import PersonPage from "@/pages/PersonPage";
import NotFoundPage from "@/pages/NotFoundPage";
import { Skeleton } from "@/components/ui/skeleton";

function RequireAuth() {
  const me = useMe();
  const location = useLocation();
  if (me.isPending) {
    return (
      <div className="min-h-screen">
        <div className="h-14 border-b" />
        <div className="mx-auto max-w-7xl px-4 py-8 space-y-4">
          <Skeleton className="h-8 w-48" />
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {Array.from({ length: 8 }).map((_, i) => (
              <Skeleton key={i} className="h-40" />
            ))}
          </div>
        </div>
      </div>
    );
  }
  if (!me.data) return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />;
  return (
    <div className="min-h-screen flex flex-col">
      <TopBar user={me.data.user} />
      <main className="flex-1">
        <Outlet />
      </main>
      <UploadDialog />
      <UploadTray />
    </div>
  );
}

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route element={<RequireAuth />}>
        <Route path="/" element={<LibraryPage />} />
        <Route path="/r/:id" element={<RecordingPage />} />
        <Route path="/search" element={<SearchPage />} />
        <Route path="/p/:id" element={<PersonPage />} />
        <Route path="*" element={<NotFoundPage />} />
      </Route>
    </Routes>
  );
}
