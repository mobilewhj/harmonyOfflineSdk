import { PackageRecord } from './OfflineTypes';

// 托管进度独立于旧低层阶段；未知比例保留 -1，不把发布或下载完成当作激活。
export enum ManagedProgressStage {
  CHECKING = 'checking', PREPARING = 'preparing', DOWNLOADING = 'downloading',
  VERIFYING = 'verifying', EXTRACTING = 'extracting', SAVING = 'saving',
  CONFIRMING = 'confirming', COMPLETE = 'complete'
}
export interface ManagedProgress { stage: ManagedProgressStage; percent: number; }
export enum ManagedFailureStage {
  LOCAL = 'LOCAL', CONFIG = 'CONFIG', REGISTER = 'REGISTER', SAVE_ENABLED = 'SAVE_ENABLED', PREPARING = 'PREPARING',
  DOWNLOADING = 'DOWNLOADING', VERIFYING = 'VERIFYING', EXTRACTING = 'EXTRACTING',
  PUBLISHING = 'PUBLISHING', CLEANUP = 'CLEANUP', SAVE_ACTIVE = 'SAVE_ACTIVE',
  VERIFY_ACTIVE = 'VERIFY_ACTIVE', HISTORY = 'HISTORY', RESOURCE_CACHE = 'RESOURCE_CACHE'
}
export enum ManagedFailureReason {
  CONFIGURATION = 'CONFIGURATION', LOCAL_STATE_READ = 'LOCAL_STATE_READ',
  STORAGE_WRITE = 'STORAGE_WRITE', REGISTER = 'REGISTER',
  SAVE_ENABLED = 'SAVE_ENABLED', INSTALL = 'INSTALL', TARGET_IN_USE = 'TARGET_IN_USE',
  SAVE_ACTIVE = 'SAVE_ACTIVE', VERIFY_ACTIVE = 'VERIFY_ACTIVE', HISTORY_SAVE = 'HISTORY_SAVE',
  CACHE_CLEAR = 'CACHE_CLEAR', CACHE_STATE_SAVE = 'CACHE_STATE_SAVE', ROOT_IN_USE = 'ROOT_IN_USE',
  UNSAFE_PATH = 'UNSAFE_PATH', CLOSED = 'CLOSED'
}
export enum ManagedInstallReason {
  INVALID_URL = 'INVALID_URL', INVALID_SOURCE = 'INVALID_SOURCE', HTTP_STATUS = 'HTTP_STATUS',
  DOWNLOAD = 'DOWNLOAD', TIMEOUT = 'TIMEOUT', DOWNLOAD_TIMEOUT = 'DOWNLOAD_TIMEOUT', DOWNLOAD_LENGTH = 'DOWNLOAD_LENGTH',
  SIZE_LIMIT = 'SIZE_LIMIT', HASH_MISMATCH = 'HASH_MISMATCH', INVALID_ARCHIVE = 'INVALID_ARCHIVE',
  UNSUPPORTED_ARCHIVE = 'UNSUPPORTED_ARCHIVE', CRC_MISMATCH = 'CRC_MISMATCH',
  DECOMPRESS_FAILED = 'DECOMPRESS_FAILED', MISSING_ENTRY = 'MISSING_ENTRY',
  TARGET_EXISTS = 'TARGET_EXISTS', FILE_IO = 'FILE_IO', CLEANUP = 'CLEANUP'
}
export interface InstallationSuccess {
  success: true;
  targetVersion: number;
  targetSha256: string;
}
export interface InstallationFailure {
  success: false;
  targetVersion: number;
  targetSha256: string;
  reason: ManagedFailureReason;
  stage: ManagedFailureStage;
  installReason?: ManagedInstallReason;
  httpStatus?: number;
  activeRollbackFailed?: boolean;
  detail?: string;
}
export type InstallationOutcome = InstallationSuccess | InstallationFailure;
export interface ManagedDiagnostic {
  reason: ManagedFailureReason;
  stage: ManagedFailureStage;
  targetVersion?: number;
  targetSha256?: string;
  detail?: string;
}
export interface ManagedConfig { enabled: boolean; version?: number; sha256?: string; url?: string; localArchive?: string; }

// Installation events are emitted only after the package-processing boundary.
export interface ManagedEvent {
  kind: 'Prepared' | 'PrepareFailed' | 'Diagnostic';
  record?: PackageRecord;
  failure?: InstallationFailure;
  activeVersion?: number;
  diagnostic?: ManagedDiagnostic;
}
export interface ManagedConditions { privacyAccepted: boolean; foreground: boolean; }
export interface ConfigRequest { currentVersion?: number; cancellation: OfflineCancellation; }
export interface OfflineKeyValueStore {
  readString(key: string): Promise<string | undefined>;
  writeString(key: string, value: string | undefined): Promise<boolean>;
  readBoolean(key: string): Promise<boolean | undefined>;
  writeBoolean(key: string, value: boolean): Promise<boolean>;
}
export interface PreparationHistory {
  initialPreparationFinished: boolean;
  latestFailure?: InstallationFailure;
}
export interface ManagedOptions {
  configProvider: (request: ConfigRequest) => Promise<ManagedConfig>;
  root?: string;
  minimumVersion?: number;
  checkIntervalMs?: number;
  // Legacy field retained for source compatibility; managed lifecycle never reads this ledger.
  keyValueStore?: OfflineKeyValueStore;
  resourceCacheCleaner?: () => void;
  onEvent?: (event: ManagedEvent) => void;
  onInstallationOutcome?: (outcome: InstallationOutcome) => void;
  onDiagnostic?: (diagnostic: ManagedDiagnostic) => void;
}
export enum StartupKind { CONTINUE = 'CONTINUE', DEFERRED = 'DEFERRED' }
export interface StartupResult { kind: StartupKind; outcome?: InstallationOutcome; }
export interface StartupOptions {
  cancellation?: OfflineCancellation;
  onProgress?: (progress: ManagedProgress) => void;
}
export interface PageLoadOptions { cancellation?: OfflineCancellation; }
export interface ArkWebPageOptions { resourceBaseUrl: string; shareHttpAndHttps?: boolean; }
export interface PageLoadResult { originalUrl: string; offline: boolean; version?: number; }
export interface ManagedState {
  active?: PackageRecord;
  usable: boolean;
  enabled: boolean;
  initialFinished: boolean;
  onlineVersion?: number;
  shaConflict: boolean;
  highestFailedVersion?: number;
  pagesBound: boolean;
  closed?: boolean;
  checking?: boolean;
}

export class OfflineCancelledError extends Error {
  constructor() { super('Offline operation cancelled'); this.name = 'OfflineCancelledError'; }
}
// 每次调用持有小句柄；等待者只能取消自己的等待，不能触碰 owner 的底层 signal。
export class OfflineCancellation {
  private cancelled: boolean = false;
  private listeners: Array<() => void> = [];
  get isCancelled(): boolean { return this.cancelled; }
  throwIfCancelled(): void { if (this.cancelled) { throw new OfflineCancelledError(); } }
  cancel(): void {
    if (this.cancelled) { return; }
    this.cancelled = true;
    const listeners = this.listeners;
    this.listeners = [];
    for (let listener of listeners) { try { listener(); } catch (_) {} }
  }
  onCancel(listener: () => void): () => void {
    if (this.cancelled) { listener(); return (): void => {}; }
    this.listeners.push(listener);
    return (): void => { this.listeners = this.listeners.filter((value: () => void) => value !== listener); };
  }
}
