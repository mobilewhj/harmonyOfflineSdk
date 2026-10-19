const fs = require('node:fs');
const assert = require('node:assert/strict');
const { test, after } = require('node:test');
const { types, A, B, config, harness, publicHarness, pending, turn, page } = require('./helpers/managed_fixture.cjs');
const native = require('./helpers/worker_runtime.cjs');
after(() => native.cleanup());
function workerSetup(options={}) {
  const f=native.fixture(native.benign),progress=[],root=f.root+'/managed';
  const spec={...native.packageSpec(f),version:10002,...options.spec};
  const worker=native.installWorker(f,native.platform(f),progress,options);
  return {f,root,spec,worker,progress,signal:new SharedArrayBuffer(4)};
}
function realInstaller(worker) {
  class Task {constructor(fn,...args){this.fn=fn;this.args=args;}onReceiveData(callback){this.progress=callback;}}
  return native.load('PackageInstaller',{'@kit.ArkTS':{taskpool:{Task,execute:async task=>task.fn(...task.args)}},
    './InstallWorker':worker,'./PackageFiles':native.files,'./OfflineTypes':native.types});
}
for(const fault of ['register','preflight'])test(fault+' failure is Diagnostic yet consumes the same two-attempt preparation allowance',async()=>{
  const h=harness();await h.prepare();if(fault==='register')h.hooks.register=async()=>{throw new Error('write');};
  else h.hooks.install=async()=>({success:false,reason:'FILE_IO',requestStarted:false,factStage:'preparing'});
  for(let i=0;i<4;i++)await h.check();assert.equal(h.calls.filter(c=>c==='register:10002').length,2);
  assert.equal(h.events.filter(e=>e.kind==='Diagnostic').length,2);assert.equal(h.events.some(e=>e.kind==='PrepareFailed'),false);
});
for(const status of [408,429,500,502,503,504])test('HTTP'+status+' remains network-retryable beyond two attempts',async()=>{
  const h=harness();await h.prepare();h.hooks.install=async()=>({success:false,reason:'HTTP_'+status,httpStatus:status,requestStarted:true,factStage:'downloading'});
  for(let i=0;i<3;i++)await h.check();assert.equal(h.counts().installs,3);assert.equal(h.events.filter(e=>e.kind==='PrepareFailed').length,3);
});
test('valid ZIP reuse enters processing before a failed downloaded-stage write without fetching',async()=>{
  const h=workerSetup(),api=realInstaller(h.worker),installer=await api.claimManagedRoot(h.root);
  h.worker.managedArchiveReusable(h.root,h.spec,h.signal);fs.copyFileSync(h.f.zip,h.root+'/10002.zip');
  const result=await installer.installManaged(h.root,h.spec,()=>{},async stage=>{assert.equal(stage,'downloaded');throw new Error('0 rows');});
  assert.equal(result.success,false);assert.equal(result.requestStarted,true);assert.equal(result.storageWriteFailed,true);
  assert.equal(fs.existsSync(h.root+'/10002.zip'),true);
});
test('ZIP SHA read failure is pre-processing, never interpreted as a missing reusable ZIP',async()=>{
  const h=workerSetup();h.worker.managedArchiveReusable(h.root,h.spec,h.signal);fs.copyFileSync(h.f.zip,h.root+'/10002.zip');
  const read=native.io.readSync;native.io.readSync=()=>{throw new Error('disk');};
  try{assert.throws(()=>h.worker.managedArchiveReusable(h.root,h.spec,h.signal),/disk/);}finally{native.io.readSync=read;}
});
test('Local missing input fails inside actual open boundary with DOWNLOAD/FILE_IO and no fabricated HTTP',async()=>{
  const h=workerSetup();h.spec.localArchive=h.f.root+'/missing.zip';assert.equal(h.worker.managedArchiveReusable(h.root,h.spec,h.signal),false);
  const result=await h.worker.runManagedDownload(h.root,h.spec,h.signal);assert.equal(result.requestStarted,true);assert.equal(result.factStage,'downloading');assert.equal(result.reason,'FILE_IO');assert.equal(result.httpStatus,undefined);assert.equal(fs.existsSync(h.root+'/10002.zip'),false);
});
test('Local output open failure stays pre-processing Diagnostic eligibility',async()=>{
  const h=workerSetup();h.spec.localArchive=h.f.zip;h.worker.managedArchiveReusable(h.root,h.spec,h.signal);const open=native.io.openSync;
  native.io.openSync=(file,flags)=>{if(file===h.root+'/10002.zip')throw new Error('output');return open(file,flags);};
  try{const result=await h.worker.runManagedDownload(h.root,h.spec,h.signal);assert.equal(result.requestStarted,false);assert.equal(result.reason,'FILE_IO');}finally{native.io.openSync=open;}
});
test('zero-byte Remote connection failure counts as a real download attempt and leaves no ZIP',async()=>{
  let attempts=0;const h=workerSetup({session:{close(){},cancel(){},async fetch(){attempts++;throw new Error('connect');}}});
  h.worker.managedArchiveReusable(h.root,h.spec,h.signal);const result=await h.worker.runManagedDownload(h.root,h.spec,h.signal);
  assert.equal(attempts,1);assert.equal(result.requestStarted,true);assert.equal(result.reason,'DOWNLOAD');assert.equal(result.httpStatus,undefined);assert.equal(fs.existsSync(h.root+'/10002.zip'),false);
});
test('Remote deadline timeout never retains an HTTP200 response status',async()=>{
  let now=0;const h=workerSetup({clock:{TimeType:{STARTUP:0},getUptime:()=>now},session:{close(){},cancel(){},async fetch(){now=120000;return{statusCode:200,headers:{}};}}});
  h.worker.managedArchiveReusable(h.root,h.spec,h.signal);const result=await h.worker.runManagedDownload(h.root,h.spec,h.signal);
  assert.equal(result.reason,'TIMEOUT');assert.equal(result.requestStarted,true);assert.equal(result.httpStatus,undefined);
});
test('hash mismatch preserves VERIFY classification without unrelated successful HTTP status',async()=>{
  const h=workerSetup({spec:{sha256:'0'.repeat(64)}});h.worker.managedArchiveReusable(h.root,h.spec,h.signal);
  const result=await h.worker.runManagedDownload(h.root,h.spec,h.signal);assert.equal(result.reason,'HASH_MISMATCH');assert.equal(result.factStage,'verifying');assert.equal(result.httpStatus,undefined);assert.equal(fs.existsSync(h.root+'/10002.zip'),false);
});
test('Retry-After accepts integer seconds only and does not consume the nonnetwork budget',async()=>{
  for(const [header,expected]of[['600',600000],['-1',undefined],['Wed, 21 Oct 2030 07:28:00 GMT',undefined],['999999999999999999',undefined]]){
    const h=workerSetup({session:{close(){},cancel(){},async fetch(){return{statusCode:503,headers:{'retry-after':header}};}}});
    h.worker.managedArchiveReusable(h.root,h.spec,h.signal);const result=await h.worker.runManagedDownload(h.root,h.spec,h.signal);assert.equal(result.retryAfterMillis,expected);assert.equal(result.httpStatus,503);
  }
  const h=harness();await h.prepare();h.hooks.install=async()=>({success:false,reason:'HTTP_503',httpStatus:503,requestStarted:true,retryAfterMillis:600000,factStage:'downloading'});
  await h.check();h.setNow(300000);await h.check();assert.equal(h.counts().installs,1);h.setNow(600000);await h.check();assert.equal(h.counts().installs,2);
});
test('first successful empty read survives canceled cold cleanup without recomputing from later rows',async()=>{
  const h=harness({empty:true}),waiting=pending(),started=pending();h.hooks.cleanup=async()=>{started.resolve();await waiting.promise;};const token=h.cancel(),run=h.prepare(token);run.catch(()=>{});await started.promise;token.cancel();waiting.resolve();await assert.rejects(run,types.OfflineCancelledError);
  delete h.hooks.cleanup;h.media.rows=[{...A,stage:'active'}];h.directories.set(A.version,'/A');await h.prepare();assert.equal(h.session.needsInitial(),true);assert.equal(h.session.getState().active.version,A.version);
});
test('concurrent Welcome decisions cannot reopen a gate released by an unknown local read',async()=>{
  const h=await publicHarness({empty:true});let reads=0;h.hooks.read=async()=>{if(++reads===1)throw new Error('first read');return[];};
  const [a,b]=await Promise.all([h.sdk.prepareStartup(),h.sdk.prepareStartup()]);assert.equal(a.kind,'CONTINUE');assert.equal(b.kind,'CONTINUE');assert.equal(h.sdk.getState().initialFinished,true);assert.equal(h.requests.length,0);await h.sdk.close();
});
test('page-only failed observation does not change usable fact; final bind rejects a concurrent global unusable refresh',async()=>{
  const h=harness();await h.prepare();const observed=await h.session.observePage(h.cancel());h.hooks.observe=async()=>({directory:'',exists:true});
  const failed=await h.session.observePage(h.cancel());assert.equal(h.session.finalBinding(failed,false),undefined);assert.equal(h.session.getState().usable,true);
  await h.prepare();assert.equal(h.session.getState().usable,false);assert.equal(h.session.finalBinding(observed,false),undefined);
});
test('cold failed ready activation preserves both directories and the previous active',async()=>{
  const h=harness({media:{rows:[{...A,stage:'active'},{...B,stage:'ready'}]},directories:new Map([[A.version,'/A'],[B.version,'/B']])});h.hooks.activate=async()=>{throw new Error('rollback');};await h.prepare();
  assert.equal(h.session.getState().active.version,A.version);assert.equal(h.directories.size,2);assert.equal(h.events.some(e=>e.kind==='Prepared'),false);
});
test('committed activation plus failed directory observation fixes an unusable in-use B identity',async()=>{
  const h=harness({empty:true});await h.prepare();h.hooks.observe=async record=>{if(record.version===B.version)throw new Error('entry');return{directory:'/other',exists:true};};
  await h.check();assert.equal(h.media.rows[0].stage,'active');assert.equal(h.session.getState().active.version,B.version);assert.equal(h.session.getState().usable,false);
  await h.check(config({version:10003,sha256:'c'.repeat(64)}));assert.equal(h.session.getState().active.version,B.version);assert.equal(h.media.rows.find(r=>r.version===10003).stage,'ready');
});
test('page cancellation after observation but before UI commit loads nothing',async()=>{
  const h=await publicHarness();await h.sdk.prepareStartup();const token=h.cancel(),p=page({scope:()=>token.cancel()});
  await assert.rejects(h.sdk.loadPage(p,'https://fixture.test/index.html',{cancellation:token}),types.OfflineCancelledError);assert.deepEqual(p.urls,[]);await h.sdk.close();
});
test('cancelled ready finish offers compatibility success after permit release and reentry joins canceled owner',async()=>{
  let joined,checking;const h=await publicHarness({empty:true,onOutcome:(_,sdk)=>{checking=sdk.getState().checking;joined=sdk.prepareStartup();joined.catch(()=>{});}}),writing=pending(),started=pending();
  h.hooks.stage=async(record,stage)=>{if(stage==='ready'){started.resolve();await writing.promise;}return true;};h.allow();const token=h.cancel(),run=h.sdk.prepareStartup({cancellation:token});run.catch(()=>{});await started.promise;token.cancel();writing.resolve();await assert.rejects(run,types.OfflineCancelledError);await assert.rejects(joined,types.OfflineCancelledError);assert.equal(checking,false);assert.equal(h.outcomes.length,1);await h.sdk.close();
});
test('SDK clock uses STARTUP uptime with millisecond mode',async()=>{
  const h=await publicHarness({empty:true});h.allow();await h.sdk.prepareStartup();assert.equal(h.requests[0].at,0);assert.deepEqual(h.time.due(),[300000]);assert.ok(h.time.clockCalls.length>0);assert.ok(h.time.clockCalls.every(args=>args[0]===0&&args[1]===false));await h.sdk.close();
});
test('expired provider TTL with a pre-provider observation failure yields a complete interval',async()=>{
  const h=await publicHarness({provider:async()=>config(A)});await h.sdk.prepareStartup();h.allow();await h.time.advance(0);h.hooks.observe=async()=>{throw new Error('observation');};await h.time.advance(900000);
  assert.equal(h.requests.length,1);assert.deepEqual(h.time.due(),[1200000]);delete h.hooks.observe;await h.time.advance(1200000);assert.equal(h.requests.length,2);await h.sdk.close();
});
test('no-provider yield survives privacy/background resume before the deadline',async()=>{
  for(const privacy of [false,true]){const h=await publicHarness({empty:true});h.hooks.read=async()=>{throw new Error('read');};h.allow();await h.sdk.prepareStartup();await h.time.advance(0);await h.time.advance(100000);h.sdk.updateConditions({privacyAccepted:privacy,foreground:false});await h.time.advance(150000);h.allow();assert.deepEqual(h.time.due(),[300000]);await h.time.advance(299999);assert.equal(h.requests.length,0);await h.sdk.close();}
});
test('silent cold-load work rechecks foreground before provider, while established checks retain background permission',async()=>{
  const h=await publicHarness({empty:true}),reading=pending(),started=pending();let first=true;h.hooks.read=async()=>{if(first){first=false;throw new Error('initial');}started.resolve();await reading.promise;return[];};h.allow();await h.sdk.prepareStartup();await h.time.advance(0);await started.promise;h.sdk.updateConditions({privacyAccepted:true,foreground:false});reading.resolve();await turn();assert.equal(h.requests.length,0);await h.sdk.close();
});

test('managed create rejects database-overlapping roots before any writer claim and rejects old storage injection',async()=>{
  let claims=0;
  const {load}=require('./helpers/managed_fixture.cjs');
  const {ManagedOfflineSdk}=load('ManagedOfflineSdk',{'@kit.AbilityKit':{},'@kit.BasicServicesKit':{},
    './PackageInstaller':{normalizePackageRoot:value=>value,claimManagedRoot:async()=>{claims++;return{};}},
    './ManagedStorage':{},'./ManagedPackageSession':{},'./ManagedPage':{},'./ManagedOfflineTypes':types});
  const context={filesDir:'/sandbox/files',preferencesDir:'/sandbox/prefs',databaseDir:'/sandbox/database'};
  for(const root of ['/sandbox','/sandbox/database','/sandbox/database/child'])await assert.rejects(
    ManagedOfflineSdk.create(context,{root,configProvider:async()=>({enabled:false})}),/overlaps relational storage/);
  await assert.rejects(ManagedOfflineSdk.create(context,{keyValueStore:{},configProvider:async()=>({enabled:false})}),/requires SDK relational storage/);
  assert.equal(claims,0);
});
for(const known of [false,true])test((known?'known':'unknown')+' download progress is throttled at the producer and retains a terminal byte tail',async()=>{
  let bytes;
  const h=workerSetup({session:{close(){},cancel(){},async fetch(request){
    const events=request.configuration.tracing.httpEventsHandler;
    if(known)events.onDownloadProgress(bytes.length,0);
    for(let i=0;i<4;i++){
      await new Promise(resolve=>setTimeout(resolve,90));
      const chunk=bytes.subarray(Math.floor(i*bytes.length/4),Math.floor((i+1)*bytes.length/4));
      events.onDataReceive(chunk.buffer.slice(chunk.byteOffset,chunk.byteOffset+chunk.byteLength));
    }
    return{statusCode:200,headers:{}};
  }}});
  bytes=fs.readFileSync(h.f.zip);h.worker.managedArchiveReusable(h.root,h.spec,h.signal);
  assert.equal((await h.worker.runManagedDownload(h.root,h.spec,h.signal)).success,true);
  const progress=h.progress.filter(value=>value.stage==='downloading');
  assert.equal(progress.at(-1).percent,100);
  if(known){for(let i=1;i<progress.length;i++)assert.notEqual(progress[i].percent,progress[i-1].percent);}
  else{assert.equal(progress.length,2,'unknown sub-step chunks emit first and tail instead of every polling tick');assert.equal(progress.every(value=>value.downloadTotalKnown===false),true);}
});
