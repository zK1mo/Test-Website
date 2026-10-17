// Holt die Spielzeit aller Spieler per FTP vom Minecraft-Server und speichert sie in Supabase.
import {Client} from 'basic-ftp';
import {Writable} from 'node:stream';

const E=process.env;
const need=k=>{if(!E[k]){console.error('Fehlt: '+k);process.exit(1)}return E[k]};
const HOST=need('FTP_HOST'),USER=need('FTP_USER'),PASS=need('FTP_PASS');
const SB=need('SUPABASE_URL').replace(/\/$/,''),KEY=need('SUPABASE_SERVICE_KEY');
const PORT=Number(E.FTP_PORT||21),WORLD=E.WORLD_DIR||'world',SECURE=E.FTP_SECURE==='true';
const EXCL=(E.EXCLUDE_NAMES||'').split(',').map(s=>s.trim().toLowerCase()).filter(Boolean);

// Spielzeit in Ticks (20 Ticks = 1 Sekunde); ältere Versionen nutzen play_one_minute
const ticksOf=s=>{const c=(s&&s.stats&&s.stats['minecraft:custom'])||{};return c['minecraft:play_time']??c['minecraft:play_one_minute']??0};

const H={apikey:KEY,'Content-Type':'application/json'};
if(!KEY.startsWith('sb_'))H.Authorization='Bearer '+KEY;

const client=new Client(30000);
const read=async p=>{const ch=[];await client.downloadTo(new Writable({write(c,_,cb){ch.push(c);cb()}}),p);return Buffer.concat(ch).toString('utf8')};

try{
  await client.access({host:HOST,port:PORT,user:USER,password:PASS,secure:SECURE});
  let dir=null,files=[];
  for(const d of [`${WORLD}/players/stats`,`${WORLD}/stats`]){
    try{files=(await client.list(d)).filter(f=>f.name.endsWith('.json'));if(files.length){dir=d;break}}catch{}
  }
  if(!dir)throw new Error('Keine Statistik-Dateien gefunden. Stimmt WORLD_DIR (Ordnername der Welt)?');

  let cache=[];try{cache=JSON.parse(await read('usercache.json'))}catch{}
  const names=new Map(cache.map(c=>[String(c.uuid).toLowerCase(),c.name]));

  const rows=[];
  for(const f of files){
    const uuid=f.name.replace('.json','').toLowerCase();
    let stats;try{stats=JSON.parse(await read(`${dir}/${f.name}`))}catch{continue}
    const minutes=Math.round(ticksOf(stats)/1200);
    if(minutes<1)continue;
    let name=names.get(uuid);
    if(!name){
      try{const r=await fetch('https://sessionserver.mojang.com/session/minecraft/profile/'+uuid.replace(/-/g,''));if(r.ok)name=(await r.json()).name}catch{}
    }
    if(!name||EXCL.includes(name.toLowerCase()))continue;
    rows.push({uuid,name,minutes,updated_at:new Date().toISOString()});
  }

  if(rows.length){
    const r=await fetch(`${SB}/rest/v1/playtime?on_conflict=uuid`,{method:'POST',headers:{...H,Prefer:'resolution=merge-duplicates'},body:JSON.stringify(rows)});
    if(!r.ok)throw new Error('Supabase: '+r.status+' '+await r.text());
  }
  for(const n of EXCL){await fetch(`${SB}/rest/v1/playtime?name=ilike.${encodeURIComponent(n)}`,{method:'DELETE',headers:H})}
  console.log(`Fertig: ${rows.length} Spieler gespeichert (Ordner ${dir}).`);
}catch(e){
  console.error('Fehler:',e.message);process.exitCode=1;
}finally{client.close()}
