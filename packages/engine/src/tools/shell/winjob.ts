/**
 * Windows Job Objects via kernel32 (bun:ffi). Every shell command runs in its own job with
 * KILL_ON_JOB_CLOSE, so cancelling or timing out kills the whole process tree (npm → node →
 * esbuild …), and an optional memory cap stops runaway test suites. On other platforms the
 * runner uses process groups instead.
 */

export interface JobHandle {
  /** Kill every process in the job. */
  terminate(exitCode?: number): void;
  /** Release the handle; with KILL_ON_JOB_CLOSE this also kills anything still running. */
  close(): void;
}

const JobObjectExtendedLimitInformation = 9;
const JOB_OBJECT_LIMIT_JOB_MEMORY = 0x200;
const JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION = 0x400;
const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000;
const PROCESS_SET_QUOTA = 0x0100;
const PROCESS_TERMINATE = 0x0001;
/** sizeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION) on x64. */
const EXTENDED_LIMIT_SIZE = 144;

type Kernel32 = {
  CreateJobObjectW: (a: null, b: null) => number | null;
  SetInformationJobObject: (job: number, cls: number, info: Uint8Array, len: number) => number;
  OpenProcess: (access: number, inherit: number, pid: number) => number | null;
  AssignProcessToJobObject: (job: number, proc: number) => number;
  TerminateJobObject: (job: number, code: number) => number;
  CloseHandle: (h: number) => number;
};

let k32: Kernel32 | null | undefined;

async function kernel32(): Promise<Kernel32 | null> {
  if (k32 !== undefined) return k32;
  if (process.platform !== "win32" || (process.arch !== "x64" && process.arch !== "arm64")) {
    k32 = null;
    return k32;
  }
  try {
    const { dlopen, FFIType } = await import("bun:ffi");
    const lib = dlopen("kernel32.dll", {
      CreateJobObjectW: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.ptr },
      SetInformationJobObject: {
        args: [FFIType.ptr, FFIType.i32, FFIType.ptr, FFIType.u32],
        returns: FFIType.i32,
      },
      OpenProcess: { args: [FFIType.u32, FFIType.i32, FFIType.u32], returns: FFIType.ptr },
      AssignProcessToJobObject: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
      TerminateJobObject: { args: [FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
      CloseHandle: { args: [FFIType.ptr], returns: FFIType.i32 },
    });
    k32 = lib.symbols as unknown as Kernel32;
  } catch {
    k32 = null;
  }
  return k32;
}

/** Put `pid` into a new kill-on-close job. Returns null when Job Objects are unavailable. */
export async function attachJob(pid: number, memoryLimitBytes?: number): Promise<JobHandle | null> {
  const k = await kernel32();
  if (!k) return null;
  const job = k.CreateJobObjectW(null, null);
  if (!job) return null;
  const info = new Uint8Array(EXTENDED_LIMIT_SIZE);
  const view = new DataView(info.buffer);
  let flags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION;
  if (memoryLimitBytes && memoryLimitBytes > 0) {
    flags |= JOB_OBJECT_LIMIT_JOB_MEMORY;
    view.setBigUint64(120, BigInt(Math.floor(memoryLimitBytes)), true); // JobMemoryLimit
  }
  view.setUint32(16, flags, true); // BasicLimitInformation.LimitFlags
  if (!k.SetInformationJobObject(job, JobObjectExtendedLimitInformation, info, EXTENDED_LIMIT_SIZE)) {
    k.CloseHandle(job);
    return null;
  }
  const proc = k.OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, 0, pid);
  if (!proc) {
    k.CloseHandle(job);
    return null;
  }
  const ok = k.AssignProcessToJobObject(job, proc);
  k.CloseHandle(proc);
  if (!ok) {
    k.CloseHandle(job);
    return null;
  }
  let closed = false;
  return {
    terminate(code = 1) {
      if (!closed) k.TerminateJobObject(job, code);
    },
    close() {
      if (closed) return;
      closed = true;
      k.CloseHandle(job);
    },
  };
}
