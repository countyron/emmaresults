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
  const seconds = parseDurationSeconds(value);
  if(seconds === null || seconds <= 0 || seconds > MAX_PACE_SECONDS) return null;
  return seconds;
}
function parsePoints(value){
  const v = clean(value);
  if(!v || !/^\d+(?:\.\d+)?$/.test(v)) return null;
  const n = Number(v);
  if(!Number.isFinite(n) || n < 0 || n > 10000) return null;
  return n;
}

async function fetchText(url){
  const res = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0 BalmoralSwimTracker/1.8' }});
  if(!res.ok) throw new Error(`Fetch failed ${res.status}: ${url}`);
  return await res.text();
}

function extractTables(html){
  const $ = cheerio.load(html);
  return $('table').toArray().map(table => {
    const grid = [];
    const spanMap = new Map();
    $(table).find('tr').each((r,tr) => {
      const row = [];
      let c = 0;
      while(spanMap.has(`${r},${c}`)){ row[c] = spanMap.get(`${r},${c}`); c++; }
      $(tr).find('th,td').each((_,cell) => {
        while(spanMap.has(`${r},${c}`)){ row[c] = spanMap.get(`${r},${c}`); c++; }
        const text = clean($(cell).text());
        const colspan = Math.max(1, parseInt($(cell).attr('colspan') || '1',10));
        const rowspan = Math.max(1, parseInt($(cell).attr('rowspan') || '1',10));
        for(let dc=0; dc<colspan; dc++){
          row[c+dc] = text;
          for(let dr=1; dr<rowspan; dr++) spanMap.set(`${r+dr},${c+dc}`, text);
        }
        c += colspan;
      });
      grid.push(row);
    });
    return grid;
  });
}
function findBestResultsTable(tables){
  return tables.map(t => ({rows:t, cols:Math.max(0,...t.map(r=>r.length)), names:t.flat().filter(looksLikeName).length}))
    .sort((a,b)=>(b.names*1000+b.cols)-(a.names*1000+a.cols))[0]?.rows || [];
}
function getNameFromRow(row){
  for(const cell of row.slice(0,5)) if(looksLikeName(cell)) return clean(cell);
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
    const header = table.find(r => r.some(c => /dist/i.test(c)) || r.some(c => /distance/i.test(c)));
    const distIndex = header ? header.findIndex(c => /dist/i.test(c) || /distance/i.test(c)) : -1;
    for(const row of table){
      const dateCell = row.find(c => /\d{1,2}-[A-Z][a-z]{2}-\d{4}/.test(c));
      if(!dateCell) continue;
      const dm = dateCell.match(/(\d{1,2})-([A-Z][a-z]{2})-(\d{4})/);
      if(!dm || !months[dm[2]]) continue;
      const iso = `${dm[3]}-${months[dm[2]]}-${String(dm[1]).padStart(2,'0')}`;
      let dist = null;
      if(distIndex >= 0){ const candidate=Number(row[distIndex]); if(Number.isFinite(candidate)&&candidate>=500&&candidate<=3000) dist=candidate; }
      if(!dist) dist = row.map(c => c.match(/^\d{3,4}$/)?.[0]).filter(Boolean).map(Number).filter(n => ![700,730,800].includes(n)).find(n => n>=500 && n<=3000) || null;
      distances[iso] = dist;
    }
  }
  return distances;
}
function buildDateGroupsAndLabels(table){
  const firstSwimmerRow = table.findIndex(row => getNameFromRow(row));
  const headerRows = table.slice(0, firstSwimmerRow >= 0 ? firstSwimmerRow : Math.min(8,table.length));
  const maxCols = Math.max(0,...table.map(r=>r.length));
  const dateByCol = Array(maxCols).fill(null);
  const labelByCol = Array(maxCols).fill('');
  for(const row of headerRows){
    for(let c=0;c<maxCols;c++){
      const text = row[c] || '';
      if(text) labelByCol[c] = (labelByCol[c] + ' ' + text).trim();
      const iso=toIsoFromText(text);
      if(iso) dateByCol[c]=iso;
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
  return { groups: groups.filter(g => { if(seen.has(g.date)) return false; seen.add(g.date); return true; }), labelByCol };
}
function rowsByName(table){ const out=new Map(); for(const row of table){ const n=getNameFromRow(row); if(n) out.set(normaliseName(n),row); } return out; }
function findPointsInGroup(row, labelByCol, start, end, paceCell){
  const pointColumns = [];
  for(let c=start; c<=end; c++){
    if(/\b(points?|pts?)\b/i.test(labelByCol[c] || '')) pointColumns.push(c);
  }
  for(const c of pointColumns){
    const pts = parsePoints(row[c]);
    if(pts !== null) return { raw: clean(row[c]), value: pts, source: 'website-points-column' };
  }
  // Fallback: choose a numeric cell in the group that is not the pace cell.
  // This is only used if column headers do not contain Points/Pts.
  const candidates = [];
  for(let c=start; c<=end; c++){
    if(clean(row[c]) === clean(paceCell)) continue;
    const pts = parsePoints(row[c]);
    if(pts !== null) candidates.push({ raw: clean(row[c]), value: pts, source: 'website-numeric-fallback' });
  }
  // Prefer larger values where points are likely high; avoid tiny place-like values if alternatives exist.
  candidates.sort((a,b) => b.value - a.value);
  return candidates[0] || { raw:null, value:null, source:null };
}
function parseLapY(html, seriesShort, calendarDistances, swimmersToTrack){
  const table = findBestResultsTable(extractTables(html));
  const { groups, labelByCol } = buildDateGroupsAndLabels(table);
  const rows = rowsByName(table);
  const bySwimmer = {};
  for(const swimmer of swimmersToTrack){
    const row = rows.get(normaliseName(swimmer));
    bySwimmer[swimmer] = [];
    if(!row) continue;
    for(const g of groups){
      if(EXCLUDED_DATES.has(g.date)) continue;
      const cells = row.slice(g.start, g.end+1);
      const paceCell = cells.find(c => parsePaceSeconds(c) !== null);
      const pace = parsePaceSeconds(paceCell);
      const distance = calendarDistances[g.date] || null;
      if(pace === null || !distance) continue;
      const elapsed = distance * pace / 100;
      const points = findPointsInGroup(row, labelByCol, g.start, g.end, paceCell);
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
        elapsed_time_raw:fmt(elapsed),
        placing_points:points.value,
        placing_points_raw:points.raw,
        points_source:points.source
      });
    }
  }
  return bySwimmer;
}
function rankRaceEntries(entries){
  const byRace=new Map();
  for(const e of entries){ const key=`${e.series}|${e.date}`; if(!byRace.has(key)) byRace.set(key,[]); byRace.get(key).push(e); }
  for(const raceEntries of byRace.values()){
    const valid = raceEntries.filter(e => Number.isFinite(e.elapsed_time_seconds));
    const total = valid.length;
    for(const e of raceEntries) e.total_swimmers = total;
    valid.sort((a,b)=>a.elapsed_time_seconds-b.elapsed_time_seconds);
    valid.forEach((e,i)=>{
      e.elapsed_position=i+1;
      e.elapsed_position_percent=total ? ((i+1)/total*100) : null;
    });
  }
}

const htmlBySeries=[]; const discovered=[];
for(const s of SERIES){
  console.log(`Fetching ${s.name || s.short}`);
  const [lapYHtml, calendarHtml] = await Promise.all([fetchText(s.lapYUrl), fetchText(s.calendarUrl)]);
  htmlBySeries.push({series:s, lapYHtml, calendarHtml});
  if(TRACK_ALL) discovered.push(...discoverSwimmersFromResults(extractTables(lapYHtml)));
}
SWIMMERS = TRACK_ALL ? unique([PRIMARY_SWIMMER, ...discovered]).sort((a,b)=>a.localeCompare(b)) : unique([PRIMARY_SWIMMER, ...SWIMMERS]);
console.log(`Tracking ${SWIMMERS.length} swimmers`);
const swimmerMap = Object.fromEntries(SWIMMERS.map(s => [s, []]));
const warnings=[];
for(const item of htmlBySeries){
  const distances=parseCalendar(item.calendarHtml);
  const lapY=parseLapY(item.lapYHtml,item.series.short,distances,SWIMMERS);
  for(const swimmer of SWIMMERS) swimmerMap[swimmer].push(...(lapY[swimmer] || []));
}
const allEntries=Object.values(swimmerMap).flat();
rankRaceEntries(allEntries);
const swimmers=SWIMMERS.map(name => ({name, races:swimmerMap[name].sort((a,b)=>a.date.localeCompare(b.date))}));
const output={
  last_updated:new Date().toISOString(),
  source:'Balmoral Beach Club SeriesResults lap=Y and CalendarRep1 pages',
  primarySwimmer:PRIMARY_SWIMMER,
  config:CONFIG,
  filters:{excludedDates:[...EXCLUDED_DATES], maxPaceSeconds:MAX_PACE_SECONDS},
  points:{method:'Website points parsed from the Balmoral results table. Fallback uses numeric value in date group only if a Points/Pts column header is not detected.'},
  swimmers,
  warnings
};
await fs.writeFile('data/results.json', JSON.stringify(output,null,2));
console.log(`Wrote data/results.json for ${swimmers.length} swimmers and ${allEntries.length} race entries`);
if(warnings.length) console.warn('Warnings:\n'+warnings.join('\n'));
