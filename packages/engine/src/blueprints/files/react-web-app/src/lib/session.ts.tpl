import { createApiClient } from "./api";

/**
 * The signed-in session: the access token in localStorage, and the one API client the app uses.
 * When the API answers 401 the token is dropped and listeners (the AuthProvider) are told.
 */

const KEY = "app.token";
const listeners = new Set<() => void>();

function read(): string | null {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
}

export const session = {
  token: read(),
  set(token: string | null) {
    this.token = token;
    try {
      if (token) localStorage.setItem(KEY, token);
      else localStorage.removeItem(KEY);
    } catch {
      // Private windows may block storage: the session then lasts until the tab closes.
    }
    for (const l of listeners) l();
  },
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
};

export const api = createApiClient({
  baseUrl: import.meta.env.VITE_API_URL ?? "",
  getToken: () => session.token,
  onUnauthorized: () => session.set(null),
});
