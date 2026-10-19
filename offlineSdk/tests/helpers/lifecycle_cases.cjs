const assert = require('node:assert/strict');
const { types, A, B, config, harness, publicHarness, pending, turn, page } = require('./managed_fixture.cjs');
const cases = [];
function add(name, run) { cases.push({ name, run }); }
add('read failure never authorizes cleanup; a later successful read retries local initialization', async () => {
  const h=harness({empty:true});h.hooks.read=async()=>{throw new Error('read');};assert.equal(await h.prepare(),false);assert.equal(h.calls.some(c=>c.startsWith('cleanup:')),false);
  delete h.hooks.read;assert.equal(await h.prepare(),true);assert.equal(h.session.needsInitial(),true);
});
add('nonempty unusable active is not first-install eligibility and cannot be repaired or downgraded',async()=>{
  const h=harness();h.directories.clear();await h.prepare();assert.equal(h.session.needsInitial(),false);assert.equal(h.session.currentVersion(),undefined);
  await h.check(config(A));assert.equal(h.counts().installs,0);assert.equal(h.session.getState().active.version,A.version);
});
add('cold cleanup preserves unavailable ready directories and stage-specific ZIP files without cache ledgers',async()=>{
  const h=harness({media:{rows:[{...B,stage:'ready'},{version:10003,sha256:'c'.repeat(64),stage:'downloaded'}]},directories:new Map()});await h.prepare();
  assert.ok(h.calls.includes('cleanup:10002,10003.zip'));assert.equal(h.calls.some(c=>c.startsWith('activate:')),false);assert.equal(h.session.needsInitial(),false);
});
add('storage read error is never treated as malformed-but-empty lifecycle facts',async()=>{
  const h=harness();h.hooks.read=async()=>{throw new Error('invalid row');};assert.equal(await h.prepare(),false);assert.equal(h.session.getState().active,undefined);assert.equal(h.directories.has(A.version),true);
});
add('ready write failure cannot adopt B; nonnetwork budget permits exactly one extra attempt',async()=>{
  const h=harness();await h.prepare();h.hooks.stage=async(record,stage)=>stage!=='ready';
  for(let i=0;i<3;i++)await h.check();assert.equal(h.counts().installs,2);assert.equal(h.session.getState().active.version,A.version);assert.equal(h.events.filter(e=>e.kind==='PrepareFailed').length,2);assert.equal(h.events.some(e=>e.kind==='Prepared'),false);
});
add('owner cancellation during ready write waits finish, emits established Prepared and keeps in-use A',async()=>{
  const h=harness();await h.prepare();const writing=pending(),started=pending();h.hooks.stage=async(record,stage)=>{if(stage==='ready'){started.resolve();await writing.promise;}return true;};
  const token=h.cancel(),run=h.check(config(B),token);await started.promise;token.cancel();let settled=false;run.then(()=>{settled=true;});await turn();assert.equal(settled,false);writing.resolve();assert.equal((await run).outcome.success,true);assert.equal(h.session.getState().active.version,A.version);assert.equal(h.events.filter(e=>e.kind==='Prepared').length,1);
});
add('download cancellation reports no failure and does not consume package retry budget',async()=>{
  const h=harness();await h.prepare();h.hooks.install=async()=>({success:false,reason:'CANCELLED',requestStarted:true,factStage:'downloading'});
  await assert.rejects(h.check(),types.OfflineCancelledError);assert.equal(h.events.some(e=>e.kind==='PrepareFailed'),false);delete h.hooks.install;await h.check();assert.equal(h.counts().installs,2);
});
add('activation failure preserves ready success; later activation adds no duplicate installation report',async()=>{
  const h=harness({empty:true});await h.prepare();h.hooks.activate=async()=>{throw new Error('transaction');};assert.equal((await h.check()).outcome.success,true);assert.equal(h.media.rows[0].stage,'ready');
  delete h.hooks.activate;await h.check();assert.equal(h.session.getState().active.version,B.version);assert.equal(h.events.filter(e=>e.kind==='Prepared').length,1);assert.equal(h.counts().installs,1);
});
add('bound A does not prevent replacing an inactive partial B directory after registration',async()=>{
  const h=harness();await h.prepare();h.session.markPageBound();h.directories.set(B.version,'partial');await h.check();assert.equal(h.counts().installs,1);assert.equal(h.session.getState().active.version,A.version);assert.equal(h.directories.has(A.version),true);
});
add('page observations acquired before higher-target preparation cannot bypass the new online policy',async()=>{
  const h=harness();await h.prepare();const observed=await h.session.observePage(h.cancel());await h.check();assert.equal(h.session.finalBinding(observed,false),undefined);assert.equal(h.session.getState().active.version,A.version);
});
add('higher-target native work never blocks observation of the fixed in-use package',async()=>{
  const h=harness();await h.prepare();const native=pending(),started=pending();h.hooks.install=async()=>{started.resolve();await native.promise;return{success:false,reason:'DOWNLOAD',requestStarted:true,factStage:'downloading'};};
  const run=h.check();await started.promise;const observed=await h.session.observePage(h.cancel());assert.equal(observed.record.version,A.version);assert.equal(h.session.finalBinding(observed,false),undefined);native.resolve();await run;
});
add('disabled config requires no metadata and immediately revokes existing binding permission',async()=>{
  const h=harness();await h.prepare();const binding=h.session.finalBinding(await h.session.observePage(h.cancel()),false);await h.check({enabled:false});assert.equal(binding.isEnabled(),false);assert.equal(h.counts().installs,0);
});
add('same-version SHA conflict preserves the previous accepted policy and old binding',async()=>{
  const h=harness();await h.prepare();const observed=await h.session.observePage(h.cancel()),binding=h.session.finalBinding(observed,false);await h.check({...config(A),sha256:B.sha256});
  assert.equal(h.session.finalBinding(observed,false).version,A.version);assert.equal(binding.isEnabled(),true);assert.equal(h.calls.includes('cache'),false);assert.equal(h.counts().installs,0);
});
add('only first preparation checks foreground after config; silent work keeps its permission',async()=>{
  const h=harness();await h.prepare();assert.equal((await h.check(config(B),h.cancel(),()=>false,true)).deferred,true);assert.equal(h.counts().installs,0);
  assert.equal((await h.check(config(B),h.cancel(),()=>false,false)).outcome.success,true);
});
add('COMPLETE represents confirmed ready, known download100 caps99 and unknown remains indeterminate',async()=>{
  const h=harness();await h.prepare();h.hooks.install=async(target,callback)=>{callback({stage:'downloading',percent:100,downloadTotalKnown:true});callback({stage:'downloading',percent:100,downloadTotalKnown:false});return{success:true,requestStarted:true,factStage:'extracting'};};
  assert.equal((await h.check()).outcome.success,true);assert.deepEqual(h.progress.filter(p=>p.stage==='downloading').map(p=>p.percent),[99,-1]);assert.equal(h.progress.at(-1).stage,'complete');assert.equal(h.session.getState().active.version,A.version);
});
add('Welcome release is memory-only and live cancellation keeps the first gate retryable',async()=>{
  const h=harness({empty:true});await h.prepare();assert.equal(h.session.needsInitial(),true);const token=h.cancel();token.cancel();await assert.rejects(h.session.finishInitial(token),types.OfflineCancelledError);
  assert.equal(h.session.needsInitial(),true);await h.session.finishInitial(h.cancel());assert.equal(h.session.needsInitial(),false);assert.equal(h.media.rows.length,0);
});
add('policy publishes before synchronous cache cleanup and same-target retries never clear twice',async()=>{
  const h=harness();await h.prepare();const observed=await h.session.observePage(h.cancel());h.hooks.cleaner=()=>assert.equal(h.session.finalBinding(observed,false),undefined);
  h.hooks.install=async()=>({success:false,reason:'DOWNLOAD',requestStarted:true,factStage:'downloading'});await h.check();await h.check();assert.equal(h.calls.filter(c=>c==='cache').length,1);assert.ok(h.calls.indexOf('cache')<h.calls.indexOf('register:10002'));
});
add('cache cleaner failure is diagnostic once, does not block package preparation or retry on page loads',async()=>{
  const h=harness();await h.prepare();h.hooks.cleaner=()=>{throw new Error('cache');};await h.check();await h.session.observePage(h.cancel());await h.check();assert.equal(h.calls.filter(c=>c==='cache').length,1);assert.equal(h.events.filter(e=>e.kind==='Prepared').length,1);assert.equal(h.diagnostics.some(d=>d.reason==='CACHE_CLEAR'),true);
});
add('two package failures stop a target; higher target resets allowance and rollback cannot reset it',async()=>{
  const h=harness();await h.prepare();h.hooks.install=async()=>({success:false,reason:'HASH_MISMATCH',requestStarted:true,factStage:'verifying'});await h.check();await h.check();await h.check();assert.equal(h.counts().installs,2);
  await h.check(config(A));await h.check();assert.equal(h.counts().installs,2);await h.check(config({version:10003,sha256:'c'.repeat(64)}));assert.equal(h.counts().installs,3);
});
add('an unusable bound in-use package is never repaired in the same process',async()=>{
  const h=harness();await h.prepare();h.session.markPageBound();h.directories.clear();await h.prepare();await h.check(config(A));assert.equal(h.session.getState().usable,false);assert.equal(h.counts().installs,0);
});
add('runtime database reset or mislabelled A.ready cannot evict A files or block B.ready',async()=>{
  for(const rows of [[],[{...A,stage:'ready'}]]){const h=harness();await h.prepare();h.media.rows=rows;await h.check();assert.equal(h.session.getState().active.version,A.version);assert.equal(h.directories.has(A.version),true);assert.equal(h.media.rows.find(r=>r.version===B.version).stage,'ready');}
});
add('URL-only changes reuse the same cache-clear fact and ready result',async()=>{
  const h=harness();await h.prepare();await h.check();await h.check({...config(B),url:'https://fixture.test:8443/other.zip'});assert.equal(h.calls.filter(c=>c==='cache').length,1);assert.equal(h.counts().installs,1);
});
add('entry observation failure preserves fixed memory active and retries without runtime adoption',async()=>{
  const h=harness();await h.prepare();h.hooks.observe=async()=>{throw new Error('entry');};assert.equal(await h.prepare(),false);assert.equal(h.session.getState().active.version,A.version);
  delete h.hooks.observe;assert.equal(await h.prepare(),true);assert.equal(h.session.getState().active.version,A.version);
});
add('managed URL accepts explicit ports and rejects credentials/fragments before registration',async()=>{
  const h=harness();await h.prepare();for(const url of ['https://user:secret@fixture.test/a.zip','https://fixture.test/a.zip#x','file:///tmp/a.zip'])await h.check({...config(B),url});assert.equal(h.counts().installs,0);await h.check(config(B));assert.equal(h.counts().installs,1);
});
add('concurrent waiter cancellation is isolated while one provider/install completes',async()=>{
  const response=pending(),started=pending(),h=await publicHarness({empty:true,provider:async()=>{started.resolve();return response.promise;}});h.allow();const owner=h.sdk.prepareStartup();await started.promise;
  const token=h.cancel(),waiter=h.sdk.prepareStartup({cancellation:token});token.cancel();await assert.rejects(waiter,types.OfflineCancelledError);assert.equal(h.requests[0].cancellation.isCancelled,false);response.resolve(config(B));assert.equal((await owner).outcome.success,true);assert.equal(h.requests.length,1);await h.sdk.close();
});
add('owner cancellation waits native settlement and cancels all joined waiters without fake outcomes',async()=>{
  const h=await publicHarness({empty:true}),native=pending(),started=pending();h.hooks.install=async()=>{started.resolve();await native.promise;return{success:false,reason:'CANCELLED',requestStarted:true,factStage:'downloading'};};h.allow();
  const token=h.cancel(),owner=h.sdk.prepareStartup({cancellation:token});owner.catch(()=>{});await started.promise;const waiter=h.sdk.prepareStartup();waiter.catch(()=>{});token.cancel();let settled=false;owner.catch(()=>{settled=true;});await turn();assert.equal(settled,false);native.resolve();await assert.rejects(owner,types.OfflineCancelledError);await assert.rejects(waiter,types.OfflineCancelledError);assert.equal(h.outcomes.length,0);await h.sdk.close();
});
add('cancellation during ready finishing emits established success once but keeps Welcome unreleased',async()=>{
  const h=await publicHarness({empty:true}),writing=pending(),started=pending();h.hooks.stage=async(record,stage)=>{if(stage==='ready'){started.resolve();await writing.promise;}return true;};h.allow();const token=h.cancel(),run=h.sdk.prepareStartup({cancellation:token});run.catch(()=>{});await started.promise;token.cancel();writing.resolve();await assert.rejects(run,types.OfflineCancelledError);assert.equal(h.sdkEvents.filter(e=>e.kind==='Prepared').length,1);assert.equal(h.sdk.getState().initialFinished,false);await h.sdk.close();
});
add('ordinary preparation failure is reported after the shared permit releases',async()=>{
  let checking;const h=await publicHarness({empty:true,onOutcome:(_,sdk)=>{checking=sdk.getState().checking;}});h.hooks.install=async()=>({success:false,reason:'HASH_MISMATCH',requestStarted:true,factStage:'verifying'});h.allow();await h.sdk.prepareStartup();assert.equal(checking,false);assert.equal(h.outcomes.length,1);assert.equal(h.sdk.getState().initialFinished,true);await h.sdk.close();
});
add('normal first failure returns Continue without fake100 and provider faults remain diagnostic only',async()=>{
  const h=await publicHarness({empty:true});h.hooks.install=async()=>({success:false,reason:'DOWNLOAD',requestStarted:true,factStage:'downloading'});h.allow();const progress=[];assert.equal((await h.sdk.prepareStartup({onProgress:p=>progress.push(p)})).kind,'CONTINUE');await h.sdk.prepareStartup();assert.equal(h.requests.length,1);assert.equal(progress.some(p=>p.percent===100),false);await h.sdk.close();
  const failed=await publicHarness({empty:true,provider:async()=>{throw new Error('private');}});failed.allow();await failed.sdk.prepareStartup();assert.equal(failed.outcomes.length,0);assert.equal(JSON.stringify(failed.sdkEvents).includes('private'),false);await failed.sdk.close();
});
add('five-minute interval starts at real provider call and never creates a catch-up queue',async()=>{
  const h=await publicHarness({empty:true,start:1000,provider:async()=>{throw new Error('config');}});h.allow();await h.sdk.prepareStartup();assert.deepEqual(h.time.due(),[301000]);await h.time.advance(300999);assert.equal(h.requests.length,1);await h.time.advance(901000);assert.equal(h.requests.length,2);assert.deepEqual(h.time.due(),[1201000]);await h.sdk.close();
});
add('first foreground checkpoint after config defers, but background after download starts completes ready',async()=>{
  const response=pending(),started=pending(),h=await publicHarness({empty:true,provider:async()=>{started.resolve();return response.promise;}});h.allow();const run=h.sdk.prepareStartup();await started.promise;h.sdk.updateConditions({privacyAccepted:true,foreground:false});response.resolve(config(B));assert.equal((await run).kind,'DEFERRED');assert.equal(h.counts().installs,0);await h.sdk.close();
  const active=await publicHarness({empty:true}),native=pending(),began=pending();active.hooks.install=async()=>{began.resolve();await native.promise;return{success:true,requestStarted:true,factStage:'extracting'};};active.allow();const install=active.sdk.prepareStartup();await began.promise;active.sdk.updateConditions({privacyAccepted:true,foreground:false});native.resolve();assert.equal((await install).outcome.success,true);await active.sdk.close();
});
add('already-started silent provider returning in ordinary background continues preparation',async()=>{
  const response=pending(),started=pending(),h=await publicHarness({provider:async()=>{started.resolve();return response.promise;}});await h.sdk.prepareStartup();h.allow();await h.time.advance(0);await started.promise;h.sdk.updateConditions({privacyAccepted:true,foreground:false});response.resolve(config(B));await turn();assert.equal(h.counts().installs,1);assert.equal(h.media.rows.find(r=>r.version===B.version).stage,'ready');await h.sdk.close();
});
add('page loads never read or write a resource-cache ledger and keep original URL',async()=>{
  const h=await publicHarness();await h.sdk.prepareStartup();const original='https://fixture.test/site/index.html?token=a%2Fb#hash';for(let i=0;i<2;i++){const p=page();assert.equal((await h.sdk.loadPage(p,original)).offline,true);assert.deepEqual(p.urls,[original]);}assert.equal(h.calls.includes('cache'),false);await h.sdk.close();
});
add('cache exception does not change fixed old binding or cause repeated page cleanup',async()=>{
  const h=await publicHarness();await h.sdk.prepareStartup();const p=page();await h.sdk.loadPage(p,'http://fixture.test/index.html');h.hooks.cleaner=()=>{throw new Error('cache');};h.allow();await h.time.advance(0);assert.equal(p.binding.isEnabled(),true);assert.equal(h.calls.filter(c=>c==='cache').length,1);await h.sdk.loadPage(page(),'http://fixture.test/index.html');assert.equal(h.calls.filter(c=>c==='cache').length,1);await h.sdk.close();
});
add('privacy withdrawal and close preserve old binding while a new page after close loads online',async()=>{
  const h=await publicHarness();await h.sdk.prepareStartup();const p=page();await h.sdk.loadPage(p,'https://fixture.test/index.html');h.sdk.updateConditions({privacyAccepted:false,foreground:false});assert.equal(p.binding.isEnabled(),true);await h.sdk.close();assert.equal(p.binding.isEnabled(),true);const next=page();assert.equal((await h.sdk.loadPage(next,'https://fixture.test/index.html')).offline,false);
});
add('disabled policy stops old binding; cancelled page invocation cannot commit a load',async()=>{
  const h=await publicHarness({provider:async()=>({enabled:false})});await h.sdk.prepareStartup();const p=page();await h.sdk.loadPage(p,'https://fixture.test/index.html');h.allow();await h.time.advance(0);assert.equal(p.binding.isEnabled(),false);const token=h.cancel();token.cancel();const next=page();await assert.rejects(h.sdk.loadPage(next,'https://fixture.test/index.html',{cancellation:token}),types.OfflineCancelledError);assert.deepEqual(next.urls,[]);await h.sdk.close();
});
add('failure callback reentry joins the existing first lifetime without immediate retry',async()=>{
  let joined;const h=await publicHarness({empty:true,onOutcome:(_,sdk)=>{joined=sdk.prepareStartup();}});h.hooks.install=async()=>({success:false,reason:'DOWNLOAD',requestStarted:true,factStage:'downloading'});h.allow();await h.sdk.prepareStartup();await joined;assert.equal(h.requests.length,1);assert.equal(h.outcomes.length,1);await h.sdk.close();
});
add('privacy withdrawal cancels real owner and waits native settlement',async()=>{
  const h=await publicHarness({empty:true}),native=pending(),started=pending();h.hooks.install=async()=>{started.resolve();await native.promise;return{success:false,reason:'CANCELLED',requestStarted:true,factStage:'downloading'};};h.allow();const run=h.sdk.prepareStartup();run.catch(()=>{});await started.promise;h.sdk.updateConditions({privacyAccepted:false,foreground:true});assert.equal(h.counts().cancels,1);assert.equal(h.requests[0].cancellation.isCancelled,true);native.resolve();await assert.rejects(run,types.OfflineCancelledError);assert.equal(h.sdkEvents.some(e=>e.kind==='PrepareFailed'),false);await h.sdk.close();
});
add('a fresh session activates ready at cold initialization and adds no installation event',async()=>{
  const old=harness();await old.prepare();await old.check();assert.equal(old.session.getState().active.version,A.version);const cold=harness({media:old.media,directories:old.directories});await cold.prepare();assert.equal(cold.session.getState().active.version,B.version);assert.equal(cold.events.some(e=>e.kind==='Prepared'),false);
});
add('success callback can reenter and throw without revoking confirmed ready outcome',async()=>{
  let joined;const h=await publicHarness({empty:true,onOutcome:(_,sdk)=>{joined=sdk.prepareStartup();throw new Error('observer');}});h.allow();assert.equal((await h.sdk.prepareStartup()).outcome.success,true);await joined;assert.equal(h.requests.length,1);assert.equal(h.outcomes.length,1);await h.sdk.close();
});
add('waiter arriving during ready write receives the same shared terminal result',async()=>{
  const h=await publicHarness({empty:true}),writing=pending(),started=pending();h.hooks.stage=async(record,stage)=>{if(stage==='ready'){started.resolve();await writing.promise;}return true;};h.allow();const owner=h.sdk.prepareStartup();await started.promise;const waiter=h.sdk.prepareStartup();let settled=false;waiter.then(()=>{settled=true;});await turn();assert.equal(settled,false);writing.resolve();const [a,b]=await Promise.all([owner,waiter]);assert.equal(a.outcome.targetVersion,b.outcome.targetVersion);assert.equal(h.requests.length,1);await h.sdk.close();
});
add('pending ready write stays SAVING and zero-row failure never produces fake completion',async()=>{
  const h=await publicHarness({empty:true}),writing=pending(),started=pending(),progress=[];h.hooks.stage=async(record,stage)=>{if(stage==='ready'){started.resolve();await writing.promise;return false;}return true;};h.allow();const run=h.sdk.prepareStartup({onProgress:p=>progress.push(p)});await started.promise;assert.equal(progress.at(-1).stage,'saving');assert.equal(h.outcomes.length,0);writing.resolve();const result=await run;assert.equal(result.outcome.reason,'STORAGE_WRITE');assert.equal(result.outcome.stage,'PUBLISHING');assert.equal(progress.some(p=>p.percent===100),false);await h.sdk.close();
});
add('confirmed ready precedes Prepared and COMPLETE; activation remains best effort',async()=>{
  const h=harness({empty:true});await h.prepare();h.hooks.activate=async()=>{throw new Error('activation');};await h.check();assert.ok(h.calls.indexOf('ready:10002')<h.calls.indexOf('event:Prepared'));assert.ok(h.calls.indexOf('event:Prepared')<h.calls.indexOf('activate:10002'));assert.equal(h.progress.at(-1).stage,'complete');assert.equal(h.media.rows[0].stage,'ready');
});
add('silent compatibility outcomes observe released permit and fixed in-use A',async()=>{
  let checking;const h=await publicHarness({onOutcome:(_,sdk)=>{checking=sdk.getState().checking;}});await h.sdk.prepareStartup();h.allow();await h.time.advance(0);assert.equal(checking,false);assert.equal(h.outcomes.length,1);assert.equal(h.sdk.getState().active.version,A.version);assert.equal(h.media.rows.find(r=>r.version===B.version).stage,'ready');await h.sdk.close();
});
add('best-effort cold cleanup failure does not revoke known active or spin a zero-delay monitor',async()=>{
  const h=await publicHarness({provider:async()=>config(A)});h.hooks.cleanup=async()=>{throw new Error('cleanup');};await h.sdk.prepareStartup();h.allow();await h.time.advance(0);assert.equal(h.requests.length,1);assert.equal(h.sdk.getState().active.version,A.version);assert.deepEqual(h.time.due(),[300000]);await h.time.advance(299999);assert.equal(h.requests.length,1);await h.sdk.close();
});
add('unknown local read failures without provider origin yield once per full interval',async()=>{
  const h=await publicHarness({empty:true});h.hooks.read=async()=>{throw new Error('read');};h.allow();await h.sdk.prepareStartup();await h.time.advance(0);assert.equal(h.requests.length,0);assert.deepEqual(h.time.due(),[300000]);await h.time.advance(299999);assert.equal(h.requests.length,0);delete h.hooks.read;await h.time.advance(300000);assert.equal(h.requests.length,1);await h.sdk.close();
});
add('candidate reread failure uses actual provider origin and retains policy/cache facts',async()=>{
  const h=await publicHarness({provider:async()=>config(B)});await h.sdk.prepareStartup();h.hooks.read=async()=>{throw new Error('read');};h.allow();await h.time.advance(0);assert.equal(h.requests.length,1);assert.equal(h.calls.includes('cache'),false);assert.deepEqual(h.time.due(),[300000]);delete h.hooks.read;await h.time.advance(300000);assert.equal(h.requests.length,2);assert.equal(h.counts().installs,1);await h.sdk.close();
});
add('repeated conditions and page entries cannot reset a no-provider yield deadline',async()=>{
  const h=await publicHarness({empty:true});h.hooks.read=async()=>{throw new Error('read');};h.allow();await h.sdk.prepareStartup();await h.time.advance(0);for(let i=1;i<4;i++){await h.time.advance(i*10000);h.allow();await h.sdk.loadPage(page(),'http://fixture.test/index.html');assert.deepEqual(h.time.due(),[300000]);}assert.equal(h.requests.length,0);await h.sdk.close();
});
add('background/privacy/close stop monitor waits and resume never creates catch-up parallel work',async()=>{
  for(const stop of ['background','privacy','close']){const h=await publicHarness({provider:async()=>config(A)});await h.sdk.prepareStartup();h.allow();await h.time.advance(0);assert.equal(h.requests.length,1);if(stop==='close')await h.sdk.close();else h.sdk.updateConditions({privacyAccepted:stop!=='privacy',foreground:false});await h.time.advance(900000);assert.equal(h.requests.length,1);if(stop!=='close'){h.allow();await h.time.advance(900000);assert.equal(h.requests.length,2);await h.sdk.close();}}
});
add('long real provider retains its start and creates only one check when the interval expired',async()=>{
  const response=pending(),started=pending();let calls=0;const h=await publicHarness({provider:async()=>{if(++calls===1){started.resolve();return response.promise;}return config(A);}});await h.sdk.prepareStartup();h.allow();await h.time.advance(0);await started.promise;await h.time.advance(900000);h.allow();h.allow();assert.equal(h.requests.length,1);response.resolve(config(A));await turn();assert.deepEqual(h.time.due(),[900000]);await h.time.advance(900000);assert.equal(h.requests.length,2);assert.deepEqual(h.time.due(),[1200000]);await h.sdk.close();
});
module.exports = { cases };
