import { BrowserRouter, Navigate, Route, Routes } from "react-router";
import { AppLayout } from "@/components/layout/AppLayout";
import { RequireAuth } from "@/components/layout/RequireAuth";
import { SignInPage } from "@/features/auth/SignInPage";
import { SignUpPage } from "@/features/auth/SignUpPage";
import { ProjectDetailPage } from "@/features/projects/ProjectDetailPage";
import { ProjectFormPage } from "@/features/projects/ProjectFormPage";
import { ProjectsPage } from "@/features/projects/ProjectsPage";
import { UsersPage } from "@/features/users/UsersPage";
import { AuthProvider } from "@/lib/auth";
import { NotFoundPage } from "@/pages/NotFoundPage";

/** Every screen and its address. Add a resource's screens next to the projects routes. */
export function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <Routes>
          <Route path="/sign-in" element={<SignInPage />} />
          <Route path="/sign-up" element={<SignUpPage />} />
          <Route
            element={
              <RequireAuth>
                <AppLayout />
              </RequireAuth>
            }
          >
            <Route index element={<Navigate to="/projects" replace />} />
            <Route path="projects" element={<ProjectsPage />} />
            <Route path="projects/new" element={<ProjectFormPage />} />
            <Route path="projects/:id" element={<ProjectDetailPage />} />
            <Route path="projects/:id/edit" element={<ProjectFormPage />} />
            <Route
              path="users"
              element={
                <RequireAuth role="admin">
                  <UsersPage />
                </RequireAuth>
              }
            />
          </Route>
          <Route path="*" element={<NotFoundPage />} />
        </Routes>
      </AuthProvider>
    </BrowserRouter>
  );
}
