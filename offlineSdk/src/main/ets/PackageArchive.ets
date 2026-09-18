import { fileIo as fs } from '@kit.CoreFileKit';
import { zlib } from '@kit.BasicServicesKit';
import { OfflineError } from './OfflineTypes';
import { archiveCheck, inspectZip, MAX_ENTRIES, MAX_EXPANDED_BYTES, MAX_FILE_BYTES, safeRelativePath,
  ZipEntry } from './ZipInspection';

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
  let count = 0;
  let total = 0;
  while (pending.length) {
    checkCancelled();
    const relative = pending.pop() as string;
    for (let name of fs.listFileSync(directory + (relative ? '/' + relative : ''))) {
      const child = relative ? relative + '/' + name : name;
      archiveCheck(safeRelativePath(child));
      const path = directory + '/' + child;
      const stat = fs.lstatSync(path);
      archiveCheck(++count <= MAX_ENTRIES, 'SIZE_LIMIT');
      if (stat.isDirectory()) {
        archiveCheck(allowedDirectories.has(child));
        pending.push(child);
      } else {
        archiveCheck(stat.isFile() && !stat.isSymbolicLink());
        const entry = expected.get(child);
        if (!entry) { throw new OfflineError('INVALID_ARCHIVE'); }
        archiveCheck(entry.size === stat.size);
        total += stat.size;
        archiveCheck(stat.size <= MAX_FILE_BYTES && total <= MAX_EXPANDED_BYTES, 'SIZE_LIMIT');
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

export async function extractPackage(zip: string, destination: string, checkCancelled: () => void): Promise<void> {
  checkCancelled();
  archiveCheck(fs.lstatSync(destination).isDirectory() && fs.listFileSync(destination).length === 0);
  const entries = inspectZip(zip, checkCancelled);
  const expectedSize = entries.reduce((sum: number, entry: ZipEntry) => sum + entry.size, 0);
  try {
    const originalSize = await zlib.getOriginalSize(zip);
    archiveCheck(originalSize === expectedSize && originalSize <= MAX_EXPANDED_BYTES, 'SIZE_LIMIT');
    checkCancelled();
    // API 12 has no progress callback or abort handle. Always await settlement before cleanup.
    await zlib.decompressFile(zip, destination);
  } catch (error) {
    checkCancelled();
    if (error instanceof OfflineError) { throw error; }
    throw new OfflineError('DECOMPRESS_FAILED');
  }
  checkCancelled();
  await verifyExtracted(destination, entries, checkCancelled);
}
