import {OWNER,CLIENT_ID,SHEET_ID,HEADERS,TABLES,PROJECTIONS,projectionRows,latest,makeEvent,eventRows,parseRows,hasConflicts} from './sync-core.mjs';

const status=document.getElementById('cloudStatus'), connect=document.getElementById('cloudConnect');
const syncButton=document.getElementById('cloudSync'), disconnect=document.getElementById('cloudDisconnect');
const loginScreen=document.getElementById('loginScreen'),loginButton=document.getElementById('loginGoogleBtn'),loginStatus=document.getElementById('loginStatus'),app=document.getElementById('app');
let token='',expires=0,busy=false,retry=0,timer,db,chain=Promise.resolve(),session=0;
const notify=text=>{status.textContent=text;if(loginStatus)loginStatus.textContent=text};
const showLogin=text=>{loginScreen.classList.remove('hidden');app.classList.add('hidden');if(text)notify(text)};
const showApp=()=>{loginScreen.classList.add('hidden');app.classList.remove('hidden')};
const ready=new Promise((resolve,reject)=>{
  const request=indexedDB.open('notabowl-sync-v1',1);
  request.onupgradeneeded=()=>request.result.createObjectStore('events',{keyPath:'id'});
  request.onsuccess=()=>{db=request.result;resolve()};
  request.onerror=()=>reject(new Error('Device storage unavailable. Export a backup.'));
});
async function records(){await ready;return new Promise((resolve,reject)=>{const r=db.transaction('events').objectStore('events').getAll();r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error)})}
async function put(events){await ready;if(!events.length)return;return new Promise((resolve,reject)=>{const tx=db.transaction('events','readwrite');for(const e of events)tx.objectStore('events').put(e);tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error)})}
async function clearRecords(){await ready;return new Promise((resolve,reject)=>{const tx=db.transaction('events','readwrite');tx.objectStore('events').clear();tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error)})}
function schedule(ms=2500){clearTimeout(timer);timer=setTimeout(()=>sync(),ms)}
function enqueue(type,entityId,data){
  const snapshot=JSON.parse(JSON.stringify(data));
  chain=chain.then(async()=>{const all=await records(),e=makeEvent(all,type,entityId,snapshot);if(e)await put([e]);if(e){notify(token?'Saved on device · waiting to sync':'Saved on device · connect Google to back up');schedule()}}).catch(error=>notify(error.message));
  return chain;
}
async function clearAll(){
  if(busy)throw new Error('A sync is already running. Wait a moment, then try again.');
  if(!navigator.onLine)throw new Error('Connect to the internet before clearing synced data.');
  if(!token)throw new Error('Connect Google Sheets before clearing all data.');
  busy=true;syncButton.disabled=true;clearTimeout(timer);session++;
  try{
    await chain;notify('Clearing data from Google Sheets…');
    await schema();
    await request('/values:batchClear',{ranges:[...TABLES,...Object.keys(PROJECTIONS)].map(name=>"'"+name+"'!A2:Z")});
    await clearRecords();retry=0;notify('All profile and game data cleared');
  }catch(error){notify(error.message||'Could not clear all data. Your device copy was kept.');throw error}
  finally{busy=false;syncButton.disabled=false}
}
window.NotabowlSync={enqueue,clearAll};
async function request(path,body){
  if(!token||Date.now()>=expires){token='';connect.classList.remove('hidden');showLogin('Your Google session expired. Sign in again to continue.');throw new Error('Saved on device · reconnect Google to sync.')}
  const response=await fetch('https://sheets.googleapis.com/v4/spreadsheets/'+SHEET_ID+path,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+token,...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(25000)});
  if(!response.ok){if(response.status===401){token='';connect.classList.remove('hidden');showLogin('Your Google session expired. Sign in again to continue.')}const error=new Error(response.status===403?'Google denied access. Check the Sheets API is enabled and Sheets access was granted.':response.status===401?'Saved on device · reconnect Google to sync.':'Sync failed ('+response.status+'). Your device copy is safe.');error.retryable=response.status===429||response.status>=500;throw error}
  return response.json();
}
async function schema(){
  const headers={...Object.fromEntries(TABLES.map(name=>[name,HEADERS])),...PROJECTIONS};
  let meta=await request('?fields=sheets.properties');
  const missing=Object.keys(headers).filter(name=>!meta.sheets.some(s=>s.properties.title===name));
  if(missing.length){
    try{await request(':batchUpdate',{requests:missing.map(title=>({addSheet:{properties:{title,gridProperties:{frozenRowCount:1}}}}))})}catch(error){meta=await request('?fields=sheets.properties');if(missing.some(name=>!meta.sheets.some(s=>s.properties.title===name)))throw error}
    meta=await request('?fields=sheets.properties');
  }
  const ids=Object.fromEntries(meta.sheets.map(s=>[s.properties.title,s.properties.sheetId]));
  for(const name of Object.keys(headers)){
    const header=await request('/values/'+encodeURIComponent("'"+name+"'!A1:"+String.fromCharCode(64+headers[name].length)+'1'));
    if(!header.values?.length){await request(':batchUpdate',{requests:[{updateCells:{start:{sheetId:ids[name],rowIndex:0,columnIndex:0},rows:[{values:headers[name].map(stringValue=>({userEnteredValue:{stringValue},userEnteredFormat:{textFormat:{bold:true},backgroundColor:{red:.85,green:.93,blue:.87}}}))}],fields:'userEnteredValue,userEnteredFormat'}}]})}
    else if(JSON.stringify(header.values[0])!==JSON.stringify(headers[name]))throw new Error(name+' tab has an incompatible layout. No data was overwritten.');
  }
  return ids;
}
async function readCloud(){
  const result=await request('/values:batchGet?'+TABLES.map(name=>'ranges='+encodeURIComponent("'"+name+"'!A2:I")).join('&'));
  return parseRows((result.valueRanges||[]).flatMap(r=>r.values||[]));
}
async function sync(){
  if(busy)return;
  if(!navigator.onLine){notify('Offline · changes saved on this device');return}
  if(!token){notify('Saved on device · connect Google to sync');return false}
  busy=true;syncButton.disabled=true;const run=session;
  try{
    await chain;notify('Syncing with Google Sheets…');
    const ids=await schema(),remote=await readCloud();
    if(run!==session)return;
    await put(remote); // Cloud acknowledgements are by immutable event ID.
    const pending=(await records()).filter(e=>!e.synced);
    // Small atomic batches keep retries bounded. A lost response is reconciled
    // by reading event IDs on the next attempt, before appending anything.
    for(let offset=0;offset<pending.length;offset+=10){
      if(run!==session)return;
      const batch=pending.slice(offset,offset+10);
      await request(':batchUpdate',{requests:[...TABLES,...Object.keys(PROJECTIONS)].flatMap(name=>{
        const rows=TABLES.includes(name)?batch.filter(e=>(e.type==='profile'?'Profiles':'Games')===name).flatMap(eventRows):batch.flatMap(e=>projectionRows(e)[name]||[]);
        return rows.length?[{appendCells:{sheetId:ids[name],rows:rows.map(row=>({values:row.map(value=>({userEnteredValue:typeof value==='number'?{numberValue:value}:{stringValue:String(value)}}))})),fields:'userEnteredValue'}}]:[];
      })});
      await put(batch.map(e=>({...e,synced:true})));
    }
    if(run!==session)return;
    await chain;const all=await records();retry=0;
    window.dispatchEvent(new CustomEvent('notabowl-cloud-data',{detail:[...latest(all).values()]}));
    notify(hasConflicts(all)?'Synced · concurrent edits kept in version history':all.some(e=>!e.synced)?'New changes waiting to sync':'Synced with Google Sheets · '+new Date().toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'}));
    schedule(all.some(e=>!e.synced)?2500:60000);
    return true;
  }catch(error){notify(error.message||'Connection interrupted · device copy is safe');if(token&&error.retryable!==false&&retry<6)schedule(Math.min(60000,2000*2**retry++)+Math.random()*1000);return false}
  finally{busy=false;syncButton.disabled=false}
}
function startConnect(){
  if(!navigator.onLine){notify('Connect to the internet to authorize Google.');return}
  if(!window.google?.accounts?.oauth2){notify('Google sign-in is still loading. Retry in a moment, or check your content blocker.');return}
  loginButton.disabled=true;notify('Opening Google sign-in…');
  const oauth=google.accounts.oauth2.initTokenClient({client_id:CLIENT_ID,scope:'https://www.googleapis.com/auth/spreadsheets openid email',hint:OWNER,prompt:'select_account',error_callback:()=>{loginButton.disabled=false;notify('Google connection cancelled. Your device data is safe.')},callback:async response=>{
    if(response.error){loginButton.disabled=false;notify('Google authorization was not completed. Try connecting again.');return}
    try{
      if(!google.accounts.oauth2.hasGrantedAllScopes(response,'https://www.googleapis.com/auth/spreadsheets','openid','email'))throw new Error('Please grant Sheets and account access to enable sync.');
      const identity=await fetch('https://openidconnect.googleapis.com/v1/userinfo',{headers:{Authorization:'Bearer '+response.access_token},signal:AbortSignal.timeout(15000)});
      if(!identity.ok)throw new Error('Could not verify your Google account.');
      const user=await identity.json();
      if(user.email!==OWNER||!user.email_verified)throw new Error('Please connect using the Google account that owns Notabowl.');
      token=response.access_token;expires=Date.now()+Number(response.expires_in)*1000-60000;session++;
      connect.classList.add('hidden');disconnect.classList.remove('hidden');syncButton.classList.remove('hidden');
      if(await sync())showApp();
    }catch(error){notify(error.message)}
    finally{loginButton.disabled=false}
  }});
  oauth.requestAccessToken();
}
connect.onclick=startConnect;loginButton.onclick=startConnect;
disconnect.onclick=()=>{session++;token='';expires=0;clearTimeout(timer);connect.classList.remove('hidden');disconnect.classList.add('hidden');syncButton.classList.add('hidden');showLogin('Signed out · data remains saved on this device and in Google Sheets')};
syncButton.onclick=()=>{retry=0;sync()};
window.addEventListener('online',()=>sync());
window.addEventListener('offline',()=>notify('Offline · changes saved on this device'));
document.addEventListener('visibilitychange',()=>{if(!document.hidden&&token)sync()});
window.addEventListener('notabowl-save',e=>enqueue(e.detail.type,e.detail.id,e.detail.data));
document.getElementById('cloudExport').onclick=async()=>{
  try{await chain;const backup={schemaVersion:1,exportedAt:new Date().toISOString(),events:await records(),legacy:window.NotabowlData.export()};const url=URL.createObjectURL(new Blob([JSON.stringify(backup,null,2)],{type:'application/json'}));const a=document.createElement('a');a.href=url;a.download='notabowl-backup-'+new Date().toISOString().slice(0,10)+'.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000)}catch(error){notify(error.message)}
};
// First import is deliberately local. Nothing leaves the device before consent.
try{
  await ready;
  const all=await records(),existing=latest(all),source=window.NotabowlData.export();
  if(source.profile)await enqueue('profile','owner',source.profile);
  for(const game of [...source.games,...(source.active?[source.active]:[])]){
    const id=game.id||game.startedAt;
    if(!existing.has('game:'+id)||source.active===game)await enqueue('game',id,game);
  }
  // Restore the event store after a browser closed between local save and sync.
  window.dispatchEvent(new CustomEvent('notabowl-cloud-data',{detail:[...latest(await records()).values()]}));
}catch(error){notify(error.message)}
