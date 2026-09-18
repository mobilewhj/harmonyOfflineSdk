import { fileIo as fs } from '@kit.CoreFileKit';
import { util } from '@kit.ArkTS';
import { OfflineError } from './OfflineTypes';

// Metadata inspection only. Decompression is always performed by the system zlib API.
// Ordinary single-volume ZIP (stored/deflate, UTF-8 names); ZIP64/encrypted archives are not accepted.
export const MAX_ZIP_BYTES: number = 64 * 1024 * 1024;
export const MAX_FILE_BYTES: number = 64 * 1024 * 1024;
export const MAX_EXPANDED_BYTES: number = 256 * 1024 * 1024;
export const MAX_ENTRIES: number = 10000;

export interface ZipEntry {
  name: string;
  directory: boolean;
  size: number;
  crc: number;
  offset: number;
  end: number;
}

export function archiveCheck(condition: boolean, reason: string = 'INVALID_ARCHIVE'): void {
  if (!condition) { throw new OfflineError(reason); }
}

export function safeRelativePath(name: string): boolean {
  return !!name && !name.startsWith('/') && !name.includes('\\') && !name.includes(':') &&
    !/[\u0000-\u001f\u007f]/.test(name) &&
    name.split('/').every((part: string) => !!part && part !== '.' && part !== '..');
}

function bytesAt(fd: number, offset: number, length: number, fileSize: number): DataView {
  archiveCheck(offset >= 0 && length >= 0 && offset + length <= fileSize);
  fs.lseek(fd, offset);
  const buffer = new ArrayBuffer(length);
  let read = 0;
  const bytes = new Uint8Array(buffer);
  while (read < length) {
    const chunk = new ArrayBuffer(length - read);
    const count = fs.readSync(fd, chunk);
    archiveCheck(count > 0);
    bytes.set(new Uint8Array(chunk, 0, count), read);
    read += count;
  }
  return new DataView(buffer);
}

function checkExtra(extra: DataView): void {
  let offset = 0;
  while (offset < extra.byteLength) {
    archiveCheck(offset + 4 <= extra.byteLength);
    const id = extra.getUint16(offset, true);
    // Reject ZIP64 and alternate Unicode path records to keep one unambiguous path interpretation.
    archiveCheck(id !== 0x0001 && id !== 0x7075, 'UNSUPPORTED_ARCHIVE');
    offset += 4 + extra.getUint16(offset + 2, true);
    archiveCheck(offset <= extra.byteLength);
  }
}

export function inspectZip(path: string, checkCancelled: () => void): ZipEntry[] {
  const file = fs.openSync(path, fs.OpenMode.READ_ONLY | fs.OpenMode.NOFOLLOW);
  try {
    const size = fs.statSync(file.fd).size;
    archiveCheck(size >= 22 && size <= MAX_ZIP_BYTES, 'SIZE_LIMIT');
    const tailStart = Math.max(0, size - 65557);
    const tail = bytesAt(file.fd, tailStart, size - tailStart, size);
    let end = tail.byteLength - 22;
    while (end >= 0 && (tail.getUint32(end, true) !== 0x06054b50 ||
      end + 22 + tail.getUint16(end + 20, true) !== tail.byteLength)) { end--; }
    archiveCheck(end >= 0);
    const count = tail.getUint16(end + 10, true);
    archiveCheck(count > 0 && count <= MAX_ENTRIES, 'SIZE_LIMIT');
    archiveCheck(tail.getUint16(end + 4, true) === 0 && tail.getUint16(end + 6, true) === 0 &&
      tail.getUint16(end + 8, true) === count, 'UNSUPPORTED_ARCHIVE');
    const centralSize = tail.getUint32(end + 12, true);
    const centralStart = tail.getUint32(end + 16, true);
    archiveCheck(centralStart + centralSize === tailStart + end);
    const entries: ZipEntry[] = [];
    const names = new Set<string>();
    let cursor = centralStart;
    let total = 0;
    const decoder = util.TextDecoder.create('utf-8', { fatal: true, ignoreBOM: true });
    for (let index = 0; index < count; index++) {
      checkCancelled();
      const header = bytesAt(file.fd, cursor, 46, size);
      archiveCheck(header.getUint32(0, true) === 0x02014b50);
      const flags = header.getUint16(8, true);
      const method = header.getUint16(10, true);
      archiveCheck((flags & ~0x080e) === 0 && (method === 0 || method === 8), 'UNSUPPORTED_ARCHIVE');
      const packedSize = header.getUint32(20, true);
      const unpackedSize = header.getUint32(24, true);
      total += unpackedSize;
      archiveCheck(unpackedSize <= MAX_FILE_BYTES && total <= MAX_EXPANDED_BYTES, 'SIZE_LIMIT');
      const nameLength = header.getUint16(28, true);
      const extraLength = header.getUint16(30, true);
      const commentLength = header.getUint16(32, true);
      archiveCheck(nameLength > 0 && nameLength <= 4096 && header.getUint16(34, true) === 0);
      const rawName = bytesAt(file.fd, cursor + 46, nameLength, size);
      const name = decoder.decodeToString(new Uint8Array(rawName.buffer));
      const directory = name.endsWith('/');
      const normalized = directory ? name.slice(0, -1) : name;
      archiveCheck(safeRelativePath(normalized) && !names.has(normalized));
      names.add(normalized);
      const mode = (header.getUint32(38, true) >>> 16) & 0xf000;
      archiveCheck(mode === 0 || (directory ? mode === 0x4000 : mode === 0x8000));
      archiveCheck(!directory || unpackedSize === 0);
      checkExtra(bytesAt(file.fd, cursor + 46 + nameLength, extraLength, size));
      const offset = header.getUint32(42, true);
      const local = bytesAt(file.fd, offset, 30, size);
      archiveCheck(local.getUint32(0, true) === 0x04034b50 && local.getUint16(6, true) === flags &&
        local.getUint16(8, true) === method && local.getUint16(26, true) === nameLength);
      const localName = bytesAt(file.fd, offset + 30, nameLength, size);
      for (let i = 0; i < nameLength; i++) {
        archiveCheck(localName.getUint8(i) === rawName.getUint8(i));
      }
      const localExtra = local.getUint16(28, true);
      checkExtra(bytesAt(file.fd, offset + 30 + nameLength, localExtra, size));
      const crc = header.getUint32(16, true);
      if ((flags & 8) === 0) {
        archiveCheck(local.getUint32(14, true) === crc && local.getUint32(18, true) === packedSize &&
          local.getUint32(22, true) === unpackedSize);
      }
      let entryEnd = offset + 30 + nameLength + localExtra + packedSize;
      if ((flags & 8) !== 0) {
        const signature = bytesAt(file.fd, entryEnd, 4, size).getUint32(0, true);
        const descriptor = bytesAt(file.fd, entryEnd + (signature === 0x08074b50 ? 4 : 0), 12, size);
        archiveCheck(descriptor.getUint32(0, true) === crc && descriptor.getUint32(4, true) === packedSize &&
          descriptor.getUint32(8, true) === unpackedSize);
        entryEnd += signature === 0x08074b50 ? 16 : 12;
      }
      archiveCheck(entryEnd <= centralStart);
      entries.push({ name: normalized, directory, size: unpackedSize, crc, offset, end: entryEnd });
      cursor += 46 + nameLength + extraLength + commentLength;
      archiveCheck(cursor <= centralStart + centralSize);
    }
    archiveCheck(cursor === centralStart + centralSize);
    const files = new Set<string>(entries.filter((entry: ZipEntry) => !entry.directory).map((entry: ZipEntry) => entry.name));
    for (let entry of entries) {
      let parent = entry.name;
      while (parent.includes('/')) {
        parent = parent.slice(0, parent.lastIndexOf('/'));
        archiveCheck(!files.has(parent));
      }
    }
    entries.sort((a: ZipEntry, b: ZipEntry) => a.offset - b.offset);
    let last = 0;
    for (let entry of entries) {
      archiveCheck(entry.offset === last);
      last = entry.end;
    }
    archiveCheck(last === centralStart);
    return entries;
  } finally { fs.closeSync(file); }
}
