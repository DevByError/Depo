import type { DevDbInfo } from "@depo/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { useEngine } from "@/store/engine";

const calls: { method: string; params: unknown }[] = [];
const responses: Record<string, (p: unknown) => unknown> = {};
vi.mock("@/lib/engine", () => ({
  call: (method: string, params: unknown) => {
    calls.push({ method, params });
    const f = responses[method];
    if (!f) return Promise.reject(new Error(`unmocked ${method}`));
    return Promise.resolve(f(params));
  },
}));
vi.mock("@/lib/query", async () => {
  const { QueryClient: QC } = await import("@tanstack/react-query");
  return { queryClient: new QC({ defaultOptions: { queries: { retry: false } } }) };
});

import { TestDatabaseCard } from "./TestDatabaseCard";

function wrap(node: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{node}</QueryClientProvider>);
}

const base: DevDbInfo = {
  projectId: "prj_1",
  state: "stopped",
  engine: null,
  version: null,
  port: null,
  database: null,
  user: null,
  password: null,
  url: null,
  dataDir: null,
  message: null,
};
const running: DevDbInfo = {
  ...base,
  state: "running",
  engine: "mariadb",
  version: "11.4.5",
  port: 3307,
  database: "login_demo",
  user: "app",
  password: "Xk29abc",
  url: "mysql://app:Xk29abc@127.0.0.1:3307/login_demo",
};

beforeEach(() => {
  useEngine.setState({ status: "open" } as never);
  calls.length = 0;
  for (const k of Object.keys(responses)) delete responses[k];
});
afterEach(cleanup);

test("a new project: create and start it with one click", async () => {
  let info = base;
  responses["devdb.status"] = () => info;
  responses["devdb.start"] = () => {
    info = running;
    return running;
  };
  wrap(<TestDatabaseCard projectId="prj_1" />);
  await screen.findByText(/Agents create it when your app needs MySQL/);
  fireEvent.click(screen.getByRole("button", { name: "Create and start" }));
  await screen.findByText("login_demo");
  expect(calls.some((c) => c.method === "devdb.start")).toBe(true);
  expect(screen.getByText(/MariaDB 11\.4\.5 · running on 127\.0\.0\.1:3307/)).toBeTruthy();
  expect(screen.getByText("Xk29abc")).toBeTruthy();
});

test("running: copy the address, stop it, or empty it after a confirmation", async () => {
  responses["devdb.status"] = () => running;
  responses["devdb.stop"] = () => ({ stopped: true });
  responses["devdb.reset"] = () => running;
  const write = vi.fn(async () => {});
  Object.assign(navigator, { clipboard: { writeText: write } });
  wrap(<TestDatabaseCard projectId="prj_1" />);
  fireEvent.click(await screen.findByRole("button", { name: "Copy the connection address (DATABASE_URL)" }));
  await waitFor(() => expect(write).toHaveBeenCalledWith(running.url));
  const confirm = vi.spyOn(window, "confirm").mockReturnValueOnce(false).mockReturnValueOnce(true);
  fireEvent.click(screen.getByRole("button", { name: "Empty it" }));
  expect(calls.some((c) => c.method === "devdb.reset")).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: "Empty it" }));
  await waitFor(() => expect(calls.some((c) => c.method === "devdb.reset")).toBe(true));
  fireEvent.click(screen.getByRole("button", { name: "Stop" }));
  await waitFor(() => expect(calls.some((c) => c.method === "devdb.stop")).toBe(true));
  confirm.mockRestore();
});

test("no MySQL or MariaDB on the PC: says so and cannot start", async () => {
  responses["devdb.status"] = () => ({ ...base, state: "missing" });
  wrap(<TestDatabaseCard projectId="prj_1" />);
  await screen.findByText(/No MySQL or MariaDB is installed on this PC/);
  expect((screen.getByRole("button", { name: "Create and start" }) as HTMLButtonElement).disabled).toBe(true);
});
