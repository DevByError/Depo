import fs from "node:fs";
import path from "node:path";

export interface GithubEndpoints {
  codeload: string;
  api: string;
}

export const DEFAULT_GITHUB: GithubEndpoints = {
  codeload: "https://codeload.github.com",
  api: "https://api.github.com",
};

export interface GithubRef {
  owner: string;
  repo: string;
  ref: string | null;
  subpath: string;
}

const GITHUB_URL =
  /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:\/tree\/([^/]+)(?:\/(.+?))?)?\/?$/;

export function parseGithubUrl(raw: string): GithubRef | null {
  const m = GITHUB_URL.exec(raw.trim());
  if (!m) return null;
  return { owner: m[1] ?? "", repo: m[2] ?? "", ref: m[3] ?? null, subpath: m[4] ?? "" };
}

const MAX_DOWNLOAD = 400 * 1024 * 1024;

/** Download a repository archive to `dest`; returns the commit id GitHub records in the archive comment. */
export async function downloadGithubZip(
  gh: GithubRef,
  dest: string,
  opts: { endpoints?: GithubEndpoints; fetchImpl?: typeof fetch; maxBytes?: number } = {},
): Promise<{ commit: string | null; bytes: number }> {
  const ep = opts.endpoints ?? DEFAULT_GITHUB;
  const f = opts.fetchImpl ?? fetch;
  const url = `${ep.codeload}/${gh.owner}/${gh.repo}/zip/${encodeURIComponent(gh.ref ?? "HEAD")}`;
  const res = await f(url, {
    headers: { "User-Agent": "Depo", Accept: "application/zip" },
    redirect: "follow",
  });
  if (!res.ok) {
    throw new Error(
      res.status === 404
        ? "GitHub says that repository or branch does not exist (or it is private)."
        : `GitHub answered ${res.status}.`,
    );
  }
  return writeStream(res, dest, opts.maxBytes ?? MAX_DOWNLOAD);
}

export async function writeStream(
  res: Response,
  dest: string,
  maxBytes: number,
): Promise<{ commit: string | null; bytes: number }> {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const out = fs.createWriteStream(dest);
  let size = 0;
  try {
    const reader = res.body?.getReader();
    if (!reader) throw new Error("The download was empty.");
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes)
        throw new Error(`The download is larger than ${Math.round(maxBytes / 1024 / 1024)} MB.`);
      if (!out.write(value)) await new Promise((r) => out.once("drain", r));
    }
  } finally {
    await new Promise<void>((r) => out.end(() => r()));
  }
  const fd = fs.openSync(dest, "r");
  try {
    const len = Math.min(size, 200);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    const m = /([0-9a-f]{40})\s*$/.exec(buf.toString("latin1"));
    return { commit: m?.[1] ?? null, bytes: size };
  } finally {
    fs.closeSync(fd);
  }
}
