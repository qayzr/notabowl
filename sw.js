const CACHE='notabowl-v3';
const ASSETS=['./','./index.html','./sync-core.mjs','./sheets-sync.mjs?v=3'];
self.addEventListener('install',event=>event.waitUntil(caches.open(CACHE).then(cache=>cache.addAll(ASSETS))));
self.addEventListener('activate',event=>event.waitUntil(Promise.all([caches.keys().then(keys=>Promise.all(keys.filter(key=>key.startsWith('notabowl-')&&key!==CACHE).map(key=>caches.delete(key)))),self.clients.claim()])));
self.addEventListener('fetch',event=>{
  const url=new URL(event.request.url);
  if(event.request.method!=='GET'||url.origin!==self.location.origin||!ASSETS.some(asset=>new URL(asset,self.registration.scope).href===url.href))return;
  event.respondWith(fetch(event.request).then(response=>{
    if(response.ok){const copy=response.clone();event.waitUntil(caches.open(CACHE).then(cache=>cache.put(event.request,copy)))}
    return response;
  }).catch(()=>caches.match(event.request).then(cached=>cached||Response.error())));
});
