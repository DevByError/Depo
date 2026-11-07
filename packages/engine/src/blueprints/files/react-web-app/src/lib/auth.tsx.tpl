import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { api, session } from "./session";

export type Role = "user" | "admin";

export interface User {
  id: number;
  email: string;
  name: string;
  role: Role;
  created_at: string;
}

interface TokenResponse {
  access_token: string;
  token_type: "bearer";
  expires_in: number;
  user: User;
}

export type AuthStatus = "loading" | "signed-in" | "signed-out";

interface AuthValue {
  status: AuthStatus;
  user: User | null;
  signIn(email: string, password: string): Promise<void>;
  signUp(name: string, email: string, password: string): Promise<void>;
  signOut(): void;
}

const AuthContext = createContext<AuthValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [status, setStatus] = useState<AuthStatus>(session.token ? "loading" : "signed-out");

  // A saved token: ask the API who it belongs to. A 401 clears it (see session.ts).
  useEffect(() => {
    if (!session.token) return;
    const controller = new AbortController();
    api
      .get<User>("/api/auth/me", undefined, controller.signal)
      .then((me) => {
        setUser(me);
        setStatus("signed-in");
      })
      .catch(() => {
        if (controller.signal.aborted) return;
        session.set(null);
      });
    return () => controller.abort();
  }, []);

  useEffect(
    () =>
      session.subscribe(() => {
        if (!session.token) {
          setUser(null);
          setStatus("signed-out");
        }
      }),
    [],
  );

  const accept = useCallback((r: TokenResponse) => {
    session.set(r.access_token);
    setUser(r.user);
    setStatus("signed-in");
  }, []);

  const value = useMemo<AuthValue>(
    () => ({
      status,
      user,
      signIn: async (email, password) => accept(await api.post<TokenResponse>("/api/auth/login", { email, password })),
      signUp: async (name, email, password) =>
        accept(await api.post<TokenResponse>("/api/auth/signup", { name, email, password })),
      signOut: () => session.set(null),
    }),
    [status, user, accept],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthValue {
  const value = useContext(AuthContext);
  if (!value) throw new Error("useAuth must be used inside <AuthProvider>.");
  return value;
}
