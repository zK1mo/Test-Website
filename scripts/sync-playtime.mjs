// Holt die Spielzeit aller Spieler per FTP vom Minecraft-Server und speichert sie in Supabase.
// Robust gegen kurze Ausfälle: Verbindungsversuche werden wiederholt, kaputte Dateien übersprungen.
import {Client} from 'basic-ftp';
import {Writable} from 'node:stream';
import {appendFileSync} from 'node:fs';

const E=process.env;
const need=k=>{if(!E[k]){console.error('Fehlt: '+k);process.exit(1)}return E[k]};
const HOST=need('FTP_HOST'),USER=need('FTP_USER'),PASS=need('FTP_PASS');
const SB=need('SUPABASE_URL').replace(/\/$/,''),KEY=need('SUPABASE_SERVICE_KEY');
const PORT=Number(E.FTP_PORT||21),WORLD=E.WORLD_DIR||'world',SECURE=E.FTP_SECURE==='true';
const EXCL=(E.EXCLUDE_NAMES||'').split(',').map(s=>s.trim().toLowerCase()).filter(Boolean);
const TRIES=Number(E.RETRIES||5),DELAY=Number(E.RETRY_DELAY_MS||20000);
const UUID_RE=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const sleep=ms=>new Promise(r=>setTimeout(r,ms));

// Spielzeit in Ticks (20 Ticks = 1 Sekunde); ältere Versionen nutzen play_one_minute
const ticksOf=s=>{const c=(s&&s.stats&&s.stats['minecraft:custom'])||{};return c['minecraft:play_time']??c['minecraft:play_one_minute']??0};

// Weitere Statistiken für den Jahresrückblick (alles aus derselben Datei)
const statsOf=s=>{const c=(s&&s.stats&&s.stats['minecraft:custom'])||{},m=(s&&s.stats&&s.stats['minecraft:mined'])||{};
  return {deaths:c['minecraft:deaths']||0,mob_kills:c['minecraft:mob_kills']||0,km:Math.round(((c['minecraft:walk_one_cm']||0)+(c['minecraft:sprint_one_cm']||0)+(c['minecraft:swim_one_cm']||0))/1e4)/10,mined:Object.values(m).reduce((a,b)=>a+(+b||0),0),jumps:c['minecraft:jump']||0}};

const H={apikey:KEY,'Content-Type':'application/json'};
if(!KEY.startsWith('sb_'))H.Authorization='Bearer '+KEY;

async function retry(label,fn){
  let last;
  for(let i=1;i<=TRIES;i++){
    try{return await fn()}
    catch(e){
      last=e;console.error(`${label}: Versuch ${i} von ${TRIES} fehlgeschlagen: ${e.message}`);
      const fatal=e.status>=400&&e.status<500&&![408,429].includes(e.status);
      if(fatal||i==TRIES)break;
      await sleep(DELAY*i);
    }
  }
  throw last;
}

async function sbFetch(url,opt={}){
  const r=await fetch(url,{...opt,headers:{...H,...(opt.headers||{})},signal:AbortSignal.timeout(20000)});
  const t=await r.text();
  if(!r.ok){const e=new Error(`Supabase ${r.status}: ${t.slice(0,200)}`);e.status=r.status;throw e}
  return t?JSON.parse(t):null;
}

async function readStats(){
  const client=new Client(60000);
  if(E.FTP_VERBOSE==='true')client.ftp.verbose=true;
  const read=async p=>{const ch=[];await client.downloadTo(new Writable({write(c,_,cb){ch.push(c);cb()}}),p);return Buffer.concat(ch).toString('utf8')};
  try{
    await client.access({host:HOST,port:PORT,user:USER,password:PASS,secure:SECURE});
    let dir=null,files=[];
    for(const d of [`${WORLD}/players/stats`,`${WORLD}/stats`]){
      try{files=(await client.list(d)).filter(f=>f.name.endsWith('.json')&&UUID_RE.test(f.name.slice(0,-5)));if(files.length){dir=d;break}}catch{}
    }
    if(!dir)throw new Error('Keine Statistik-Dateien gefunden. Stimmt WORLD_DIR (Ordnername der Welt)?');
    let cache=[];try{cache=JSON.parse(await read('usercache.json'))}catch(e){console.error('Hinweis: usercache.json nicht lesbar ('+e.message+')')}
    const players=[];let bad=0;
    for(const f of files){
      try{const js=JSON.parse(await read(`${dir}/${f.name}`));players.push({uuid:f.name.slice(0,-5).toLowerCase(),ticks:ticksOf(js),stats:statsOf(js)})}
      catch(e){bad++;console.error('Datei übersprungen: '+f.name+' ('+e.message+')')}
    }
    if(bad>files.length/2)throw new Error(`Zu viele Dateien nicht lesbar (${bad} von ${files.length}).`);
    return {dir,players,cache};
  }finally{client.close()}
}

function summary(text){
  console.log(text);
  if(E.GITHUB_STEP_SUMMARY){try{appendFileSync(E.GITHUB_STEP_SUMMARY,text+'\n')}catch{}}
}

try{
  let data;
  try{data=await retry('FTP',readStats)}
  catch(e){e.net=/ECONNREFUSED|ETIMEDOUT|ECONNRESET|EHOSTUNREACH|ENETUNREACH|ENOTFOUND|EAI_AGAIN|timeout/i.test(e.message);throw e}
  const {dir,players,cache}=data;

  // Namen: usercache.json des Servers, dann bereits gespeicherte Namen, zuletzt Mojang
  const names=new Map(cache.map(c=>[String(c.uuid).toLowerCase(),c.name]));
  try{(await retry('Supabase lesen',()=>sbFetch(`${SB}/rest/v1/playtime?select=uuid,name`))||[]).forEach(r=>{if(!names.has(r.uuid))names.set(r.uuid,r.name)})}
  catch(e){console.error('Hinweis: gespeicherte Namen nicht lesbar ('+e.message+')')}

  const rows=[];let skipped=0,lookups=0;
  for(const p of players){
    const minutes=Math.round(p.ticks/1200);
    if(minutes<1)continue;
    let name=names.get(p.uuid);
    if(!name&&lookups<8){
      lookups++;
      try{const r=await fetch('https://sessionserver.mojang.com/session/minecraft/profile/'+p.uuid.replace(/-/g,''),{signal:AbortSignal.timeout(8000)});if(r.ok)name=(await r.json()).name}catch{}
      await sleep(1200);
    }
    if(!name){skipped++;continue}
    if(EXCL.includes(name.toLowerCase()))continue;
    rows.push({uuid:p.uuid,name,minutes,stats:p.stats,updated_at:new Date().toISOString()});
  }

  if(rows.length)await retry('Supabase speichern',()=>sbFetch(`${SB}/rest/v1/playtime?on_conflict=uuid`,{method:'POST',headers:{Prefer:'resolution=merge-duplicates,return=minimal'},body:JSON.stringify(rows)}));
  for(const n of EXCL){try{await sbFetch(`${SB}/rest/v1/playtime?name=ilike.${encodeURIComponent(n)}`,{method:'DELETE'})}catch(e){console.error('Ausnahme-Name nicht entfernt: '+n+' ('+e.message+')')}}
  try{await sbFetch(`${SB}/rest/v1/site_config?on_conflict=key`,{method:'POST',headers:{Prefer:'resolution=merge-duplicates,return=minimal'},body:JSON.stringify([{key:'playtime_last_ok',value:new Date().toISOString()}])})}
  catch(e){console.error('Hinweis: Zeitstempel nicht gespeichert ('+e.message+')')}
  summary(`Fertig: ${rows.length} Spieler gespeichert (Ordner ${dir}), ${skipped} ohne bekannten Namen übersprungen.`);
}catch(e){
  if(e.net){
    // Server oder FTP gerade nicht erreichbar (zum Beispiel Neustart): kein Alarm, solange der letzte Erfolg nicht lange her ist
    let hours=null;
    try{const r=await sbFetch(`${SB}/rest/v1/site_config?key=eq.playtime_last_ok&select=value`);if(r&&r[0])hours=(Date.now()-new Date(r[0].value).getTime())/36e5}catch{}
    if(hours!==null&&hours<=6){
      console.log('::warning::FTP gerade nicht erreichbar, der nächste Lauf versucht es erneut.');
      summary(`Hinweis: FTP gerade nicht erreichbar (${e.message}). Letzter Erfolg vor ${hours.toFixed(1)} Stunden. Der nächste Lauf versucht es erneut.`);
    }else{
      summary(`Fehler: FTP seit ${hours===null?'dem Start (noch nie erfolgreich)':'über '+Math.round(hours)+' Stunden'} nicht erreichbar (${e.message}). Prüfe Adresse, Port und Passwort im G-Portal-Menü „Status“ und die GitHub-Secrets.`);
      process.exitCode=1;
    }
  }else{summary('Fehler: '+e.message);process.exitCode=1}
}
