export interface PackageRecord {
  version: number;
  sha256: string;
}

export interface PackageSpec extends PackageRecord {
  url: string;
  localArchive?: string;
}

export enum OfflineStage {
  PREPARING = 'preparing',
  DOWNLOADING = 'downloading',
  VERIFYING = 'verifying',
  EXTRACTING = 'extracting',
  SAVING = 'saving',
  COMPLETE = 'complete'
}

export interface OfflineProgress {
  stage: OfflineStage;
  percent: number; // -1 means that the server did not supply a usable total.
}

export interface InstallResult {
  success: boolean;
  reason: string;
  stage: OfflineStage;
  directory: string;
}

// 仅托管适配消费这些事实；旧进度和结果签名仍可独立使用。
export interface ManagedInstallProgress extends OfflineProgress {
  downloadTotalKnown?: boolean;
}

export enum InstallFactStage {
  PREPARING = 'preparing',
  DOWNLOADING = 'downloading',
  VERIFYING = 'verifying',
  EXTRACTING = 'extracting',
  PUBLISHING = 'publishing',
  CLEANUP = 'cleanup'
}

export interface ManagedInstallResult extends InstallResult {
  requestStarted: boolean;
  publishedRecord?: PackageRecord;
  httpStatus?: number;
  factStage: InstallFactStage;
  retryAfterMillis?: number;
  storageWriteFailed?: boolean;
}

export interface PackageObservation {
  directory: string;
  exists: boolean;
}

export class OfflineError extends Error {
  reason: string;
  stage: OfflineStage;
  constructor(reason: string, stage: OfflineStage = OfflineStage.PREPARING) {
    super(reason);
    this.reason = reason;
    this.stage = stage;
  }
}

export function packageDirectory(root: string, record: PackageRecord): string {
  if (!validRecord(record)) {
    throw new OfflineError('INVALID_CONFIG');
  }
  return `${root}/${record.version}`;
}

export function validRecord(record: PackageRecord): boolean {
  return Number.isSafeInteger(record.version) && record.version >= 10000 &&
    typeof record.sha256 === 'string' && /^[a-f0-9]{64}$/.test(record.sha256);
}
