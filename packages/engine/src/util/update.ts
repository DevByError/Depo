/**
 * Update check. It runs only when the person presses "Check for updates" and only asks the GitHub
 * releases API for the newest release of the repository they configured. It never downloads or
 * installs anything; it reports the version and the page to download it from.
 */

export interface UpdateResult {
  status: "unconfigured" | "up_to_date" | "available" | "error";
  current: string;
  latest: string | null;
  url: string | null;
  notes: string;
  message: string;
}

const REPO = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;

function parts(v: string): { nums: number[]; pre: boolean } {
  const clean = v.trim().replace(/^v/i, "");
  const [core = "", pre] = clean.split(/[-+]/, 2);
  const nums = core.split(".").map((n) => Number.parseInt(n, 10) || 0);
  while (nums.length < 3) nums.push(0);
  return { nums, pre: clean.includes("-") && pre !== undefined };
}

/** Negative when a is older than b. A pre-release is older than the same release. */
export function compareVersions(a: string, b: string): number {
  const pa = parts(a);
  const pb = parts(b);
  for (let i = 0; i < Math.max(pa.nums.length, pb.nums.length); i++) {
    const d = (pa.nums[i] ?? 0) - (pb.nums[i] ?? 0);
    if (d !== 0) return d;
  }
  if (pa.pre !== pb.pre) return pa.pre ? -1 : 1;
  return 0;
}

export async function checkForUpdate(o: {
  current: string;
  repo: string;
  api?: string;
  fetchFn?: typeof fetch;
  timeoutMs?: number;
}): Promise<UpdateResult> {
  const base = { current: o.current, latest: null, url: null, notes: "" };
  const repo = o.repo.trim();
  if (!repo)
    return {
      ...base,
      status: "unconfigured",
      message:
        "No release repository is set. Enter owner/name (for example your-name/depo) in Settings first.",
    };
  if (!REPO.test(repo))
    return { ...base, status: "error", message: "The repository must look like owner/name." };
  const doFetch = o.fetchFn ?? fetch;
  try {
    const res = await doFetch(`${o.api ?? "https://api.github.com"}/repos/${repo}/releases/latest`, {
      headers: { accept: "application/vnd.github+json", "user-agent": "Depo" },
      signal: AbortSignal.timeout(o.timeoutMs ?? 10_000),
    });
    if (res.status === 404)
      return { ...base, status: "error", message: "That repository has no published release yet." };
    if (!res.ok) return { ...base, status: "error", message: `GitHub answered ${res.status}.` };
    const j = (await res.json()) as {
      tag_name?: unknown;
      html_url?: unknown;
      body?: unknown;
      draft?: unknown;
    };
    const tag = typeof j.tag_name === "string" ? j.tag_name : "";
    if (!tag || j.draft === true)
      return { ...base, status: "error", message: "The latest release has no version tag." };
    const url =
      typeof j.html_url === "string" && j.html_url.startsWith("https://")
        ? j.html_url
        : `https://github.com/${repo}/releases`;
    const notes = typeof j.body === "string" ? j.body.slice(0, 2000) : "";
    const newer = compareVersions(tag, o.current) > 0;
    return {
      status: newer ? "available" : "up_to_date",
      current: o.current,
      latest: tag.replace(/^v/i, ""),
      url,
      notes,
      message: newer ? `Version ${tag.replace(/^v/i, "")} is available.` : "You have the latest version.",
    };
  } catch (err) {
    return {
      ...base,
      status: "error",
      message: `Could not reach GitHub: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
