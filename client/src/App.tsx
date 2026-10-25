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
import PeoplePage from "@/pages/PeoplePage";
import ProjectsPage from "@/pages/ProjectsPage";
import ProjectPage from "@/pages/ProjectPage";
import ReviewPage from "@/pages/ReviewPage";
import AccessPage from "@/pages/AccessPage";
import PipelinePage from "@/pages/PipelinePage";
import ClipsPage from "@/pages/ClipsPage";
import AgentsPage from "@/pages/AgentsPage";
import { WorkspaceProvider } from "@/lib/workspace";
import { MobileNav } from "@/components/MobileNav";
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
    <WorkspaceProvider>
      <div className="min-h-screen flex flex-col">
        <TopBar user={me.data.user} />
        <main className={me.data.user.role === "owner" ? "flex-1 pb-16 lg:pb-0" : "flex-1"}>
          <Outlet />
        </main>
        <MobileNav owner={me.data.user.role === "owner"} />
        <UploadDialog />
        <UploadTray />
      </div>
    </WorkspaceProvider>
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
        <Route path="/people" element={<PeoplePage />} />
        <Route path="/p/:id" element={<PersonPage />} />
        <Route path="/projects" element={<ProjectsPage />} />
        <Route path="/projects/:id" element={<ProjectPage />} />
        <Route path="/review" element={<ReviewPage />} />
        <Route path="/access" element={<AccessPage />} />
        <Route path="/pipeline" element={<PipelinePage />} />
        <Route path="/clips" element={<ClipsPage />} />
        <Route path="/agents" element={<AgentsPage />} />
        <Route path="*" element={<NotFoundPage />} />
      </Route>
    </Routes>
  );
}
