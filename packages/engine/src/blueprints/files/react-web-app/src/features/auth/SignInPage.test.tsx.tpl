import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthProvider } from "@/lib/auth";
import { session } from "@/lib/session";
import { SignInPage } from "./SignInPage";

function show() {
  return render(
    <MemoryRouter initialEntries={["/sign-in"]}>
      <AuthProvider>
        <Routes>
          <Route path="/sign-in" element={<SignInPage />} />
          <Route path="/" element={<p>Home screen</p>} />
        </Routes>
      </AuthProvider>
    </MemoryRouter>,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  session.set(null);
});

describe("SignInPage", () => {
  it("labels its fields and explains what is missing", async () => {
    show();
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    const email = screen.getByLabelText("Email");
    expect(email.getAttribute("aria-invalid")).toBe("true");
    expect(screen.getByText("Enter your email address.")).toBeTruthy();
    expect(screen.getByText("Enter your password.")).toBeTruthy();
  });

  it("signs in, keeps the token and opens the app", async () => {
    const user = { id: 1, email: "ana@example.com", name: "Ana", role: "user", created_at: "2026-01-01" };
    const fetch = vi.fn(async () =>
      new Response(JSON.stringify({ access_token: "tok", token_type: "bearer", expires_in: 3600, user }), {
        status: 200,
      }),
    );
    vi.stubGlobal("fetch", fetch);
    show();
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "ana@example.com" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "correct horse" } });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect(await screen.findByText("Home screen")).toBeTruthy();
    expect(session.token).toBe("tok");
    expect((fetch.mock.calls[0] as unknown as [string])[0]).toBe("/api/auth/login");
  });

  it("shows the server's message when the password is wrong", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ error: { code: "unauthorized", message: "Wrong email or password." } }), {
          status: 401,
        }),
      ),
    );
    show();
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "ana@example.com" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "nope" } });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe("Wrong email or password."));
    expect(session.token).toBeNull();
  });
});
