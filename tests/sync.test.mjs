import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {makeEvent,latest,eventRows,parseRows,hasConflicts,projectionRows,OWNER} from '../sync-core.mjs';
const profile={name:'Qayyum',hand:'right',style:'one',level:'intermediate',balls:[]};
test('unchanged state does not create duplicate events',()=>{
  const a=makeEvent([],'profile','owner',profile,'a');
  assert.equal(makeEvent([a],'profile','owner',profile),null);
});
test('revisions increment without relying on device clock',()=>{
  const a=makeEvent([],'profile','owner',profile,'a');
  assert.equal(makeEvent([a],'profile','owner',{...profile,name:'New'},'b').revision,2);
});
test('network retry duplicates restore as one logical event',()=>{
  const e=makeEvent([],'profile','owner',profile,'a');
  const rows=eventRows(e);assert.equal(parseRows([...rows,...rows]).length,1);
});
test('large records are chunked and reconstructed losslessly',()=>{
  const e=makeEvent([],'profile','owner',{...profile,name:'x'.repeat(65000)},'a');
  const rows=eventRows(e);assert.equal(rows.length,3);assert.deepEqual(parseRows(rows)[0].data,e.data);
});
test('partial uploads fail closed',()=>{
  const e=makeEvent([],'profile','owner',{...profile,name:'x'.repeat(65000)},'a');
  assert.throws(()=>parseRows(eventRows(e).slice(1)),/Incomplete/);
});
test('wrong owner and corrupt records are rejected',()=>{
  const rows=eventRows(makeEvent([],'profile','owner',profile,'a'));rows[0][1]='other@example.com';assert.throws(()=>parseRows(rows),/Unexpected/);
  rows[0][1]=OWNER;rows[0][8]='{"name":null}';assert.throws(()=>parseRows(rows),/Invalid/);
});
test('concurrent edits retain history and resolve deterministically',()=>{
  const a=makeEvent([],'profile','owner',profile,'a'),b=makeEvent([],'profile','owner',{...profile,name:'Other'},'b');
  assert.equal(hasConflicts([a,b]),true);assert.equal(latest([a,b]).get('profile:owner').id,'b');assert.equal(latest([b,a]).get('profile:owner').id,'b');
});
test('formula-like user text stays literal in the row model',()=>{
  const e=makeEvent([],'profile','owner',{...profile,balls:[{id:'b',name:'=IMPORTXML("bad")'}]},'a');
  assert.equal(projectionRows(e).Balls[0][4],'=IMPORTXML("bad")');
});

// Run the real inline app against a minimal DOM to exercise save/recovery hooks.
const html=readFileSync(new URL('../index.html',import.meta.url),'utf8');
test('app opens on Google sign-in before revealing bowling data',()=>{
  assert.match(html,/id="loginScreen"/);assert.match(html,/id="loginGoogleBtn"/);assert.match(html,/class="app hidden" id="app"/);
});
function boot(storage=new Map()){
  const elements=new Map();
  const element=id=>{
    if(elements.has(id))return elements.get(id);
    const hidden=new Set(['game','summary','history','profileEditor','frameSheet','resumeGameBtn'].includes(id)?['hidden']:[]);
    const el={value:'',style:{},dataset:{},textContent:'',innerHTML:'',childNodes:[],classList:{contains:x=>hidden.has(x),add:x=>hidden.add(x),remove:x=>hidden.delete(x),toggle(x,force){const on=force??!hidden.has(x);on?hidden.add(x):hidden.delete(x)}},addEventListener(){},querySelectorAll:()=>[],appendChild(){},setAttribute(){},focus(){}};
    elements.set(id,el);return el;
  };
  const listeners={};
  const context={document:{getElementById:element,querySelectorAll:()=>[],createElementNS:()=>element('svg'+Math.random()),addEventListener(){}},localStorage:{getItem:k=>storage.get(k)||null,setItem:(k,v)=>storage.set(k,v),removeItem:k=>storage.delete(k)},setTimeout(){},setInterval(){},clearInterval(){},alert(){},confirm:()=>true,CustomEvent:class{constructor(type,args){this.type=type;this.detail=args.detail}},console};
  context.window={addEventListener:(type,fn)=>listeners[type]=fn,dispatchEvent:e=>listeners[e.type]?.(e)};
  vm.createContext(context);const source=[...html.matchAll(/<script>([\s\S]*?)<\/script>/g)][0][1];const instrumented=source.replace(/\}\)\(\);\s*$/,'window.NotabowlTest={leadPin,genericSpareSetup,recommendedImpactLabel,trajectoryCompareMarkup,useRecommended,setPending(p){S.pendingPath=p},getDeckHit(){return deckHit}};})();');new vm.Script(instrumented).runInContext(context);
  context.window.NotabowlSync={};
  return {element,storage,data:context.window.NotabowlData,sync:context.window.NotabowlSync,logic:context.window.NotabowlTest};
}
test('spare recommendations identify the lead pin to hit',()=>{
  const app=boot(new Map([['bowlingNotesProfileV1',JSON.stringify(profile)]]));
  const recommendation=app.logic.genericSpareSetup([6,10]);
  assert.equal(app.logic.leadPin([6,10]),6);assert.equal(recommendation.hitPin,6);assert.equal(app.logic.genericSpareSetup([10]).hitPin,10);
  const comparison=app.logic.trajectoryCompareMarkup({feet:35,release:30,arrow:20,breakpoint:6,deckLabel:'Hit pin 6'},recommendation,[6,10]);
  assert.match(comparison,/Actual/);assert.match(comparison,/Recommended/);assert.match(comparison,/Pin 6/);
  assert.equal(app.logic.recommendedImpactLabel({entry:'1-3',hitPin:1},[1,2,3,4,5,6,7,8,9,10]),'1–3 pocket');
  app.logic.setPending({rackBefore:[6,10],recommended:recommendation});app.logic.useRecommended(null);assert.equal(app.logic.getDeckHit().label,'Hit pin 6');
  app.logic.setPending({rackBefore:[1,2,3,4,5,6,7,8,9,10],recommended:{...recommendation,entry:'1-3',hitPin:1}});app.logic.useRecommended(null);assert.equal(app.logic.getDeckHit().label,'1–3 pocket');
});
test('starting and recording a throw persist the active game before closure',()=>{
  const storage=new Map([['bowlingNotesProfileV1',JSON.stringify(profile)]]),app=boot(storage);
  app.element('startBtn').onclick();app.element('strikeBtn').onclick();
  const active=JSON.parse(storage.get('notabowlActiveV1'));assert.equal(active.frames[0].rolls[0],10);assert.equal(active.pendingPath.frame,1);
  const reload=boot(storage);assert.equal(reload.element('resumeGameBtn').classList.contains('hidden'),false);
  reload.element('resumeGameBtn').onclick();assert.equal(reload.element('game').classList.contains('hidden'),false);
});
test('ending repeatedly saves only one game and clears active recovery',()=>{
  const storage=new Map([['bowlingNotesProfileV1',JSON.stringify(profile)]]),app=boot(storage);
  app.element('startBtn').onclick();app.element('endBtn').onclick();app.element('endBtn').onclick();
  assert.equal(JSON.parse(storage.get('bowlingNotesGamesV1')).length,1);assert.equal(storage.has('notabowlActiveV1'),false);
});
test('clear all waits for cloud deletion before resetting local data',async()=>{
  const storage=new Map([['bowlingNotesProfileV1',JSON.stringify(profile)],['bowlingNotesGamesV1','[]'],['notabowlActiveV1','{}']]),app=boot(storage);
  let cloudCleared=false;app.sync.clearAll=async()=>{cloudCleared=true};
  await app.element('clearAllDataBtn').onclick({stopPropagation(){}});
  assert.equal(cloudCleared,true);assert.equal(storage.has('bowlingNotesProfileV1'),false);assert.equal(storage.has('bowlingNotesGamesV1'),false);assert.equal(storage.has('notabowlActiveV1'),false);
});
test('clear all keeps the device copy when cloud deletion fails',async()=>{
  const storage=new Map([['bowlingNotesProfileV1',JSON.stringify(profile)],['bowlingNotesGamesV1','[]']]),app=boot(storage);
  app.sync.clearAll=async()=>{throw new Error('Cloud unavailable')};
  await app.element('clearAllDataBtn').onclick({stopPropagation(){}});
  assert.equal(storage.has('bowlingNotesProfileV1'),true);assert.equal(storage.has('bowlingNotesGamesV1'),true);
});
