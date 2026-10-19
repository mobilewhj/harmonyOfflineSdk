import { fileIo as fs } from '@kit.CoreFileKit';
import { zlib } from '@kit.BasicServicesKit';
import { OfflineError } from './OfflineTypes';
import { archiveCheck, inspectZip, safeRelativePath, ZipEntry } from './ZipInspection';

async function verifyExtracted(directory: string, entries: ZipEntry[], checkCancelled: () => void): Promise<void> {
  const checksum = zlib.createChecksumSync();
  const expected = new Map<string, ZipEntry>();
  const allowedDirectories = new Set<string>();
  for (let entry of entries) {
    if (!entry.directory) { expected.set(entry.name, entry); }
    let parent = entry.directory ? entry.name : entry.name.slice(0, Math.max(0, entry.name.lastIndexOf('/')));
    while (parent) {
      allowedDirectories.add(parent);
      parent = parent.slice(0, Math.max(0, parent.lastIndexOf('/')));
    }
  }
  const pending: string[] = [''];
  while (pending.length) {
    checkCancelled();
    const relative = pending.pop() as string;
    for (let name of fs.listFileSync(directory + (relative ? '/' + relative : ''))) {
      const child = relative ? relative + '/' + name : name;
      archiveCheck(safeRelativePath(child));
      const path = directory + '/' + child;
      const stat = fs.lstatSync(path);
      if (stat.isDirectory()) {
        archiveCheck(allowedDirectories.has(child));
        pending.push(child);
      } else {
        archiveCheck(stat.isFile() && !stat.isSymbolicLink());
        const entry = expected.get(child);
        if (!entry) { throw new OfflineError('INVALID_ARCHIVE'); }
        archiveCheck(entry.size === stat.size);
        const file = fs.openSync(path, fs.OpenMode.READ_ONLY | fs.OpenMode.NOFOLLOW);
        try {
          let crc = 0;
          const buffer = new ArrayBuffer(65536);
          let read = 0;
          let bytes = 0;
          while ((read = fs.readSync(file.fd, buffer)) > 0) {
            checkCancelled();
            bytes += read;
            archiveCheck(bytes <= stat.size);
            crc = await checksum.crc32(crc, buffer.slice(0, read));
          }
          archiveCheck(bytes === stat.size && (crc >>> 0) === entry.crc, 'CRC_MISMATCH');
        } finally { fs.closeSync(file); }
        expected.delete(child);
      }
    }
  }
  archiveCheck(expected.size === 0);
}

// Only the selected scope is written. All input entries still pass metadata and stream integrity checks.
function outputEntries(entries: ZipEntry[]): ZipEntry[] {
  const rootEntry = entries.some((entry: ZipEntry) => !entry.directory && entry.name === 'index.html');
  archiveCheck(rootEntry || entries.some((entry: ZipEntry) => !entry.directory && entry.name === 'dist/index.html'), 'MISSING_ENTRY');
  const selected: ZipEntry[] = [];
  for (let entry of entries) {
    const name = rootEntry ? entry.name : (entry.name.startsWith('dist/') ? entry.name.slice(5) : '');
    if (name) {
      selected.push({ name, directory: entry.directory, size: entry.size, crc: entry.crc, method: entry.method,
        dataOffset: entry.dataOffset, packedSize: entry.packedSize, offset: entry.offset, end: entry.end });
    }
  }
  return selected;
}

function ensureDirectory(destination: string, relative: string): void {
  let current = destination;
  if (!relative) { return; }
  for (let part of relative.split('/')) {
    current += '/' + part;
    if (!fs.accessSync(current)) { fs.mkdirSync(current); }
    const stat = fs.lstatSync(current);
    archiveCheck(stat.isDirectory() && !stat.isSymbolicLink());
  }
}

function readChunk(fd: number, length: number): ArrayBuffer {
  const buffer = new ArrayBuffer(length);
  let offset = 0;
  while (offset < length) {
    const chunk = new ArrayBuffer(length - offset);
    const count = fs.readSync(fd, chunk);
    archiveCheck(count > 0);
    new Uint8Array(buffer).set(new Uint8Array(chunk, 0, count), offset);
    offset += count;
  }
  return buffer;
}

async function extractEntry(fd: number, entry: ZipEntry, output: string, checkCancelled: () => void): Promise<void> {
  let file: fs.File | undefined = undefined;
  const checksum = zlib.createChecksumSync();
  let bytes = 0;
  let crc = 0;
  const accept = async (buffer: ArrayBuffer): Promise<void> => {
    checkCancelled();
    // Mirrors the selected, nonempty output path branch. Skipped directories are drained below.
    archiveCheck(!output || !entry.directory || buffer.byteLength === 0);
    bytes += buffer.byteLength;
    archiveCheck(bytes <= entry.size);
    crc = await checksum.crc32(crc, buffer);
    if (file) {
      let written = 0;
      while (written < buffer.byteLength) {
        const count = fs.writeSync((file as fs.File).fd, buffer.slice(written));
        if (count <= 0) { throw new OfflineError('FILE_IO'); }
        written += count;
      }
    }
  };
  try {
    if (output && !entry.directory) {
      archiveCheck(!fs.accessSync(output));
      file = fs.openSync(output, fs.OpenMode.CREATE | fs.OpenMode.READ_WRITE | fs.OpenMode.NOFOLLOW);
    }
    fs.lseek(fd, entry.dataOffset);
    if (entry.method === 0) {
      let remaining = entry.packedSize;
      while (remaining > 0) {
        checkCancelled();
        const buffer = readChunk(fd, Math.min(65536, remaining));
        remaining -= buffer.byteLength;
        await accept(buffer);
      }
    } else {
      let zip: zlib.Zip;
      try { zip = await zlib.createZip(); } catch (_) { throw new OfflineError('DECOMPRESS_FAILED'); }
      let stream: zlib.ZStream = {};
      let initialized = false;
      let complete = false;
      try {
        let status: zlib.ReturnStatus;
        try { status = await zip.inflateInit2(stream, -15); } catch (_) { throw new OfflineError('DECOMPRESS_FAILED'); }
        archiveCheck(status === zlib.ReturnStatus.OK, 'DECOMPRESS_FAILED');
        initialized = true;
        let input = new ArrayBuffer(0);
        let loaded = 0;
        let consumedTotal = 0;
        let producedTotal = 0;
        while (true) {
          checkCancelled();
          if (input.byteLength === 0 && loaded < entry.packedSize) {
            input = readChunk(fd, Math.min(65536, entry.packedSize - loaded));
            loaded += input.byteLength;
          }
          const outputBuffer = new ArrayBuffer(65536);
          const supplied: zlib.ZStream = { nextIn: input, availableIn: input.byteLength,
            nextOut: outputBuffer, availableOut: outputBuffer.byteLength };
          // API12 supplies no abort handle: await the real native call before checking cancellation or releasing buffers.
          try {
            status = await zip.inflate(supplied, zlib.CompressFlushMode.NO_FLUSH);
            stream = await zip.getZStream();
          } catch (_) { throw new OfflineError('DECOMPRESS_FAILED'); }
          checkCancelled();
          const consumed = input.byteLength - (stream.availableIn === undefined ? -1 : stream.availableIn);
          const produced = outputBuffer.byteLength - (stream.availableOut === undefined ? -1 : stream.availableOut);
          archiveCheck(Number.isInteger(consumed) && consumed >= 0 && consumed <= input.byteLength &&
            Number.isInteger(produced) && produced >= 0 && produced <= outputBuffer.byteLength, 'DECOMPRESS_FAILED');
          consumedTotal += consumed;
          producedTotal += produced;
          archiveCheck(stream.totalIn === consumedTotal && stream.totalOut === producedTotal, 'DECOMPRESS_FAILED');
          input = input.slice(consumed);
          await accept(outputBuffer.slice(0, produced));
          if (status === zlib.ReturnStatus.STREAM_END) {
            archiveCheck(consumedTotal === entry.packedSize && loaded === entry.packedSize && input.byteLength === 0);
            complete = true;
            break;
          }
          archiveCheck(status === zlib.ReturnStatus.OK && consumed + produced > 0, 'DECOMPRESS_FAILED');
        }
      } finally {
        if (initialized) {
          try {
            const ended = await zip.inflateEnd(stream);
            if (complete) { archiveCheck(ended === zlib.ReturnStatus.OK, 'DECOMPRESS_FAILED'); }
          } catch (_) { if (complete) { throw new OfflineError('DECOMPRESS_FAILED'); } }
        }
      }
    }
    archiveCheck(bytes === entry.size && (crc >>> 0) === entry.crc, 'CRC_MISMATCH');
    if (file) { fs.fsyncSync(file.fd); }
  } finally { if (file) { fs.closeSync(file); } }
}

export async function extractPackage(zip: string, destination: string, checkCancelled: () => void): Promise<void> {
  checkCancelled();
  const stat = fs.lstatSync(destination);
  archiveCheck(stat.isDirectory() && !stat.isSymbolicLink() && fs.listFileSync(destination).length === 0);
  const entries = inspectZip(zip, checkCancelled);
  const selected = outputEntries(entries);
  const outputs = new Map<number, ZipEntry>();
  for (let entry of selected) { outputs.set(entry.offset, entry); }
  const input = fs.openSync(zip, fs.OpenMode.READ_ONLY | fs.OpenMode.NOFOLLOW);
  try {
    for (let entry of entries) {
      checkCancelled();
      const target = outputs.get(entry.offset);
      if (target) {
        const parent = target.directory ? target.name : target.name.slice(0, Math.max(0, target.name.lastIndexOf('/')));
        ensureDirectory(destination, parent);
      }
      await extractEntry(input.fd, entry, target ? destination + '/' + target.name : '', checkCancelled);
    }
  } finally { fs.closeSync(input); }
  checkCancelled();
  await verifyExtracted(destination, selected, checkCancelled);
  // Selection is final: an empty root entry cannot fall back to a nested dist entry.
  const entryFile = fs.openSync(destination + '/index.html', fs.OpenMode.READ_ONLY | fs.OpenMode.NOFOLLOW);
  try { archiveCheck(fs.readSync(entryFile.fd, new ArrayBuffer(1)) > 0, 'MISSING_ENTRY'); }
  finally { fs.closeSync(entryFile); }
}
