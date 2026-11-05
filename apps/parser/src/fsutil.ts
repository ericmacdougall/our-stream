// SPDX-License-Identifier: AGPL-3.0-only
import { constants } from 'node:fs';
import { open, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** Reads a regular file directly under `dir`, refusing symlinks (O_NOFOLLOW) and anything over `maxBytes`. */
export async function readRegularFile(path: string, maxBytes: number): Promise<Buffer | null> {
  let fh;
  try {
    fh = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch {
    return null;
  }
  try {
    const st = await fh.stat();
    if (!st.isFile() || st.size > maxBytes) return null;
    const buf = Buffer.alloc(st.size);
    let off = 0;
    while (off < st.size) {
      const { bytesRead } = await fh.read(buf, off, st.size - off, off);
      if (bytesRead === 0) break;
      off += bytesRead;
    }
    return buf.subarray(0, off);
  } finally {
    await fh.close();
  }
}

/** Writes `data` to `<dir>/<name>` atomically (temp file in the same directory, then rename). */
export async function writeAtomic(dir: string, name: string, data: string): Promise<void> {
  const tmp = join(dir, `.${name}.${process.pid}.tmp`);
  await writeFile(tmp, data, { mode: 0o644 });
  await rename(tmp, join(dir, name));
}
