export const OWNER = 'abd.qayyum.jumadi@gmail.com';
export const CLIENT_ID = '205426200730-6jdqic9b33efcm067fstg4dsc8ta1loo.apps.googleusercontent.com';
export const SHEET_ID = '1V79mV4Z43MJvTaJe1QqF8Pxym9omCm1R70r5I1u5xYc';
export const HEADERS = ['event_id','owner','entity','entity_id','revision','updated_at','part','parts','data_json'];
export const TABLES = ['Profiles','Games'];
export const PROJECTIONS = {
  Balls:['event_id','owner','ball_id','profile_revision','name','weight_lb','type','label'],
  Throws:['event_id','owner','throw_id','game_id','game_revision','frame','roll','pins','leave_json','path_json','feedback_json']
};
export function projectionRows(e) {
  if(e.type==='profile')return {Balls:e.data.balls.map(b=>[e.id,e.owner,b.id,e.revision,b.name,b.weight||'',b.type||'',b.label||''])};
  return {Throws:e.data.frames.flatMap((f,fi)=>f.rolls.map((pins,ri)=>[e.id,e.owner,e.entityId+':'+(fi+1)+':'+(ri+1),e.entityId,e.revision,fi+1,ri+1,pins,JSON.stringify(f.leaves[ri]||[]),JSON.stringify(f.paths?.[ri]||null),JSON.stringify(f.feedback?.[ri]||null)]))};
}

export function validData(type, data) {
  if (!data || typeof data !== 'object') return false;
  if (type === 'profile') return typeof data.name === 'string' && ['left','right'].includes(data.hand) && ['one','two'].includes(data.style) && ['beginner','intermediate','advanced'].includes(data.level) && Array.isArray(data.balls) && data.balls.every(b => b && typeof b.id === 'string' && typeof b.name === 'string');
  return type === 'game' && typeof data.startedAt === 'string' && Number.isFinite(Date.parse(data.startedAt)) && Number.isInteger(data.frame) && data.frame >= 1 && data.frame <= 10 && Array.isArray(data.frames) && data.frames.length === 10 && data.frames.every(f => f && Array.isArray(f.rolls) && f.rolls.length <= 3 && f.rolls.every(r => Number.isInteger(r) && r >= 0 && r <= 10) && Array.isArray(f.leaves)) && Array.isArray(data.rack) && Array.isArray(data.selected) && Array.isArray(data.flags);
}
export function latest(events) {
  const result = new Map();
  for (const e of events) {
    const key = e.type + ':' + e.entityId, old = result.get(key);
    if (!old || e.revision > old.revision || (e.revision === old.revision && e.id > old.id)) result.set(key,e);
  }
  return result;
}
export function makeEvent(events,type,entityId,data,id=crypto.randomUUID()) {
  if (!validData(type,data)) throw new Error('Invalid local record; export a backup before continuing.');
  const old = latest(events).get(type+':'+entityId);
  if (old && JSON.stringify(old.data) === JSON.stringify(data)) return null;
  return {id,owner:OWNER,type,entityId,revision:(old?.revision||0)+1,updatedAt:new Date().toISOString(),data:JSON.parse(JSON.stringify(data)),synced:false};
}
export function eventRows(e) {
  const json=JSON.stringify(e.data), parts=[];
  for(let i=0;i<json.length;i+=30000) parts.push(json.slice(i,i+30000));
  return parts.map((part,i)=>[e.id,e.owner,e.type,e.entityId,e.revision,e.updatedAt,i,parts.length,part]);
}
export function parseRows(rows) {
  const groups=new Map();
  for(const row of rows) {
    if(row[1] !== OWNER || !['profile','game'].includes(row[2])) throw new Error('Unexpected database record. Sync stopped to protect local data.');
    const key=row[0];
    if(!groups.has(key)) groups.set(key,[]);
    groups.get(key).push(row);
  }
  return [...groups.values()].map(group=>{
    const r=group[0], count=Number(r[7]), chunks=new Map();
    if(!Number.isInteger(count)||count<1||count>100) throw new Error('Invalid database record size.');
    for(const row of group) {
      if(JSON.stringify(row.slice(0,6))!==JSON.stringify(r.slice(0,6)) || Number(row[7])!==count) throw new Error('Conflicting database record.');
      const part=Number(row[6]);
      if(!Number.isInteger(part)||part<0||part>=count || (chunks.has(part)&&chunks.get(part)!==row[8])) throw new Error('Conflicting database record part.');
      chunks.set(part,row[8]);
    }
    if(chunks.size!==count) throw new Error('Incomplete database record. Retry sync.');
    const data=JSON.parse(Array.from({length:count},(_,i)=>chunks.get(i)).join(''));
    if(!validData(r[2],data)||!Number.isInteger(Number(r[4]))||Number(r[4])<1) throw new Error('Invalid database record.');
    return {id:r[0],owner:r[1],type:r[2],entityId:r[3],revision:Number(r[4]),updatedAt:r[5],data,synced:true};
  });
}
export function hasConflicts(events) {
  const seen=new Map();
  for(const e of events){const k=e.type+':'+e.entityId+':'+e.revision;const old=seen.get(k);if(old&&JSON.stringify(old.data)!==JSON.stringify(e.data))return true;seen.set(k,e)}
  return false;
}
