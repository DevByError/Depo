/** Run a short-lived command and capture stdout. Never throws: returns null on any failure. */
export async function runCommand(cmd: string[], timeoutMs = 8000): Promise<string | null> {
  try {
    const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "ignore", stdin: "ignore", windowsHide: true });
    const timer = setTimeout(() => proc.kill(), timeoutMs);
    const out = await new Response(proc.stdout).text();
    const code = await proc.exited;
    clearTimeout(timer);
    return code === 0 ? out : null;
  } catch {
    return null;
  }
}

export type CommandRunner = typeof runCommand;
