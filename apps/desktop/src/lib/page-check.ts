import type { A11yCounts, A11yImpact, A11yViolation, ConsoleIssue, PageCheck, QaWidth } from "@depo/shared";

export const WIDTH_LABEL: Record<QaWidth, string> = { phone: "Phone", tablet: "Tablet", desktop: "Desktop" };
export const IMPACTS: A11yImpact[] = ["critical", "serious", "moderate", "minor"];

/** The check id from check_page's result ("Page check qa_… of http://…"). */
export function parseCheckId(text: string): string | null {
  return text.match(/^Page check (qa_[0-9a-f]{28}) of /)?.[1] ?? null;
}

export interface CheckCounts {
  console: number;
  /** Failed requests to the app itself (4xx, 5xx, no answer). */
  requests: number;
  /** Requests to the internet that the check blocked. */
  blocked: number;
  a11y: A11yCounts;
  /** Each problem once, even when it shows at several widths. */
  consoleList: (ConsoleIssue & { widths: QaWidth[] })[];
  requestList: { label: string; blocked: boolean; widths: QaWidth[] }[];
  a11yList: (A11yViolation & { widths: QaWidth[] })[];
}

const pathOf = (url: string, base: string): string => {
  try {
    const u = new URL(url);
    const b = new URL(base);
    return u.origin === b.origin ? `${u.pathname}${u.search}` : url;
  } catch {
    return url;
  }
};

/** Problems of all widths together, each counted once. */
export function checkCounts(check: PageCheck): CheckCounts {
  const consoleMap = new Map<string, ConsoleIssue & { widths: QaWidth[] }>();
  const requestMap = new Map<string, { label: string; blocked: boolean; widths: QaWidth[] }>();
  const a11yMap = new Map<string, A11yViolation & { widths: QaWidth[] }>();
  let consoleMax = 0;
  let requestMax = 0;
  for (const v of check.views) {
    consoleMax = Math.max(consoleMax, v.consoleErrorCount);
    requestMax = Math.max(requestMax, v.failedRequestCount);
    for (const c of v.consoleErrors) {
      const key = `${c.kind}|${c.text}`;
      const hit = consoleMap.get(key) ?? { ...c, widths: [] };
      if (!hit.widths.includes(v.width)) hit.widths.push(v.width);
      consoleMap.set(key, hit);
    }
    for (const r of v.failedRequests) {
      const label = r.blocked
        ? `${r.method} ${r.url} (blocked: not on this computer)`
        : `${r.method} ${pathOf(r.url, check.url)}: ${r.status ?? r.error ?? "failed"}`;
      const hit = requestMap.get(label) ?? { label, blocked: r.blocked, widths: [] };
      if (!hit.widths.includes(v.width)) hit.widths.push(v.width);
      requestMap.set(label, hit);
    }
    for (const a of v.a11y.violations) {
      const hit = a11yMap.get(a.id) ?? { ...a, targets: [...a.targets], widths: [] };
      hit.count = Math.max(hit.count, a.count);
      if (!hit.widths.includes(v.width)) hit.widths.push(v.width);
      a11yMap.set(a.id, hit);
    }
  }
  const requestList = [...requestMap.values()];
  const blocked = requestList.filter((r) => r.blocked).length;
  const a11y: A11yCounts = { critical: 0, serious: 0, moderate: 0, minor: 0 };
  for (const a of a11yMap.values()) if (a.impact) a11y[a.impact] += 1;
  return {
    console: Math.max(consoleMap.size, consoleMax),
    requests: Math.max(requestList.length, requestMax) - blocked,
    blocked,
    a11y,
    consoleList: [...consoleMap.values()],
    requestList,
    a11yList: [...a11yMap.values()].sort(
      (x, y) => IMPACTS.indexOf(x.impact ?? "minor") - IMPACTS.indexOf(y.impact ?? "minor"),
    ),
  };
}

/** "phone and desktop", "all widths". */
export function widthsText(widths: QaWidth[], of: number): string {
  if (widths.length === of && of > 1) return "all widths";
  const names = widths.map((w) => WIDTH_LABEL[w].toLowerCase());
  return names.length <= 1 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

/** Problems that need fixing in one view, for its thumbnail's caption. */
export function viewProblems(v: PageCheck["views"][number]): number {
  return (
    (v.error ? 1 : 0) +
    v.consoleErrorCount +
    v.failedRequestCount +
    v.a11y.counts.critical +
    v.a11y.counts.serious +
    v.steps.filter((s) => !s.ok).length +
    (v.expectFound === false ? 1 : 0)
  );
}
