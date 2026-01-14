/**
 * ANS-104 Tag Serialization (Avro format)
 *
 * Vendored from arbundles
 */

export const MAX_TAG_BYTES = 4096;

export interface Tag {
  name: string;
  value: string;
}

class AVSCTap {
  buf: Buffer;
  pos: number;

  constructor(buf: Buffer = Buffer.alloc(MAX_TAG_BYTES), pos: number = 0) {
    this.buf = buf;
    this.pos = pos;
  }

  writeTags(tags: Tag[]): void {
    if (!Array.isArray(tags)) {
      throw new Error("input must be array");
    }
    const n = tags.length;
    if (n) {
      this.writeLong(n);
      for (let i = 0; i < n; i++) {
        const tag = tags[i];
        if (typeof tag?.name !== "string" || typeof tag?.value !== "string")
          throw new Error(`Invalid tag format for ${tag}, expected {name:string, value: string}`);
        this.writeString(tag.name);
        this.writeString(tag.value);
      }
    }
    this.writeLong(0);
  }

  toBuffer(): Buffer {
    const buffer = Buffer.alloc(this.pos);
    if (this.pos > this.buf.length)
      throw new Error(`Too many tag bytes (${this.pos} > ${this.buf.length})`);
    this.buf.copy(buffer, 0, 0, this.pos);
    return buffer;
  }

  writeLong(n: number): void {
    const buf = this.buf;
    let f: number, m: number;
    if (n >= -1073741824 && n < 1073741824) {
      m = n >= 0 ? n << 1 : (~n << 1) | 1;
      do {
        buf[this.pos] = m & 0x7f;
        m >>= 7;
      } while (m && (buf[this.pos++] |= 0x80));
    } else {
      f = n >= 0 ? n * 2 : -n * 2 - 1;
      do {
        buf[this.pos] = f & 0x7f;
        f /= 128;
      } while (f >= 1 && (buf[this.pos++] |= 0x80));
    }
    this.pos++;
    this.buf = buf;
  }

  writeString(s: string): void {
    const len = Buffer.byteLength(s);
    const buf = this.buf;
    this.writeLong(len);
    let pos = this.pos;
    this.pos += len;
    if (this.pos > buf.length) {
      return;
    }
    if (len > 64) {
      this.buf.write(s, this.pos - len, len, "utf8");
    } else {
      let i: number, l: number, c1: number, c2: number;
      for (i = 0, l = len; i < l; i++) {
        c1 = s.charCodeAt(i);
        if (c1 < 0x80) {
          buf[pos++] = c1;
        } else if (c1 < 0x800) {
          buf[pos++] = (c1 >> 6) | 0xc0;
          buf[pos++] = (c1 & 0x3f) | 0x80;
        } else if (
          (c1 & 0xfc00) === 0xd800 &&
          ((c2 = s.charCodeAt(i + 1)) & 0xfc00) === 0xdc00
        ) {
          c1 = 0x10000 + ((c1 & 0x03ff) << 10) + (c2 & 0x03ff);
          i++;
          buf[pos++] = (c1 >> 18) | 0xf0;
          buf[pos++] = ((c1 >> 12) & 0x3f) | 0x80;
          buf[pos++] = ((c1 >> 6) & 0x3f) | 0x80;
          buf[pos++] = (c1 & 0x3f) | 0x80;
        } else {
          buf[pos++] = (c1 >> 12) | 0xe0;
          buf[pos++] = ((c1 >> 6) & 0x3f) | 0x80;
          buf[pos++] = (c1 & 0x3f) | 0x80;
        }
      }
    }
    this.buf = buf;
  }

  readLong(): number {
    let n = 0;
    let k = 0;
    const buf = this.buf;
    let b: number, h: number, f: number, fk: number;
    do {
      b = buf[this.pos++];
      h = b & 0x80;
      n |= (b & 0x7f) << k;
      k += 7;
    } while (h && k < 28);
    if (h) {
      f = n;
      fk = 268435456;
      do {
        b = buf[this.pos++];
        f += (b & 0x7f) * fk;
        fk *= 128;
      } while (b & 0x80);
      return (f % 2 ? -(f + 1) : f) / 2;
    }
    return (n >> 1) ^ -(n & 1);
  }

  skipLong(): void {
    const buf = this.buf;
    while (buf[this.pos++] & 0x80) {}
  }

  readTags(): Tag[] {
    const val: Tag[] = [];
    let n: number;
    while ((n = this.readLong())) {
      if (n < 0) {
        n = -n;
        this.skipLong();
      }
      while (n--) {
        const name = this.readString();
        const value = this.readString();
        val.push({ name, value });
      }
    }
    return val;
  }

  readString(): string {
    const len = this.readLong();
    const pos = this.pos;
    const buf = this.buf;
    this.pos += len;
    if (this.pos > buf.length) {
      throw new Error("TAP Position out of range");
    }
    return this.buf.slice(pos, pos + len).toString();
  }
}

export function serializeTags(tags: Tag[] | undefined): Buffer {
  if (!tags || tags.length === 0) {
    return Buffer.allocUnsafe(0);
  }
  const tap = new AVSCTap();
  tap.writeTags(tags);
  return tap.toBuffer();
}

export function deserializeTags(tagsBuffer: Buffer): Tag[] {
  const tap = new AVSCTap(tagsBuffer);
  return tap.readTags();
}
