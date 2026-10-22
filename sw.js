// Minimaler Service Worker, damit Browser die Seite als installierbare App anbieten.
// Es wird nichts zwischengespeichert: Die Seite lädt immer die aktuelle Fassung aus dem Netz.
self.addEventListener('install',()=>self.skipWaiting());
self.addEventListener('activate',e=>e.waitUntil(self.clients.claim()));
self.addEventListener('fetch',e=>{
  if(e.request.mode==='navigate'){
    e.respondWith(fetch(e.request).catch(()=>new Response('Keine Verbindung. Bitte später erneut versuchen.',{status:503,headers:{'Content-Type':'text/plain; charset=utf-8'}})));
  }
});
