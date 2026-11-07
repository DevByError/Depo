import { z } from "zod";
import { PreviewInfoSchema } from "./preview";

/**
 * Page checks: Depo opens the running app in the PC's own browser (headless, through the Chrome
 * DevTools Protocol), at phone, tablet and desktop widths, and reports what a careful tester would
 * notice: console errors, failed requests, accessibility problems (axe-core) and screenshots.
 */

export const QaWidthSchema = z.enum(["phone", "tablet", "desktop"]);
export type QaWidth = z.infer<typeof QaWidthSchema>;

/** The viewport of each width (CSS pixels). Matches the 360 / 768 / 1440 layouts in the playbooks. */
export const QA_VIEWPORTS: Record<QaWidth, { width: number; height: number; mobile: boolean }> = {
  phone: { width: 360, height: 780, mobile: true },
  tablet: { width: 768, height: 1024, mobile: true },
  desktop: { width: 1440, height: 900, mobile: false },
};

export const A11yImpactSchema = z.enum(["critical", "serious", "moderate", "minor"]);
export type A11yImpact = z.infer<typeof A11yImpactSchema>;

export const A11yViolationSchema = z.object({
  /** axe rule id, e.g. `color-contrast`. */
  id: z.string().max(100),
  impact: A11yImpactSchema.nullable(),
  /** One line from axe, e.g. "Images must have alternative text". */
  help: z.string().max(300),
  helpUrl: z.string().max(300),
  /** How many elements break the rule. */
  count: z.number().int().min(0),
  /** CSS selectors of the first few elements. */
  targets: z.array(z.string().max(300)).max(5),
});
export type A11yViolation = z.infer<typeof A11yViolationSchema>;

export const A11yCountsSchema = z.object({
  critical: z.number().int().min(0),
  serious: z.number().int().min(0),
  moderate: z.number().int().min(0),
  minor: z.number().int().min(0),
});
export type A11yCounts = z.infer<typeof A11yCountsSchema>;

export const ConsoleIssueSchema = z.object({
  /** `console` = console.error, `exception` = an uncaught error, `log` = a browser error message. */
  kind: z.enum(["console", "exception", "log"]),
  text: z.string().max(600),
  /** Script and line, when known. */
  source: z.string().max(300).nullable(),
});
export type ConsoleIssue = z.infer<typeof ConsoleIssueSchema>;

export const FailedRequestSchema = z.object({
  url: z.string().max(600),
  method: z.string().max(20),
  /** HTTP status (4xx or 5xx), or null when the request did not get an answer. */
  status: z.number().int().nullable(),
  /** Why it failed without a status, e.g. `net::ERR_CONNECTION_REFUSED`. */
  error: z.string().max(300).nullable(),
  /** Document, Script, Fetch, XHR, Image, … */
  type: z.string().max(40),
  /** A request to the internet that Depo blocked: apps must work offline and self-host their files. */
  blocked: z.boolean(),
});
export type FailedRequest = z.infer<typeof FailedRequestSchema>;

export const QaStepSchema = z.object({
  action: z.enum(["click", "type", "press", "wait_for"]),
  selector: z.string().max(300).optional(),
  text: z.string().max(2000).optional(),
  key: z.string().max(40).optional(),
});
export type QaStep = z.infer<typeof QaStepSchema>;

export const QaStepResultSchema = z.object({
  action: QaStepSchema.shape.action,
  /** What was done, in plain words ("Clicked #save"). */
  label: z.string().max(400),
  ok: z.boolean(),
  error: z.string().max(400).nullable(),
});
export type QaStepResult = z.infer<typeof QaStepResultSchema>;

/** One width of a page check. */
export const PageViewSchema = z.object({
  width: QaWidthSchema,
  viewport: z.object({ width: z.number().int(), height: z.number().int() }),
  /** Screenshot path relative to the check's root (`.depo/qa/<id>/<width>.png`), null when none was taken. */
  screenshot: z.string().max(300).nullable(),
  /** A small copy for lists (`<width>-thumb.png`). */
  thumbnail: z.string().max(300).nullable(),
  /** The page loaded (the load event fired and the main document answered below 400). */
  loaded: z.boolean(),
  /** HTTP status of the main document. */
  status: z.number().int().nullable(),
  title: z.string().max(300),
  consoleErrors: z.array(ConsoleIssueSchema).max(20),
  consoleErrorCount: z.number().int().min(0),
  failedRequests: z.array(FailedRequestSchema).max(20),
  failedRequestCount: z.number().int().min(0),
  a11y: z.object({
    /** False when axe could not run (the page did not load, or a script error). */
    ran: z.boolean(),
    counts: A11yCountsSchema,
    violations: z.array(A11yViolationSchema).max(20),
    error: z.string().max(300).nullable(),
  }),
  /** Whether `expectText` was on the page after the steps, null when nothing was expected. */
  expectFound: z.boolean().nullable(),
  steps: z.array(QaStepResultSchema).max(20),
  /** Why this width could not be checked. */
  error: z.string().max(600).nullable(),
  durationMs: z.number().int().min(0),
});
export type PageView = z.infer<typeof PageViewSchema>;

export const PageCheckSchema = z.object({
  id: z.string().regex(/^qa_[0-9a-f]{28}$/),
  projectId: z.string(),
  /** The task whose private copy was checked, or null for the project folder. */
  taskId: z.string().nullable(),
  url: z.string(),
  /** `user` or the agent tag that ran it. */
  by: z.string(),
  at: z.string(),
  expectText: z.string().nullable(),
  views: z.array(PageViewSchema).max(3),
  /** The vision model's comments on the desktop screenshot, when one is set up. */
  vision: z.string().max(4000).nullable(),
  /** Plain one-paragraph result. */
  summary: z.string().max(2000),
  /** No console errors, no failed requests, no critical or serious accessibility issues, and the text was found. */
  ok: z.boolean(),
  durationMs: z.number().int().min(0),
});
export type PageCheck = z.infer<typeof PageCheckSchema>;

/** Where a check's files live: the task's private copy, or Depo's own folder for the project. */
const TargetParams = {
  projectId: z.string(),
  taskId: z.string().optional(),
};

export const QaMethods = {
  /** The owner checks a page of a running preview (the Preview tab's "Check this page"). */
  "qa.check": {
    params: z
      .object({
        ...TargetParams,
        /** A full loopback URL, or a path such as `/login` on the target's running preview. */
        url: z.string().max(2000).optional(),
        widths: z.array(QaWidthSchema).min(1).max(3).optional(),
        expectText: z.string().max(300).optional(),
      })
      .strict(),
    result: z.object({ check: PageCheckSchema }),
  },
  "qa.get": {
    params: z.object({ ...TargetParams, id: z.string().max(40) }).strict(),
    result: z.object({ check: PageCheckSchema }),
  },
  /** The newest checks of a target, newest first. */
  "qa.list": {
    params: z.object({ ...TargetParams, limit: z.number().int().min(1).max(20).optional() }).strict(),
    result: z.object({ checks: z.array(PageCheckSchema) }),
  },
  /** A screenshot of a check as a data URL. The path must be a check image inside the target. */
  "qa.screenshot": {
    params: z.object({ ...TargetParams, path: z.string().max(300) }).strict(),
    result: z.object({ dataUrl: z.string(), bytes: z.number().int() }),
  },
  /** Keep a preview running after its changes are applied or discarded. */
  "preview.pin": {
    params: z.object({ id: z.string(), pinned: z.boolean() }).strict(),
    result: z.object({ preview: PreviewInfoSchema }),
  },
} as const;
