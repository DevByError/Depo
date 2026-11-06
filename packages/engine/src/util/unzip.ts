import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

/**
 * A small ZIP reader that works on a file on disk (random access, so a very large archive such as
 * an OSV dump never has to fit in memory). Supports stored and deflated entries; refuses ZIP64,
 * encrypted entries and path tricks ("zip slip").
 */
export interface ZipEntry {
  name: string;
  size: number;
  compressedSize: number;
  method: number;
  offset: number;
  isDir: boolean;
}

const EOCD = 0x06054b50;
const CEN = 0x02014b50;
const LOC = 0x04034b50;

function readAt(fd: number, pos: number, len: number): Buffer {
  const buf = Buffer.alloc(len);
  let got = 0;
  while (got < len) {
    const n = fs.readSync(fd, buf, got, len - got, pos + got);
    if (n <= 0) break;
    got += n;
  }
  return got === len ? buf : buf.subarray(0, got);
}

export function listZip(file: string): ZipEntry[] {
  const fd = fs.openSync(file, "r");
  try {
    const size = fs.fstatSync(fd).size;
    const tailLen = Math.min(size, 65_557);
    const tail = readAt(fd, size - tailLen, tailLen);
    let eocd = -1;
    for (let i = tail.length - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === EOCD) {
        eocd = i;
        break;
      }
    }
    if (eocd < 0) throw new Error("This is not a valid .zip file.");
    const count = tail.readUInt16LE(eocd + 10);
    const cdSize = tail.readUInt32LE(eocd + 12);
    const cdOffset = tail.readUInt32LE(eocd + 16);
    if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff)
      throw new Error("ZIP64 archives are not supported.");
    const cd = readAt(fd, cdOffset, cdSize);
    const out: ZipEntry[] = [];
    let p = 0;
    for (let i = 0; i < count; i++) {
      if (p + 46 > cd.length || cd.readUInt32LE(p) !== CEN) throw new Error("The .zip file is damaged.");
      const flags = cd.readUInt16LE(p + 8);
      const method = cd.readUInt16LE(p + 10);
      const compressedSize = cd.readUInt32LE(p + 20);
      const usize = cd.readUInt32LE(p + 24);
      const nameLen = cd.readUInt16LE(p + 28);
      const extraLen = cd.readUInt16LE(p + 30);
      const commentLen = cd.readUInt16LE(p + 32);
      const offset = cd.readUInt32LE(p + 42);
      const name = cd
        .subarray(p + 46, p + 46 + nameLen)
        .toString("utf8")
        .replace(/\\/g, "/");
      p += 46 + nameLen + extraLen + commentLen;
      if (flags & 1) throw new Error("Encrypted .zip files are not supported.");
      out.push({ name, size: usize, compressedSize, method, offset, isDir: name.endsWith("/") });
    }
    return out;
  } finally {
    fs.closeSync(fd);
  }
}

export function readZipEntry(file: string, e: ZipEntry, maxBytes = 64 * 1024 * 1024): Buffer {
  if (e.size > maxBytes) throw new Error(`${e.name} is too large (${e.size} bytes).`);
  const fd = fs.openSync(file, "r");
  try {
    const head = readAt(fd, e.offset, 30);
    if (head.length < 30 || head.readUInt32LE(0) !== LOC) throw new Error("The .zip file is damaged.");
    const start = e.offset + 30 + head.readUInt16LE(26) + head.readUInt16LE(28);
    const raw = readAt(fd, start, e.compressedSize);
    if (e.method === 0) return raw;
    if (e.method === 8) return zlib.inflateRawSync(raw, { maxOutputLength: Math.max(maxBytes, e.size + 1) });
    throw new Error(`Unsupported compression in ${e.name}.`);
  } finally {
    fs.closeSync(fd);
  }
}

/** A name that is safe to join to a folder: no drive letters, no `..`, no absolute paths. */
export function safeEntryName(name: string): string | null {
  const n = name.replace(/\\/g, "/");
  if (!n || n.startsWith("/") || /^[a-zA-Z]:/.test(n)) return null;
  const parts = n.split("/").filter((s) => s !== "");
  if (parts.some((s) => s === ".." || s === ".")) return null;
  // Windows: no reserved characters, alternate streams or trailing dots/spaces.
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are invalid in Windows file names
  if (parts.some((s) => /[<>:"|?*\x00-\x1f]/.test(s) || /[. ]$/.test(s))) return null;
  return parts.join("/");
}

export interface ExtractOptions {
  /** Return false to skip an entry (by its name inside the archive). */
  filter?: (name: string) => boolean;
  /** Remove this many leading path segments (GitHub archives have one wrapper folder). */
  strip?: number;
  maxFiles?: number;
  maxTotalBytes?: number;
}

/** Extract into `dest`; returns the relative paths written. */
export function extractZip(file: string, dest: string, opts: ExtractOptions = {}): string[] {
  const maxFiles = opts.maxFiles ?? 5000;
  const maxTotal = opts.maxTotalBytes ?? 200 * 1024 * 1024;
  const strip = opts.strip ?? 0;
  const written: string[] = [];
  let total = 0;
  const root = path.resolve(dest);
  fs.mkdirSync(root, { recursive: true });
  for (const e of listZip(file)) {
    if (e.isDir || (opts.filter && !opts.filter(e.name))) continue;
    const parts = e.name.split("/");
    const rel = safeEntryName(parts.slice(strip).join("/"));
    if (!rel) continue;
    if (written.length >= maxFiles) throw new Error(`The archive has more than ${maxFiles} files.`);
    total += e.size;
    if (total > maxTotal) throw new Error("The archive is too large when unpacked.");
    const target = path.resolve(root, rel);
    if (path.relative(root, target).startsWith("..")) continue;
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, readZipEntry(file, e));
    written.push(rel);
  }
  return written;
}
