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

function clean(s){ return (s || '').replace(/\u00a0/g,' ').replace(/\s+/g,' ').trim(); }
function normaliseName(s){ return clean(s).toLowerCase().replace(/\s*,\s*/g, ', '); }
function looksLikeName(s){ return /^[A-Za-z][A-Za-z' -]+,\s*[A-Za-z][A-Za-z' -]+(?:\s+[A-Za-z' -]+)?$/.test(clean(s)); }
function unique(arr){ return [...new Set(arr.filter(Boolean))]; }
function fmt(seconds){ if(!Number.isFinite(seconds)) return null; const m=Math.floor(seconds/60); const s=Math.round(seconds%60).toString().padStart(2,'0'); return `${m}:${s}`; }

function toIsoFromText(label){
  const text = clean(label);
  const months = {Jan:0,Feb:1,Mar:2,Apr:3,May:4,Jun:5,Jul:6,Aug:7,Sep:8,Oct:9,Nov:10,Dec:11};
  let month, day, year;
  let m = text.match(/\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{1,2})(?:\s*,?\s*(\d{4}))?\b/);
  if(m){ month = months[m[1]]; day = Number(m[2]); year = m[3] ? Number(m[3]) : undefined; }
  if(month === undefined){
    m = text.match(/\b(\d{1,2})[-\s/](Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)(?:[-\s/](\d{4}))?\b/);
    if(m){ day = Number(m[1]); month = months[m[2]]; year = m[3] ? Number(m[3]) : undefined; }
  }
  if(month === undefined || !Number.isFinite(day) || day < 1 || day > 31) return null;
  if(!year) year = month >= 9 ? SEASON : SEASON + 1;
  const d = new Date(Date.UTC(year, month, day));
  if(Number.isNaN(d.getTime())) return null;
  if(d.getUTCFullYear() !== year || d.getUTCMonth() !== month || d.getUTCDate() !== day) return null;
  return d.toISOString().slice(0,10);
}

function parseDurationSeconds(value){
  const v = clean(value);
  if(!v || /^[-–—]$/.test(v)) return null;
  const parts = v.split(':').map(Number);
  if(parts.some(n => !Number.isFinite(n))) return null;
  if(parts.length === 2) return parts[0]*60 + parts[1];
  if(parts.length === 3) return parts[0]*3600 + parts[1]*60 + parts[2];
  return null;
}
function parsePaceSeconds(value){
  const s = parseDurationSeconds(value);
  if(s === null || s <= 0 || s > MAX_PACE_SECONDS) return null;
  return s;
}
function parseNumber(value){
  const v = clean(value);
  if(!v || !/^\d+(?:\.\d+)?$/.test(v)) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

async function fetchText(url){
  const res = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0 BalmoralSwimTracker/1.9' }});
  if(!res.ok) throw new Error(`Fetch failed ${res.status}: ${url}`);
  return await res.text();
}
function extractTables(html){
  const $ = cheerio.load(html);
  return $('table').toArray().map(table => {
    const grid=[]; const spanMap=new Map();
    $(table).find('tr').each((r,tr)=>{
      const row=[]; let c=0;
      while(spanMap.has(`${r},${c}`)){ row[c]=spanMap.get(`${r},${c}`); c++; }
      $(tr).find('th,td').each((_,cell)=>{
        while(spanMap.has(`${r},${c}`)){ row[c]=spanMap.get(`${r},${c}`); c++; }
        const text=clean($(cell).text());
        const colspan=Math.max(1,parseInt($(cell).attr('colspan')||'1',10));
        const rowspan=Math.max(1,parseInt($(cell).attr('rowspan')||'1',10));
        for(let dc=0; dc<colspan; dc++){
          row[c+dc]=text;
          for(let dr=1; dr<rowspan; dr++) spanMap.set(`${r+dr},${c+dc}`,text);
        }
        c+=colspan;
      });
      grid.push(row);
    });
    return grid;
  });
}
function findBestResultsTable(tables){
  return tables.map(t=>({rows:t, cols:Math.max(0,...t.map(r=>r.length)), names:t.flat().filter(looksLikeName).length}))
    .sort((a,b)=>(b.names*1000+b.cols)-(a.names*1000+a.cols))[0]?.rows || [];
}
function getNameFromRow(row){
  for(const cell of row.slice(0,6)) if(looksLikeName(cell)) return clean(cell);
  if(row.length>=2 && /^[A-Za-z][A-Za-z' -]+$/.test(clean(row[0])) && /^[A-Za-z][A-Za-z' -]+$/.test(clean(row[1]))) return `${clean(row[0])}, ${clean(row[1])}`;
  return null;
}
function discoverSwimmersFromResults(tables){
  const names=[];
  for(const table of tables) for(const row of table){ const n=getNameFromRow(row); if(n && !/^Name$/i.test(n)) names.push(n); }
  return unique(names).sort((a,b)=>a.localeCompare(b));
}
function parseCalendar(html){
  const tables=extractTables(html); const distances={};
  const months={Jan:'01',Feb:'02',Mar:'03',Apr:'04',May:'05',Jun:'06',Jul:'07',Aug:'08',Sep:'09',Oct:'10',Nov:'11',Dec:'12'};
  for(const table of tables){
    const header=table.find(r=>r.some(c=>/dist/i.test(c)) || r.some(c=>/distance/i.test(c)));
    const distIndex=header ? header.findIndex(c=>/dist/i.test(c)||/distance/i.test(c)) : -1;
    for(const row of table){
      const dateCell=row.find(c=>/\d{1,2}-[A-Z][a-z]{2}-\d{4}/.test(c));
      if(!dateCell) continue;
      const dm=dateCell.match(/(\d{1,2})-([A-Z][a-z]{2})-(\d{4})/);
      if(!dm || !months[dm[2]]) continue;
      const iso=`${dm[3]}-${months[dm[2]]}-${String(dm[1]).padStart(2,'0')}`;
      let dist=null;
      if(distIndex>=0){ const n=Number(row[distIndex]); if(Number.isFinite(n)&&n>=500&&n<=3000) dist=n; }
      if(!dist) dist=row.map(c=>c.match(/^\d{3,4}$/)?.[0]).filter(Boolean).map(Number).filter(n=>![700,730,800].includes(n)).find(n=>n>=500&&n<=3000)||null;
      distances[iso]=dist;
    }
  }
  return distances;
}
function buildDateGroupsAndHeader(table){
  const firstSwimmerRow=table.findIndex(row=>getNameFromRow(row));
  const headerRows=table.slice(0, firstSwimmerRow>=0 ? firstSwimmerRow : Math.min(8,table.length));
  const maxCols=Math.max(0,...table.map(r=>r.length));
  const dateByCol=Array(maxCols).fill(null);
  const labelByCol=Array(maxCols).fill('');
  for(const row of headerRows){
    for(let c=0;c<maxCols;c++){
      const text=row[c]||'';
      if(text) labelByCol[c]=(labelByCol[c]+' '+text).trim();
      const iso=toIsoFromText(text); if(iso) dateByCol[c]=iso;
    }
  }
  let last=null;
  for(let c=0;c<maxCols;c++){ if(dateByCol[c]) last=dateByCol[c]; else if(last) dateByCol[c]=last; }
  const groups=[];
  for(let c=0;c<maxCols;c++){
    const date=dateByCol[c]; if(!date) continue;
    if(groups.length && groups[groups.length-1].date===date) groups[groups.length-1].end=c;
    else groups.push({date,start:c,end:c});
  }
  const seen=new Set();
  const uniqueGroups=groups.filter(g=>{ if(seen.has(g.date)) return false; seen.add(g.date); return true; });
  const flattenedHeader=headerRows.map(r=>r.join(' ')).join(' | ');
  return { groups:uniqueGroups, labelByCol, headerRows, flattenedHeader };
}
function rowsByName(table){ const out=new Map(); for(const row of table){ const n=getNameFromRow(row); if(n) out.set(normaliseName(n),row); } return out; }
function findColumnByHeader(headerRows, regex){
  const maxCols=Math.max(0,...headerRows.map(r=>r.length));
  for(let c=0;c<maxCols;c++){
    const label=headerRows.map(r=>r[c]||'').join(' ');
    if(regex.test(label)) return c;
  }
  return -1;
}
function findSeriesTotalPoints(row, headerRows){
  // This is the circled Pts column in the screenshot: left summary column after Races and before date columns.
  let ptsCol=findColumnByHeader(headerRows, /^\s*pts\s*$/i);
  if(ptsCol < 0) ptsCol=findColumnByHeader(headerRows, /\bpts\b|\bpoints\b/i);
  if(ptsCol >= 0){
    const pts=parseNumber(row[ptsCol]);
    if(pts !== null) return { value:pts, raw:clean(row[ptsCol]), source:'series-pts-column', column:ptsCol };
  }
  return { value:null, raw:null, source:null, column:null };
}
function findEventPoints(row, labelByCol, start, end, paceCell){
  // Date columns on the points table contain event points. Avoid lap-time cells such as 1:44.
  const candidates=[];
  for(let c=start;c<=end;c++){
    const raw=clean(row[c]);
    if(!raw || raw===clean(paceCell)) continue;
    if(parsePaceSeconds(raw) !== null) continue;
    const n=parseNumber(raw);
    if(n !== null && n >= 0 && n <= 100) candidates.push({value:n, raw, column:c});
  }
  // Usually only one points figure exists in the date group on the point view.
  candidates.sort((a,b)=>b.value-a.value);
  return candidates[0] || {value:null, raw:null, column:null};
}
function parsePointsTable(html, swimmersToTrack){
  const table=findBestResultsTable(extractTables(html));
  const { groups, labelByCol, headerRows } = buildDateGroupsAndHeader(table);
  const rows=rowsByName(table);
  const bySwimmer={};
  for(const swimmer of swimmersToTrack){
    bySwimmer[swimmer]={ total_points:null, total_points_raw:null, races:{} };
    const row=rows.get(normaliseName(swimmer));
    if(!row) continue;
    const total=findSeriesTotalPoints(row, headerRows);
    bySwimmer[swimmer].total_points=total.value;
    bySwimmer[swimmer].total_points_raw=total.raw;
    for(const g of groups){
      if(EXCLUDED_DATES.has(g.date)) continue;
      const p=findEventPoints(row, labelByCol, g.start, g.end, null);
      if(p.value !== null) bySwimmer[swimmer].races[g.date]={ placing_points:p.value, placing_points_raw:p.raw, points_source:'website-date-column' };
    }
  }
  return bySwimmer;
}
function parsePaceTable(html, seriesShort, calendarDistances, swimmersToTrack){
  const table=findBestResultsTable(extractTables(html));
  const { groups }=buildDateGroupsAndHeader(table);
  const rows=rowsByName(table);
  const bySwimmer={};
  for(const swimmer of swimmersToTrack){
    const row=rows.get(normaliseName(swimmer));
    bySwimmer[swimmer]=[];
    if(!row) continue;
    for(const g of groups){
      if(EXCLUDED_DATES.has(g.date)) continue;
      const cells=row.slice(g.start,g.end+1);
      const paceCell=cells.find(c=>parsePaceSeconds(c)!==null);
      const pace=parsePaceSeconds(paceCell);
      const distance=calendarDistances[g.date] || null;
      if(pace===null || !distance) continue;
      const elapsed=distance*pace/100;
      bySwimmer[swimmer].push({
        date:g.date,
        day:new Date(g.date+'T00:00:00Z').toLocaleDateString('en-AU',{weekday:'long',timeZone:'UTC'}),
        series:seriesShort,
        distance_m:distance,
        average_pace_raw:paceCell,
        average_pace_seconds_per_100m:pace,
        pace_raw:paceCell,
        pace_seconds_per_100m:pace,
        elapsed_time_seconds:elapsed,
        elapsed_time_raw:fmt(elapsed)
      });
    }
  }
  return bySwimmer;
}
function rankRaceEntries(entries){
  const byRace=new Map();
  for(const e of entries){ const key=`${e.series}|${e.date}`; if(!byRace.has(key)) byRace.set(key,[]); byRace.get(key).push(e); }
  for(const raceEntries of byRace.values()){
    const valid=raceEntries.filter(e=>Number.isFinite(e.elapsed_time_seconds));
    const total=valid.length;
    for(const e of raceEntries) e.total_swimmers=total;
    valid.sort((a,b)=>a.elapsed_time_seconds-b.elapsed_time_seconds);
    valid.forEach((e,i)=>{ e.elapsed_position=i+1; e.elapsed_position_percent=total ? ((i+1)/total*100) : null; });
  }
}

const htmlBySeries=[]; const discovered=[];
for(const s of SERIES){
  console.log(`Fetching ${s.name || s.short}`);
  const [paceHtml, pointsHtml, calendarHtml]=await Promise.all([fetchText(s.lapYUrl), fetchText(s.lapNUrl), fetchText(s.calendarUrl)]);
  htmlBySeries.push({series:s, paceHtml, pointsHtml, calendarHtml});
  if(TRACK_ALL) discovered.push(...discoverSwimmersFromResults(extractTables(paceHtml)), ...discoverSwimmersFromResults(extractTables(pointsHtml)));
}
SWIMMERS = TRACK_ALL ? unique([PRIMARY_SWIMMER, ...discovered]).sort((a,b)=>a.localeCompare(b)) : unique([PRIMARY_SWIMMER, ...SWIMMERS]);
console.log(`Tracking ${SWIMMERS.length} swimmers`);
const swimmerMap=Object.fromEntries(SWIMMERS.map(s=>[s,[]]));
const warnings=[];
for(const item of htmlBySeries){
  const distances=parseCalendar(item.calendarHtml);
  const pace=parsePaceTable(item.paceHtml,item.series.short,distances,SWIMMERS);
  const points=parsePointsTable(item.pointsHtml,SWIMMERS);
  for(const swimmer of SWIMMERS){
    for(const race of pace[swimmer] || []){
      const p=points[swimmer]?.races?.[race.date] || {};
      swimmerMap[swimmer].push({
        ...race,
        placing_points:p.placing_points ?? null,
        placing_points_raw:p.placing_points_raw ?? null,
        points_source:p.points_source ?? null,
        series_total_points:points[swimmer]?.total_points ?? null,
        series_total_points_raw:points[swimmer]?.total_points_raw ?? null
      });
    }
  }
}
const allEntries=Object.values(swimmerMap).flat();
rankRaceEntries(allEntries);
const swimmers=SWIMMERS.map(name=>({name,races:swimmerMap[name].sort((a,b)=>a.date.localeCompare(b.date))}));
const output={
  last_updated:new Date().toISOString(),
  source:'Balmoral Beach Club SeriesResults lap=Y/lap=N and CalendarRep1 pages',
  primarySwimmer:PRIMARY_SWIMMER,
  config:CONFIG,
  filters:{excludedDates:[...EXCLUDED_DATES], maxPaceSeconds:MAX_PACE_SECONDS},
  points:{method:'Total points from Pts column; per-race points from the date columns on the points results table.'},
  swimmers,
  warnings
};
await fs.writeFile('data/results.json', JSON.stringify(output,null,2));
console.log(`Wrote data/results.json for ${swimmers.length} swimmers and ${allEntries.length} race entries`);
if(warnings.length) console.warn('Warnings:\n'+warnings.join('\n'));
