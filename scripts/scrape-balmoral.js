import fs from 'fs/promises';
import * as cheerio from 'cheerio';

const CONFIG = JSON.parse(await fs.readFile('data/config.json', 'utf8'));
const SEASON = CONFIG.season || 2025;
const SWIMMERS = CONFIG.swimmers || [];
const SERIES = (CONFIG.series || []).map(s => ({
  ...s,
  resultsUrl: `https://www.balmoralbeachclub.org.au/BaseTemplate.cfm?FileName=SeriesResults.cfm&EventID=${s.eventId}&n=1&Season=${SEASON}&REQUESTTIMEOUT=500&P=BeachPublic&lap=Y`,
  calendarUrl: `https://www.balmoralbeachclub.org.au/BaseTemplate.cfm?FileName=CalendarRep1.cfm&EventID=${s.eventId}&Season=${SEASON}&P=BeachPublic`
}));

function clean(s){ return (s || '').replace(/\u00a0/g,' ').replace(/\s+/g,' ').trim(); }
function normaliseName(s){ return clean(s).toLowerCase().replace(/\s*,\s*/g, ', '); }

function toIsoFromHeader(label){
  const text = clean(label);
  // Accept date headings such as "May 2", "May 02", "2 May", "02-May-2026".
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
  // Reject rolled dates such as 31-Feb.
  if(d.getUTCFullYear() !== year || d.getUTCMonth() !== month || d.getUTCDate() !== day) return null;
  return d.toISOString().slice(0,10);
}

function parsePaceSeconds(value){
  const v = clean(value);
  if(!v || /^[-–—]$/.test(v)) return null;
  const m = v.match(/^(\d+):(\d{1,2})(?:\.(\d+))?$/);
  if(m) return Number(m[1])*60 + Number(m[2]) + Number('0.'+(m[3]||'0'));
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

async function fetchText(url){
  const res = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0 BalmoralSwimTracker/1.2' }});
  if(!res.ok) throw new Error(`Fetch failed ${res.status}: ${url}`);
  return await res.text();
}
function extractTables(html){
  const $ = cheerio.load(html);
  return $('table').toArray().map(table => $(table).find('tr').toArray().map(tr => $(tr).find('th,td').toArray().map(td => clean($(td).text()))));
}
function findBestResultsTable(tables){
  return tables.map(t => ({
    rows: t,
    score: SWIMMERS.some(s => JSON.stringify(t).toLowerCase().includes(normaliseName(s))) ? 1000 : 0,
    cols: Math.max(0,...t.map(r=>r.length))
  })).sort((a,b)=>(b.score+b.cols)-(a.score+a.cols))[0]?.rows || [];
}
function parseCalendar(html){
  const tables = extractTables(html); const distances = {};
  const months = {Jan:'01',Feb:'02',Mar:'03',Apr:'04',May:'05',Jun:'06',Jul:'07',Aug:'08',Sep:'09',Oct:'10',Nov:'11',Dec:'12'};
  for(const table of tables){
    for(const row of table){
      const dateCell = row.find(c => /\d{1,2}-[A-Z][a-z]{2}-\d{4}/.test(c));
      if(!dateCell) continue;
      const dm = dateCell.match(/(\d{1,2})-([A-Z][a-z]{2})-(\d{4})/);
      if(!dm || !months[dm[2]]) continue;
      const iso = `${dm[3]}-${months[dm[2]]}-${String(dm[1]).padStart(2,'0')}`;
      const dist = row.map(c => c.match(/^\d{3,4}$/)?.[0]).filter(Boolean).map(Number).find(n => n >= 500 && n <= 3000);
      if(dist) distances[iso] = dist;
    }
  }
  return distances;
}
function parseSeriesResults(html, calendarDistances, seriesShort){
  const table = findBestResultsTable(extractTables(html));
  if(!table.length) return { swimmerRaces: {}, warnings: [`No results table found for ${seriesShort}`] };

  let headerIdx = table.findIndex(r => r.some(c => /^Name$/i.test(c)) && r.some(c => /Races/i.test(c)));
  if(headerIdx < 0) {
    // Fallback: choose the row with the most parseable date headings.
    headerIdx = table.map((r,i)=>({i,count:r.map(toIsoFromHeader).filter(Boolean).length})).sort((a,b)=>b.count-a.count)[0]?.i ?? 0;
  }
  const header = table[headerIdx];
  const dateCols = header.map((h,i)=>({i, date: toIsoFromHeader(h), heading:h})).filter(x=>x.date);
  const swimmerRaces = {}; const warnings = [];
  console.log(`${seriesShort}: found ${dateCols.length} date columns`);
  if(!dateCols.length) warnings.push(`${seriesShort}: no date columns detected in results table`);

  for(const swimmer of SWIMMERS){
    const target = normaliseName(swimmer);
    const row = table.find((r, idx) => idx !== headerIdx && normaliseName(r.join(' ')).includes(target));
    if(!row){ warnings.push(`${swimmer} row not found for ${seriesShort}`); swimmerRaces[swimmer] = []; continue; }
    swimmerRaces[swimmer] = dateCols.map(col => {
      const raw = row[col.i] || ''; const seconds = parsePaceSeconds(raw);
      if(seconds == null) return null;
      return { date: col.date, day: new Date(col.date+'T00:00:00Z').toLocaleDateString('en-AU',{weekday:'long', timeZone:'UTC'}), series: seriesShort, distance_m: calendarDistances[col.date] || null, pace_raw: raw, pace_seconds_per_100m: seconds };
    }).filter(Boolean);
    console.log(`${seriesShort}: ${swimmer} ${swimmerRaces[swimmer].length} race entries`);
  }
  return { swimmerRaces, warnings };
}

const swimmerMap = Object.fromEntries(SWIMMERS.map(s => [s, []]));
const warnings = [];
for(const s of SERIES){
  console.log(`Fetching ${s.name || s.short}`);
  const [resultsHtml, calendarHtml] = await Promise.all([fetchText(s.resultsUrl), fetchText(s.calendarUrl)]);
  const distances = parseCalendar(calendarHtml);
  const parsed = parseSeriesResults(resultsHtml, distances, s.short);
  warnings.push(...parsed.warnings);
  for(const swimmer of SWIMMERS) swimmerMap[swimmer].push(...(parsed.swimmerRaces[swimmer] || []));
}
const swimmers = SWIMMERS.map(name => ({ name, races: swimmerMap[name].sort((a,b)=>a.date.localeCompare(b.date)) }));
const output = { last_updated: new Date().toISOString(), source: 'Balmoral Beach Club SeriesResults lap=Y and CalendarRep1 pages', config: CONFIG, swimmers, warnings };
await fs.writeFile('data/results.json', JSON.stringify(output, null, 2));
console.log(`Wrote data/results.json for ${swimmers.length} swimmers and ${swimmers.reduce((n,s)=>n+s.races.length,0)} race entries`);
if(warnings.length) console.warn('Warnings:\n' + warnings.join('\n'));
