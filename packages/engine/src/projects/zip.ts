import fs from "node:fs";
import zlib from "node:zlib";

/**
 * Minimal streaming ZIP writer (deflate, UTF-8 names, ZIP64 not supported: each file and the
 * archive must stay under 4 GB). Enough for project exports, readable by Windows Explorer.
 */
export class ZipWriter {
  private readonly fd: number;
  private offset = 0;
  private readonly entries: {
    name: Buffer;
    crc: number;
    size: number;
    csize: number;
    offset: number;
    time: number;
    date: number;
    method: number;
  }[] = [];

  constructor(file: string) {
    this.fd = fs.openSync(file, "w");
  }

  add(name: string, data: Uint8Array, mtime = new Date()): void {
    const nameBuf = Buffer.from(name.replace(/\\/g, "/"), "utf8");
    const deflated = zlib.deflateRawSync(data, { level: 6 });
    // Store already-compressed data as is.
    const useDeflate = deflated.length < data.length;
    const body = useDeflate ? deflated : Buffer.from(data);
    const crc = crc32(data);
    const { time, date } = dosTime(mtime);
    if (this.offset + body.length > 0xffff_fff0) throw new Error("Export is larger than 4 GB.");
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4); // version needed
    header.writeUInt16LE(0x0800, 6); // UTF-8 names
    header.writeUInt16LE(useDeflate ? 8 : 0, 8);
    header.writeUInt16LE(time, 10);
    header.writeUInt16LE(date, 12);
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(body.length, 18);
    header.writeUInt32LE(data.length, 22);
    header.writeUInt16LE(nameBuf.length, 26);
    header.writeUInt16LE(0, 28);
    this.entries.push({
      name: nameBuf,
      crc,
      size: data.length,
      csize: body.length,
      offset: this.offset,
      time,
      date,
      method: useDeflate ? 8 : 0,
    });
    this.write(header);
    this.write(nameBuf);
    this.write(body);
  }

  close(): { bytes: number; files: number } {
    const start = this.offset;
    for (const e of this.entries) {
      const h = Buffer.alloc(46);
      h.writeUInt32LE(0x02014b50, 0);
      h.writeUInt16LE(20, 4); // made by
      h.writeUInt16LE(20, 6); // needed
      h.writeUInt16LE(0x0800, 8);
      h.writeUInt16LE(e.method, 10);
      h.writeUInt16LE(e.time, 12);
      h.writeUInt16LE(e.date, 14);
      h.writeUInt32LE(e.crc, 16);
      h.writeUInt32LE(e.csize, 20);
      h.writeUInt32LE(e.size, 24);
      h.writeUInt16LE(e.name.length, 28);
      h.writeUInt32LE(e.offset, 42);
      this.write(h);
      this.write(e.name);
    }
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(this.entries.length, 8);
    end.writeUInt16LE(this.entries.length, 10);
    end.writeUInt32LE(this.offset - start, 12);
    end.writeUInt32LE(start, 16);
    this.write(end);
    fs.closeSync(this.fd);
    return { bytes: this.offset, files: this.entries.length };
  }

  abort(): void {
    try {
      fs.closeSync(this.fd);
    } catch {
      // already closed
    }
  }

  private write(b: Uint8Array) {
    fs.writeSync(this.fd, b);
    this.offset += b.length;
  }
}

function dosTime(d: Date): { time: number; date: number } {
  const year = Math.max(1980, d.getFullYear());
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = (CRC_TABLE[(c ^ (data[i] ?? 0)) & 0xff] ?? 0) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
