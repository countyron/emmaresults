import fs from 'fs/promises';
import * as cheerio from 'cheerio';

const CONFIG = JSON.parse(await fs.readFile('data/config.json', 'utf8'));
const SEASON = CONFIG.season || 2025;
const PRIMARY_SWIMMER = CONFIG.primarySwimmer || 'Bennett, Emma';
let SWIMMERS = Array.isArray(CONFIG.swimmers) ? CONFIG.swimmers : [];
const TRACK_ALL = CONFIG.trackAllSwimmers !== false;
const EXCLUDED_DATES = new Set(CONFIG.excludedDates || ['2026-05-03','2026-05-10']);
const MAX_PACE_SECONDS = CONFIG.maxPaceSeconds || 180;
const SERIES = (CONFIG.series || []).map(s => ({
  ...s,
  lapYUrl: `https://www.balmoralbeachclub.org.au/BaseTemplate.cfm?FileName=SeriesResults.cfm&EventID=${s.eventId}&n=1&Season=${SEASON}&REQUESTTIMEOUT=500&P=BeachPublic&lap=Y`,
  lapNUrl: `https://www.balmoralbeachclub.org.au/BaseTemplate.cfm?FileName=SeriesResults.cfm&EventID=${s.eventId}&n=1&Season=${SEASON}&REQUESTTIMEOUT=500&P=BeachPublic&lap=N`,
  calendarUrl: `https://www.balmoralbeachclub.org.au/BaseTemplate.cfm?FileName=CalendarRep1.cfm&EventID=${s.eventId}&Season=${SEASON}&P=BeachPublic`
}));
function clean(s){return (s||'').replace(/\u00a0/g,' ').replace(/\s+/g,' ').trim();}
function norm(s){return clean(s).toLowerCase().replace(/\s*,\s*/g,', ')}
function isName(s){return /^[A-Za-z][A-Za-z' -]+,\s*[A-Za-z][A-Za-z' -]+(?:\s+[A-Za-z' -]+)?$/.test(clean(s));}
function uniq(a){return [...new Set(a.filter(Boolean))];}
function fmt(sec){if(!Number.isFinite(sec))return null;const m=Math.floor(sec/60),s=Math.round(sec%60).toString().padStart(2,'0');return `${m}:${s}`;}
function isoFromText(t){
  t=clean(t); const months={Jan:0,Feb:1,Mar:2,Apr:3,May:4,Jun:5,Jul:6,Aug:7,Sep:8,Oct:9,Nov:10,Dec:11}; let m=t.match(/\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{1,2})(?:\s*,?\s*(\d{4}))?\b/); let mo,day,yr;
  if(m){mo=months[m[1]];day=+m[2];yr=m[3]?+m[3]:undefined;} else {m=t.match(/\b(\d{1,2})[-\s/](Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)(?:[-\s/](\d{4}))?\b/); if(m){day=+m[1];mo=months[m[2]];yr=m[3]?+m[3]:undefined;}}
  if(mo===undefined||!Number.isFinite(day)||day<1||day>31)return null; if(!yr)yr=mo>=9?SEASON:SEASON+1; const d=new Date(Date.UTC(yr,mo,day)); if(Number.isNaN(d.getTime())||d.getUTCMonth()!==mo||d.getUTCDate()!==day)return null; return d.toISOString().slice(0,10);
}
function dur(s){s=clean(s); if(!s||/^[-–—]$/.test(s))return null; const p=s.split(':').map(Number); if(p.some(n=>!Number.isFinite(n)))return null; if(p.length===2)return p[0]*60+p[1]; if(p.length===3)return p[0]*3600+p[1]*60+p[2]; return null;}
function pace(s){const x=dur(s); return x!==null&&x>0&&x<=MAX_PACE_SECONDS?x:null;}
function num(s){s=clean(s); if(!/^\d+(?:\.\d+)?$/.test(s))return null; const n=+s; return Number.isFinite(n)?n:null;}
async function fetchText(url){const r=await fetch(url,{headers:{'user-agent':'Mozilla/5.0 EmmaSwim/2.0'}}); if(!r.ok)throw new Error(`Fetch failed ${r.status}: ${url}`); return await r.text();}
function tables(html){const $=cheerio.load(html); return $('table').toArray().map(table=>{const grid=[],spans=new Map(); $(table).find('tr').each((r,tr)=>{const row=[];let c=0; while(spans.has(`${r},${c}`)){row[c]=spans.get(`${r},${c}`);c++;} $(tr).find('th,td').each((_,cell)=>{while(spans.has(`${r},${c}`)){row[c]=spans.get(`${r},${c}`);c++;} const text=clean($(cell).text()), cs=Math.max(1,parseInt($(cell).attr('colspan')||'1',10)), rs=Math.max(1,parseInt($(cell).attr('rowspan')||'1',10)); for(let dc=0;dc<cs;dc++){row[c+dc]=text; for(let dr=1;dr<rs;dr++)spans.set(`${r+dr},${c+dc}`,text);} c+=cs;}); grid.push(row);}); return grid;});}
function bestTable(ts){return ts.map(t=>({rows:t,score:t.flat().filter(isName).length*1000+Math.max(0,...t.map(r=>r.length))})).sort((a,b)=>b.score-a.score)[0]?.rows||[];}
function rowName(row){for(const c of row.slice(0,6))if(isName(c))return clean(c); if(row.length>=2&&/^[A-Za-z][A-Za-z' -]+$/.test(clean(row[0]))&&/^[A-Za-z][A-Za-z' -]+$/.test(clean(row[1])))return `${clean(row[0])}, ${clean(row[1])}`; return null;}
function discover(ts){const a=[]; for(const t of ts)for(const r of t){const n=rowName(r); if(n&&!/^Name$/i.test(n))a.push(n);} return uniq(a).sort((a,b)=>a.localeCompare(b));}
function rowsByName(table){const m=new Map(); for(const r of table){const n=rowName(r); if(n)m.set(norm(n),r);} return m;}
function dateGroups(table){const first=table.findIndex(r=>rowName(r)); const heads=table.slice(0,first>=0?first:Math.min(8,table.length)); const max=Math.max(0,...table.map(r=>r.length)); const dates=Array(max).fill(null), labels=Array(max).fill(''); for(const r of heads)for(let c=0;c<max;c++){const tx=r[c]||''; if(tx)labels[c]=(labels[c]+' '+tx).trim(); const iso=isoFromText(tx); if(iso)dates[c]=iso;} let last=null; for(let c=0;c<max;c++){if(dates[c])last=dates[c]; else if(last)dates[c]=last;} const groups=[]; for(let c=0;c<max;c++){if(!dates[c])continue; if(groups.length&&groups.at(-1).date===dates[c])groups.at(-1).end=c; else groups.push({date:dates[c],start:c,end:c});} const seen=new Set(); return {groups:groups.filter(g=>{if(seen.has(g.date))return false; seen.add(g.date); return true;}), labels, heads};}
function colByHeader(heads,re){const max=Math.max(0,...heads.map(r=>r.length)); for(let c=0;c<max;c++){if(re.test(heads.map(r=>r[c]||'').join(' ')))return c;} return -1;}
function calendar(html){const out={}; const months={Jan:'01',Feb:'02',Mar:'03',Apr:'04',May:'05',Jun:'06',Jul:'07',Aug:'08',Sep:'09',Oct:'10',Nov:'11',Dec:'12'}; for(const t of tables(html)){const h=t.find(r=>r.some(c=>/dist/i.test(c)||/distance/i.test(c))); const di=h?h.findIndex(c=>/dist/i.test(c)||/distance/i.test(c)):-1; for(const r of t){const dc=r.find(c=>/\d{1,2}-[A-Z][a-z]{2}-\d{4}/.test(c)); if(!dc)continue; const m=dc.match(/(\d{1,2})-([A-Z][a-z]{2})-(\d{4})/); if(!m||!months[m[2]])continue; const iso=`${m[3]}-${months[m[2]]}-${String(m[1]).padStart(2,'0')}`; let dist=null; if(di>=0){const n=+r[di]; if(Number.isFinite(n)&&n>=500&&n<=3000)dist=n;} if(!dist)dist=r.map(c=>c.match(/^\d{3,4}$/)?.[0]).filter(Boolean).map(Number).filter(n=>![700,730,800].includes(n)).find(n=>n>=500&&n<=3000)||null; out[iso]=dist;}} return out;}
function totalPts(row,heads){let c=colByHeader(heads,/^\s*pts\s*$/i); if(c<0)c=colByHeader(heads,/\bpts\b|\bpoints\b/i); const n=c>=0?num(row[c]):null; return n;}
function parsePoints(html, swimmers){const table=bestTable(tables(html)); const {groups,heads}=dateGroups(table); const rows=rowsByName(table); const out={}; for(const s of swimmers){out[s]={total_points:null,races:{}}; const row=rows.get(norm(s)); if(!row)continue; out[s].total_points=totalPts(row,heads); for(const g of groups){if(EXCLUDED_DATES.has(g.date))continue; const vals=[]; for(let c=g.start;c<=g.end;c++){const raw=clean(row[c]); if(!raw||pace(raw)!==null)continue; const n=num(raw); if(n!==null&&n>=0&&n<=100)vals.push({n,raw});} if(vals.length){vals.sort((a,b)=>b.n-a.n); out[s].races[g.date]={placing_points:vals[0].n,placing_points_raw:vals[0].raw};}}} return out;}
function parsePaces(html, short, dist, swimmers){const table=bestTable(tables(html)); const {groups}=dateGroups(table); const rows=rowsByName(table); const out={}; for(const s of swimmers){out[s]=[]; const row=rows.get(norm(s)); if(!row)continue; for(const g of groups){if(EXCLUDED_DATES.has(g.date))continue; const cells=row.slice(g.start,g.end+1); const pc=cells.find(c=>pace(c)!==null); const ps=pace(pc), d=dist[g.date]; if(ps===null||!d)continue; const elapsed=d*ps/100; out[s].push({date:g.date,day:new Date(g.date+'T00:00:00Z').toLocaleDateString('en-AU',{weekday:'long',timeZone:'UTC'}),series:short,distance_m:d,average_pace_raw:pc,average_pace_seconds_per_100m:ps,pace_raw:pc,pace_seconds_per_100m:ps,elapsed_time_seconds:elapsed,elapsed_time_raw:fmt(elapsed)});}} return out;}
function rank(entries){const by=new Map(); for(const e of entries){const k=`${e.series}|${e.date}`; if(!by.has(k))by.set(k,[]); by.get(k).push(e);} for(const arr of by.values()){const v=arr.filter(e=>Number.isFinite(e.elapsed_time_seconds)).sort((a,b)=>a.elapsed_time_seconds-b.elapsed_time_seconds); for(const e of arr)e.total_swimmers=v.length; v.forEach((e,i)=>{e.elapsed_position=i+1; e.elapsed_position_percent=v.length?(i+1)/v.length*100:null;});}}
const loaded=[], discovered=[];
for(const s of SERIES){console.log(`Fetching ${s.name||s.short}`); const [paceHtml,pointsHtml,calHtml]=await Promise.all([fetchText(s.lapYUrl),fetchText(s.lapNUrl),fetchText(s.calendarUrl)]); loaded.push({s,paceHtml,pointsHtml,calHtml}); if(TRACK_ALL)discovered.push(...discover(tables(paceHtml)),...discover(tables(pointsHtml)));}
SWIMMERS=TRACK_ALL?uniq([PRIMARY_SWIMMER,...discovered]).sort((a,b)=>a.localeCompare(b)):uniq([PRIMARY_SWIMMER,...SWIMMERS]);
const swimmerMap=Object.fromEntries(SWIMMERS.map(s=>[s,[]])); const warnings=[];
for(const item of loaded){const dist=calendar(item.calHtml); const paces=parsePaces(item.paceHtml,item.s.short,dist,SWIMMERS); const points=parsePoints(item.pointsHtml,SWIMMERS); for(const sw of SWIMMERS)for(const r of paces[sw]||[]){const p=points[sw]?.races?.[r.date]||{}; swimmerMap[sw].push({...r,placing_points:p.placing_points??null,placing_points_raw:p.placing_points_raw??null,series_total_points:points[sw]?.total_points??null});}}
const allEntries=Object.values(swimmerMap).flat(); rank(allEntries);
const swimmers=SWIMMERS.map(name=>({name,races:swimmerMap[name].sort((a,b)=>a.date.localeCompare(b.date))}));
await fs.writeFile('data/results.json', JSON.stringify({last_updated:new Date().toISOString(),source:'Balmoral Beach Club SeriesResults lap=Y/lap=N and CalendarRep1 pages',primarySwimmer:PRIMARY_SWIMMER,config:CONFIG,filters:{excludedDates:[...EXCLUDED_DATES],maxPaceSeconds:MAX_PACE_SECONDS},points:{method:'Series total from Pts column; race points from individual date columns.'},swimmers,warnings},null,2));
console.log(`Wrote data/results.json for ${swimmers.length} swimmers and ${allEntries.length} race entries`);
