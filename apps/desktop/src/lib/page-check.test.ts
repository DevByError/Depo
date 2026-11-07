import type { DepoEvent, PageCheck, PageView } from "@depo/shared";
import { describe, expect, test } from "vitest";
import { eventToNotice } from "./notify";
import { checkCounts, parseCheckId, viewProblems, widthsText } from "./page-check";

const ID = `qa_${"b".repeat(28)}`;
const view = (o: Partial<PageView> & Pick<PageView, "width">): PageView => ({
  viewport: { width: 360, height: 780 },
  screenshot: null,
  thumbnail: null,
  loaded: true,
  status: 200,
  title: "",
  consoleErrors: [],
  consoleErrorCount: 0,
  failedRequests: [],
  failedRequestCount: 0,
  a11y: {
    ran: true,
    counts: { critical: 0, serious: 0, moderate: 0, minor: 0 },
    violations: [],
    error: null,
  },
  expectFound: null,
  steps: [],
  error: null,
  durationMs: 1,
  ...o,
});
const contrast = {
  id: "color-contrast",
  impact: "serious" as const,
  help: "Elements must meet minimum color contrast ratio thresholds",
  helpUrl: "",
  count: 3,
  targets: ["p.muted"],
};
const font = {
  url: "https://fonts.googleapis.com/css2?family=Inter",
  method: "GET",
  status: null,
  error: "net::ERR_BLOCKED_BY_CLIENT",
  type: "Stylesheet",
  blocked: true,
};

describe("page checks in the UI", () => {
  test("reads the check id from check_page's first line only", () => {
    expect(parseCheckId(`Page check ${ID} of http://127.0.0.1:5173/, 3 widths in 2.0s.`)).toBe(ID);
    expect(parseCheckId(`Summary: Page check ${ID} of http://x/`)).toBeNull();
    expect(parseCheckId("Refused: http://example.com/ is not a local address.")).toBeNull();
  });

  test("counts each problem once across widths and keeps blocked requests apart", () => {
    const check: PageCheck = {
      id: ID,
      projectId: "prj_1",
      taskId: null,
      url: "http://127.0.0.1:5173/",
      by: "user",
      at: "2026-11-07T10:00:00.000Z",
      expectText: null,
      vision: null,
      summary: "",
      ok: false,
      durationMs: 1,
      views: [
        view({
          width: "phone",
          failedRequests: [font],
          failedRequestCount: 1,
          a11y: {
            ran: true,
            counts: { critical: 0, serious: 1, moderate: 0, minor: 0 },
            violations: [contrast],
            error: null,
          },
        }),
        view({
          width: "tablet",
          failedRequests: [font],
          failedRequestCount: 1,
          a11y: {
            ran: true,
            counts: { critical: 0, serious: 1, moderate: 0, minor: 0 },
            violations: [{ ...contrast, count: 5 }],
            error: null,
          },
        }),
        view({ width: "desktop", consoleErrorCount: 25 }),
      ],
    };
    const c = checkCounts(check);
    expect(c.requests).toBe(0);
    expect(c.blocked).toBe(1);
    expect(c.a11y).toEqual({ critical: 0, serious: 1, moderate: 0, minor: 0 });
    expect(c.a11yList[0]?.count).toBe(5);
    expect(c.a11yList[0]?.widths).toEqual(["phone", "tablet"]);
    // More errors than the check kept: the full count wins.
    expect(c.console).toBe(25);
    expect(widthsText(["phone", "tablet"], 3)).toBe("phone and tablet");
    expect(widthsText(["phone", "tablet", "desktop"], 3)).toBe("all widths");
    expect(viewProblems(check.views[0] as PageView)).toBe(2);
  });

  test("an app Depo started at review gets a notice with its link", () => {
    const ev = (o: Partial<DepoEvent>): DepoEvent => ({
      id: "evt_1",
      seq: 1,
      ts: "2026-11-07T10:00:00.000Z",
      type: "preview_started",
      status: "succeeded",
      text: "Preview running at http://127.0.0.1:5173/",
      projectId: "prj_1",
      taskId: "tsk_1",
      agent: "engine",
      details: { url: "http://127.0.0.1:5173/", auto: true },
      durationMs: null,
      ephemeral: false,
      ...o,
    });
    expect(eventToNotice(ev({}))).toEqual({
      title: "Your app is running",
      text: "Try the changes before you apply them: http://127.0.0.1:5173/",
      level: "info",
      taskId: "tsk_1",
    });
    expect(eventToNotice(ev({ details: { url: "http://127.0.0.1:5173/" } }))).toBeNull();
    expect(eventToNotice(ev({ status: "started" }))).toBeNull();
  });
});
