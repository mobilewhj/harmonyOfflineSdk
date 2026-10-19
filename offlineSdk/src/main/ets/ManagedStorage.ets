import { common } from '@kit.AbilityKit';
import { relationalStore } from '@kit.ArkData';
import { BusinessError } from '@kit.BasicServicesKit';
import { util } from '@kit.ArkTS';
import { cryptoFramework } from '@kit.CryptoArchitectureKit';
import { PackageRecord } from './OfflineTypes';

export enum PackageStage {
  DOWNLOADING = 'downloading', DOWNLOADED = 'downloaded', READY = 'ready', ACTIVE = 'active'
}
export interface LifecycleRecord extends PackageRecord { stage: PackageStage; }
// 仅供 SDK 会话与内部测试替身使用；业务宿主不实现另一套持久事实。
export interface ManagedStoragePort {
  load(): Promise<LifecycleRecord[]>;
  registerTarget(record: PackageRecord, inUseVersion?: number): Promise<void>;
  setStage(record: PackageRecord, stage: PackageStage): Promise<boolean>;
  activate(record: PackageRecord): Promise<void>;
  evictInactive(keepVersion?: number): Promise<void>;
}
export class PackageIdentityConflictError extends Error {
  constructor() { super('same_version_sha256_conflict'); this.name = 'PackageIdentityConflictError'; }
}
class StageWriteMiss extends Error {}

const TABLE = 'offline_package';
const SCHEMA_VERSION = 1;
const CREATE_TABLE = 'CREATE TABLE IF NOT EXISTS offline_package (' +
  'version INTEGER PRIMARY KEY, sha256 TEXT NOT NULL, stage TEXT NOT NULL, ' +
  "CHECK(typeof(version) = 'integer' AND version >= 0), " +
  "CHECK(length(sha256) = 64 AND sha256 NOT GLOB '*[^0-9a-f]*'), " +
  "CHECK(stage IN ('downloading', 'downloaded', 'ready', 'active')))";
const CREATE_ACTIVE_INDEX = "CREATE UNIQUE INDEX IF NOT EXISTS offline_package_one_active ON offline_package(stage) WHERE stage = 'active'";
const CREATE_READY_INDEX = "CREATE UNIQUE INDEX IF NOT EXISTS offline_package_one_ready ON offline_package(stage) WHERE stage = 'ready'";
const CREATE_SHA_TRIGGER = 'CREATE TRIGGER IF NOT EXISTS offline_package_immutable_sha ' +
  'BEFORE UPDATE OF sha256 ON offline_package WHEN NEW.sha256 != OLD.sha256 ' +
  "BEGIN SELECT RAISE(ABORT, 'same_version_sha256_conflict'); END";

function storageName(root: string): string {
  const digest = cryptoFramework.createMd('SHA256');
  digest.updateSync({ data: new util.TextEncoder().encodeInto(root) });
  let hash = '';
  for (const byte of digest.digestSync().data) { hash += byte.toString(16).padStart(2, '0'); }
  return 'offline-lifecycle-' + hash + '.db';
}
function validRecord(record: PackageRecord): boolean {
  return Number.isSafeInteger(record.version) && record.version >= 0 &&
    typeof record.sha256 === 'string' && /^[a-f0-9]{64}$/.test(record.sha256);
}
function corruptedDatabase(error: Error): boolean {
  return (error as BusinessError)?.code === 14800011;
}
function readStage(value: string): PackageStage {
  switch (value) {
    case PackageStage.DOWNLOADING: return PackageStage.DOWNLOADING;
    case PackageStage.DOWNLOADED: return PackageStage.DOWNLOADED;
    case PackageStage.READY: return PackageStage.READY;
    case PackageStage.ACTIVE: return PackageStage.ACTIVE;
    default: throw new Error('STORAGE_STAGE');
  }
}

// 原生失败游标可能返回 rowCount=-1、零列及 next=false，不能据 next 推断空表。
function readableColumns(cursor: relationalStore.ResultSet, names: string[], reason: string): number[] {
  const rows = cursor.rowCount;
  const count = cursor.columnCount;
  if (!Number.isSafeInteger(rows) || rows < 0 || !Number.isSafeInteger(count) || count < names.length) {
    throw new Error(reason);
  }
  const columns: number[] = [];
  for (const name of names) {
    const column = cursor.getColumnIndex(name);
    if (!Number.isSafeInteger(column) || column < 0 || column >= count || columns.includes(column)) {
      throw new Error(reason);
    }
    columns.push(column);
  }
  return columns;
}

// 所有读写都排在主 ArkTS 域的一条链上；RDB 对象不进入 TaskPool。
// 数据库用默认 databaseDir 和根摘要命名，包目录清理不会触及它；旧 Preferences 不读不删。
export class ManagedStorage implements ManagedStoragePort {
  private context: common.Context;
  private name: string;
  private store?: relationalStore.RdbStore;
  private chain: Promise<void> = Promise.resolve();

  constructor(context: common.Context, root: string) {
    this.context = context;
    this.name = storageName(root);
  }

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const result = this.chain.then(async (): Promise<T> => {
      try { return await work(); }
      catch (error) {
        // 确定损坏才释放缓存句柄；本次仍抛错，下次自然入口再交给平台恢复。
        if (corruptedDatabase(error as Error) && this.store) { await this.discardCorrupted(this.store); }
        throw error as Error;
      }
    });
    this.chain = result.then(() => {}, () => {});
    return result;
  }

  private async discardCorrupted(store: relationalStore.RdbStore): Promise<void> {
    // close 失败须向外抛出并保留句柄，不能假称关闭后并发重开。
    await store.close();
    if (this.store === store) { this.store = undefined; }
  }

  private async platformStore(): Promise<relationalStore.RdbStore> {
    const config: relationalStore.StoreConfig = {
      name: this.name, securityLevel: relationalStore.SecurityLevel.S1, allowRebuild: false
    };
    try { return await relationalStore.getRdbStore(this.context, config); }
    catch (error) {
      if (!corruptedDatabase(error as Error)) { throw error as Error; }
      // 只按平台确认的 14800011 重开一次；普通 IO/权限和迁移失败不授予重建资格。
      config.allowRebuild = true;
      return await relationalStore.getRdbStore(this.context, config);
    }
  }

  private async open(): Promise<relationalStore.RdbStore> {
    if (this.store) { return this.store; }
    const store = await this.platformStore();
    let began = false;
    try {
      const version = store.version;
      // 库版本属于平台结构元数据，未知版本拒绝打开，不能降级或清库重建。
      if (version !== 0 && version !== SCHEMA_VERSION) { throw new Error('STORAGE_SCHEMA_VERSION'); }
      // querySql 在 WAL 下读取独立连接；先校验已提交结构，不能在 DDL 事务内查询新表。
      // 只有尚无结构的 v0 库可首建；已登记版本缺表不能冒充恢复后的空库。
      const schemaExists = await this.verifySchema(store, version === 0);
      store.beginTransaction();
      began = true;
      await store.executeSql(CREATE_TABLE);
      await store.executeSql(CREATE_ACTIVE_INDEX);
      await store.executeSql(CREATE_READY_INDEX);
      await store.executeSql(CREATE_SHA_TRIGGER);
      if (version === 0) { store.version = SCHEMA_VERSION; }
      store.commit();
      began = false;
      // 新建结构提交后才对读取连接可见；索引、触发器与版本仍在同一事务确认。
      if (!schemaExists) { await this.verifySchema(store); }
      this.store = store;
      return store;
    } catch (error) {
      if (began) { try { store.rollBack(); } catch (_) {} }
      try { await store.close(); } catch (_) {}
      throw error as Error;
    }
  }

  private async verifySchema(store: relationalStore.RdbStore, allowAbsent: boolean = false): Promise<boolean> {
    const cursor = await store.querySql('PRAGMA table_info(offline_package)');
    const names: string[] = ['version', 'sha256', 'stage'];
    const types: string[] = ['INTEGER', 'TEXT', 'TEXT'];
    let count = 0;
    try {
      const columns = readableColumns(cursor, ['name', 'type', 'pk', 'notnull'], 'STORAGE_SCHEMA');
      while (cursor.goToNextRow()) {
        const name = cursor.getString(columns[0]);
        const type = cursor.getString(columns[1]);
        const primary = cursor.getLong(columns[2]);
        const notNull = cursor.getLong(columns[3]);
        if (count >= 3 || name !== names[count] || type.toUpperCase() !== types[count] ||
          primary !== (count === 0 ? 1 : 0) || count > 0 && notNull !== 1) {
          throw new Error('STORAGE_SCHEMA');
        }
        count++;
      }
      if (count !== cursor.rowCount) { throw new Error('STORAGE_SCHEMA'); }
      if (count === 0 && allowAbsent) { return false; }
      if (count !== 3) { throw new Error('STORAGE_SCHEMA'); }
      return true;
    } finally { cursor.close(); }
  }

  private async rows(store: relationalStore.RdbStore): Promise<LifecycleRecord[]> {
    const cursor = await store.querySql('SELECT version, sha256, stage, ' +
      'typeof(version) AS version_type, typeof(sha256) AS sha_type, typeof(stage) AS stage_type ' +
      'FROM offline_package ORDER BY version');
    const result: LifecycleRecord[] = [];
    let active = 0;
    let ready = 0;
    try {
      const columns = readableColumns(cursor, ['version', 'sha256', 'stage', 'version_type', 'sha_type', 'stage_type'],
        'STORAGE_READ');
      while (cursor.goToNextRow()) {
        if (cursor.getString(columns[3]) !== 'integer' ||
          cursor.getString(columns[4]) !== 'text' ||
          cursor.getString(columns[5]) !== 'text') {
          throw new Error('STORAGE_TYPE');
        }
        const record: LifecycleRecord = {
          version: cursor.getLong(columns[0]),
          sha256: cursor.getString(columns[1]),
          stage: readStage(cursor.getString(columns[2]))
        };
        if (!validRecord(record)) { throw new Error('STORAGE_RECORD'); }
        if (record.stage === PackageStage.ACTIVE) { active++; }
        if (record.stage === PackageStage.READY) { ready++; }
        if (active > 1 || ready > 1) { throw new Error('STORAGE_UNIQUENESS'); }
        result.push(record);
      }
      if (result.length !== cursor.rowCount) { throw new Error('STORAGE_READ'); }
      return result;
    } finally { cursor.close(); }
  }

  private async transaction<T>(work: (store: relationalStore.RdbStore) => Promise<T>): Promise<T> {
    const store = await this.open();
    store.beginTransaction();
    try {
      const result = await work(store);
      store.commit();
      return result;
    } catch (error) {
      try { store.rollBack(); } catch (rollbackError) {
        if (corruptedDatabase(error as Error) || corruptedDatabase(rollbackError as Error)) {
          await this.discardCorrupted(store);
        } else {
          // 一般回滚失败保留既有错误契约，不由此推断数据库已损坏。
          this.store = undefined;
          try { await store.close(); } catch (_) {}
        }
        throw new Error('STORAGE_ROLLBACK');
      }
      throw error as Error;
    }
  }

  load(): Promise<LifecycleRecord[]> { return this.serial(async () => this.rows(await this.open())); }

  registerTarget(record: PackageRecord, inUseVersion?: number): Promise<void> {
    return this.serial(async () => {
      if (!validRecord(record) || inUseVersion !== undefined && !Number.isSafeInteger(inUseVersion)) {
        throw new Error('STORAGE_RECORD');
      }
      await this.transaction(async (store: relationalStore.RdbStore) => {
        // 整组读取失败或同号冲突都发生在任何淘汰之前，调用方随后才可清理包文件。
        const existing = (await this.rows(store)).find((row: LifecycleRecord) => row.version === record.version);
        if (existing && existing.sha256 !== record.sha256) { throw new PackageIdentityConflictError(); }
        if (!existing) {
          await store.executeSql('INSERT INTO offline_package(version, sha256, stage) VALUES (?, ?, ?)',
            [record.version, record.sha256, PackageStage.DOWNLOADING]);
        }
        // 数据库只保留 active 与目标；运行中内存的在用目录由会话在删文件处保护。
        // 不能额外保留被重建成 ready 的旧在用行，否则会阻断新目标的 ready 确认。
        await store.executeSql("DELETE FROM offline_package WHERE version != ? AND stage != 'active'", [record.version]);
      });
    });
  }

  setStage(record: PackageRecord, stage: PackageStage): Promise<boolean> {
    return this.serial(async () => {
      if (!validRecord(record)) { throw new Error('STORAGE_RECORD'); }
      readStage(stage);
      if (stage === PackageStage.ACTIVE) { return false; }
      try {
        return await this.transaction(async (store: relationalStore.RdbStore) => {
          const rows = await this.rows(store);
          const existing = rows.find((row: LifecycleRecord) =>
            row.version === record.version && row.sha256 === record.sha256);
          if (!existing || existing.stage === PackageStage.ACTIVE) { return false; }
          if (stage === PackageStage.READY && rows.some((row: LifecycleRecord) =>
            row.stage === PackageStage.READY && row.version !== record.version)) { return false; }
          const predicates = new relationalStore.RdbPredicates(TABLE).equalTo('version', record.version)
            .and().equalTo('sha256', record.sha256).and().notEqualTo('stage', PackageStage.ACTIVE);
          const count = await store.update({ stage }, predicates);
          // 零行不能确认 ready，也不能向调用方伪造安装成功。
          if (count === 0) { throw new StageWriteMiss(); }
          if (count !== 1) { throw new Error('STORAGE_STAGE_WRITE'); }
          return true;
        });
      } catch (error) { if (error instanceof StageWriteMiss) { return false; } throw error as Error; }
    });
  }

  activate(record: PackageRecord): Promise<void> {
    return this.serial(async () => {
      if (!validRecord(record)) { throw new Error('STORAGE_RECORD'); }
      await this.transaction(async (store: relationalStore.RdbStore) => {
        const target = (await this.rows(store)).find((row: LifecycleRecord) =>
          row.version === record.version && row.sha256 === record.sha256);
        if (!target || target.stage !== PackageStage.READY && target.stage !== PackageStage.ACTIVE) {
          throw new Error('STORAGE_READY_MISSING');
        }
        if (target.stage === PackageStage.ACTIVE) { return; }
        await store.executeSql("DELETE FROM offline_package WHERE stage = 'active' AND version != ?", [record.version]);
        const predicates = new relationalStore.RdbPredicates(TABLE).equalTo('version', record.version)
          .and().equalTo('sha256', record.sha256).and().equalTo('stage', PackageStage.READY);
        if (await store.update({ stage: PackageStage.ACTIVE }, predicates) !== 1) {
          throw new Error('STORAGE_READY_MISSING');
        }
      });
    });
  }

  evictInactive(keepVersion?: number): Promise<void> {
    return this.serial(async () => {
      if (keepVersion === undefined) { return; }
      if (!Number.isSafeInteger(keepVersion)) { throw new Error('STORAGE_RECORD'); }
      await this.transaction(async (store: relationalStore.RdbStore) => {
        const keep = (await this.rows(store)).find((row: LifecycleRecord) => row.version === keepVersion);
        // 缺失或非 active 记录不能为运行中数据库重建后的清理提供资格。
        if (!keep || keep.stage !== PackageStage.ACTIVE) { return; }
        await store.executeSql("DELETE FROM offline_package WHERE stage != 'active' AND version != ?", [keepVersion]);
      });
    });
  }
}
