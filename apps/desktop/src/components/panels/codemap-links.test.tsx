import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { openInFiles, useOpenFile } from "@/lib/open-file";
import { useEngine } from "@/store/engine";
import { useUi } from "@/store/ui";

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
vi.mock("mermaid", () => ({
  default: {
    initialize: () => undefined,
    parse: async () => true,
    render: async () => ({ svg: "<svg></svg>" }),
  },
}));

import { DiagramsPanel } from "./DiagramsPanel";
import { FilesPanel } from "./FilesPanel";

function wrap(node: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{node}</QueryClientProvider>);
}

beforeEach(() => {
  calls.length = 0;
  for (const k of Object.keys(responses)) delete responses[k];
  useEngine.setState({ status: "open" });
  useUi.setState({ projectId: "prj_1", taskId: null, centerTab: "overview" });
  useOpenFile.getState().clear();
});
afterEach(cleanup);

test("Open in Files switches to the Files tab and shows the file", async () => {
  responses["files.list"] = () => ({ entries: [] });
  responses["files.read"] = (p) => ({
    path: (p as { path: string }).path,
    text: "export const a = 1;\n",
    binary: false,
    size: 20,
    truncated: false,
  });
  openInFiles("web\\src\\lib\\cn.ts");
  expect(useUi.getState().centerTab).toBe("files");
  wrap(<FilesPanel />);
  expect(await screen.findByRole("region", { name: "File web/src/lib/cn.ts" })).toBeTruthy();
  expect(await screen.findByText("export const a = 1;")).toBeTruthy();
  expect(useOpenFile.getState().path).toBeNull();
});

test("Diagrams: the code map diagram says it is drawn from the code, and saving puts a copy in the project", async () => {
  const source = 'flowchart LR\n  m0["web"] --> m1["api"]\n';
  responses["diagrams.list"] = () => ({
    diagrams: [{ path: ".depo/code-map.mmd", content: source, source: "auto" }],
  });
  responses["diagrams.save"] = (p) => ({ path: (p as { path: string }).path });
  wrap(<DiagramsPanel />);
  expect(await screen.findByText("Drawn from the code, updates by itself")).toBeTruthy();
  const save = await screen.findByRole("button", { name: "Save a copy to the project" });
  await waitFor(() => expect((save as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(save);
  await waitFor(() =>
    expect(calls.find((c) => c.method === "diagrams.save")?.params).toEqual({
      projectId: "prj_1",
      path: "docs/diagrams/code-map.mmd",
      content: source,
    }),
  );
});
