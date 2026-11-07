import type { DesignReference, Task } from "@depo/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

import {
  DEFAULT_REFERENCE_TEXT,
  limitReason,
  linkDraft,
  linksIn,
  normaliseLink,
  pictureDraft,
  referenceSummary,
} from "@/lib/references";
import { Composer } from "./Composer";
import { MessageReferences } from "./References";

function wrap(node: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{node}</QueryClientProvider>);
}

const now = "2026-11-07T10:00:00.000Z";
const task = (status: Task["status"]): Task => ({
  id: "tsk_1",
  projectId: "prj_1",
  title: "Build the shop",
  prompt: "Build the shop",
  status,
  mode: "single",
  model: null,
  summary: null,
  error: null,
  createdAt: now,
  updatedAt: now,
});
const PNG_BYTES = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13]);
const picture = (name = "shot.png") => new File([PNG_BYTES], name, { type: "image/png" });

beforeEach(() => {
  calls.length = 0;
  for (const k of Object.keys(responses)) delete responses[k];
  useEngine.setState({ status: "open" });
  useUi.setState({ projectId: "prj_1", taskId: null });
  responses["tasks.send"] = () => task("queued");
});
afterEach(cleanup);

describe("reference helpers", () => {
  it("finds links in a message and cleans typed ones", () => {
    expect(linksIn("Make it like https://linear.app/features, and http://x.io/a?b=1).")).toEqual([
      "https://linear.app/features",
      "http://x.io/a?b=1",
    ]);
    expect(linksIn("no links here")).toEqual([]);
    expect(normaliseLink("stripe.com/pricing")).toBe("https://stripe.com/pricing");
    expect(normaliseLink("http://localhost:5173")).toBe("http://localhost:5173/");
    expect(normaliseLink("javascript:alert(1)")).toBeNull();
    expect(normaliseLink("not a link")).toBeNull();
    expect(normaliseLink("intranet")).toBeNull();
  });

  it("limits pictures and links per message", () => {
    const links = [linkDraft("https://a.com/"), linkDraft("https://b.com/")];
    expect(limitReason(links, "link")).toContain("up to 2 links");
    expect(limitReason(links, "image")).toBeNull();
    expect(links[0]?.name).toBe("a.com");
  });

  it("reads a small picture as it is and refuses other files", async () => {
    const d = await pictureDraft(picture("My dashboard.png"));
    expect(d.input).toMatchObject({ kind: "image", name: "My dashboard.png", mime: "image/png" });
    expect(d.input.kind === "image" && atob(d.input.data).charCodeAt(1)).toBe(80);
    await expect(pictureDraft(new File(["hi"], "notes.txt", { type: "text/plain" }))).rejects.toThrow(
      "Only PNG, JPEG, WebP or GIF",
    );
    const pasted = await pictureDraft(new File([PNG_BYTES], "", { type: "image/png" }));
    expect(pasted.name).toBe("pasted picture.png");
    expect(referenceSummary({ mode: "dark", fonts: ["Inter"], radius: "12px" })).toBe(
      "dark theme · Inter · 12px corners",
    );
  });
});

describe("composer with design references", () => {
  it("a pasted picture shows as a chip and goes with the message, with a default text", async () => {
    wrap(<Composer task={undefined} />);
    const box = screen.getByLabelText("Message the coding agent");
    fireEvent.paste(box, { clipboardData: { files: [picture()], types: ["Files"], getData: () => "" } });
    expect(await screen.findByRole("button", { name: "Remove shot.png" })).toBeTruthy();
    expect((box as HTMLTextAreaElement).placeholder).toBe("Say what to build with this look, or just send");
    expect(screen.getByText(/Depo reads the colours, fonts and layout/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(calls.some((c) => c.method === "tasks.send")).toBe(true));
    const sent = calls.find((c) => c.method === "tasks.send")?.params as {
      text: string;
      references: { kind: string; name: string; mime: string; data: string }[];
    };
    expect(sent.text).toBe(DEFAULT_REFERENCE_TEXT);
    expect(sent.references).toHaveLength(1);
    expect(sent.references[0]).toMatchObject({ kind: "image", name: "shot.png", mime: "image/png" });
    await waitFor(() => expect(screen.queryByRole("button", { name: "Remove shot.png" })).toBeNull());
  });

  it("a dropped picture is added; other files are refused with a reason", async () => {
    wrap(<Composer task={undefined} />);
    const frame = screen.getByLabelText("Message the coding agent").parentElement as HTMLElement;
    fireEvent.drop(frame, {
      dataTransfer: {
        files: [new File(["x"], "a.pdf", { type: "application/pdf" })],
        types: ["Files"],
        getData: () => "",
      },
    });
    expect(await screen.findByText(/Only PNG, JPEG, WebP or GIF/)).toBeTruthy();
    fireEvent.drop(frame, {
      dataTransfer: { files: [picture("mock.png")], types: ["Files"], getData: () => "" },
    });
    expect(await screen.findByRole("button", { name: "Remove mock.png" })).toBeTruthy();
  });

  it("a website link from the attach menu, and a typed link offered as a reference", async () => {
    wrap(<Composer task={task("review")} />);
    const trigger = screen.getByRole("button", { name: "Add a design reference" });
    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
    fireEvent.click(await screen.findByRole("menuitem", { name: /Website link/ }));
    const field = await screen.findByLabelText("Website link");
    fireEvent.change(field, { target: { value: "not a link" } });
    fireEvent.submit(
      within(screen.getByRole("form", { name: "Add a website link" })).getByLabelText("Website link"),
    );
    expect(await screen.findByText(/does not look like a web address/)).toBeTruthy();
    fireEvent.change(field, { target: { value: "dribbble.com/shots/1" } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    expect(await screen.findByRole("button", { name: "Remove dribbble.com" })).toBeTruthy();

    fireEvent.change(screen.getByLabelText("Message the coding agent"), {
      target: { value: "Same feel as https://www.notion.so/product please" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Copy the look of notion.so" }));
    expect(await screen.findByRole("button", { name: "Remove notion.so" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Copy the look of/ })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(calls.some((c) => c.method === "tasks.send")).toBe(true));
    const sent = calls.find((c) => c.method === "tasks.send")?.params as {
      taskId: string;
      references: { kind: string; url: string }[];
    };
    expect(sent.taskId).toBe("tsk_1");
    expect(sent.references).toEqual([
      { kind: "link", url: "https://dribbble.com/shots/1" },
      { kind: "link", url: "https://www.notion.so/product" },
    ]);
  });

  it("while the agent works, notes cannot carry references", async () => {
    responses["tasks.steer"] = () => ({ delivery: "queued", taskId: "tsk_1", noteId: "msg_1" });
    wrap(<Composer task={task("running")} />);
    expect(screen.queryByRole("button", { name: "Add a design reference" })).toBeNull();
    fireEvent.paste(screen.getByLabelText("Message the coding agent"), {
      clipboardData: { files: [picture()], types: ["Files"], getData: () => "" },
    });
    expect(await screen.findByText(/Pictures can go with your next message/)).toBeTruthy();
  });
});

const studied = (over: Partial<DesignReference> = {}): DesignReference => ({
  id: "ref_1",
  kind: "image",
  name: "dashboard.png",
  url: null,
  state: "studied",
  hasImage: true,
  width: 1440,
  height: 900,
  mode: "dark",
  palette: [
    { hex: "#0b1220", share: 0.6, role: "background" },
    { hex: "#e6edf7", share: 0.08, role: "text" },
    { hex: "#14b8a6", share: 0.02, role: "primary" },
    { hex: "#334155", share: 0.01, role: null },
  ],
  fonts: ["Inter"],
  radius: "12px",
  notes: ["Sidebar navigation on the left", "Cards with soft shadows"],
  vision: true,
  warnings: [],
  error: null,
  ...over,
});

describe("references under a sent message", () => {
  it("shows the picture, the colours with their roles and what Depo saw", async () => {
    responses["references.image"] = () => ({ mime: "image/png", data: "iVBORw0KGgo=" });
    wrap(<MessageReferences taskId="tsk_1" items={[studied()]} />);
    expect(screen.getByText("dashboard.png")).toBeTruthy();
    expect(screen.getByText("dark theme · Inter · 12px corners")).toBeTruthy();
    const colours = screen.getByRole("list", { name: "Colours" });
    expect(within(colours).getByText("#0b1220")).toBeTruthy();
    expect(within(colours).getByText("Background")).toBeTruthy();
    expect(within(colours).getByText("Primary")).toBeTruthy();
    // Unnamed colours stay out when roles are known.
    expect(within(colours).queryByText("#334155")).toBeNull();
    const more = screen.getByRole("button", { name: "What Depo saw" });
    expect(more.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(more);
    expect(screen.getByText("Sidebar navigation on the left")).toBeTruthy();
    await waitFor(() => expect(calls.some((c) => c.method === "references.image")).toBe(true));
    const show = screen.getByRole("button", { name: "Show dashboard.png" });
    await waitFor(() => expect((show as HTMLButtonElement).disabled).toBe(false));
    await act(async () => {
      fireEvent.click(show);
    });
    expect(await screen.findByRole("dialog", { name: "dashboard.png" })).toBeTruthy();
  });

  it("says when a reference is still being read, or why it failed", () => {
    wrap(
      <MessageReferences
        taskId="tsk_1"
        items={[
          studied({
            id: "ref_2",
            kind: "link",
            name: "stripe.com",
            url: "https://stripe.com/",
            state: "pending",
            hasImage: false,
            palette: [],
          }),
          studied({
            id: "ref_3",
            name: "broken.png",
            state: "failed",
            hasImage: false,
            error: "The picture could not be read.",
            palette: [],
          }),
        ]}
      />,
    );
    expect(screen.getByRole("status").textContent).toContain("Opening the page and reading its look");
    expect(screen.getByText("The picture could not be read.")).toBeTruthy();
    expect(calls.filter((c) => c.method === "references.image")).toHaveLength(0);
  });
});
