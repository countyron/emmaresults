import fs from 'fs/promises';
import * as cheerio from 'cheerio';

const CONFIG = JSON.parse(await fs.readFile('data/config.json', 'utf8'));
const SEASON = CONFIG.season || 2025;
const PRIMARY_SWIMMER = CONFIG.primarySwimmer || 'Bennett, Emma';
let SWIMMERS = Array.isArray(CONFIG.swimmers) ? CONFIG.swimmers : [];
const TRACK_ALL = CONFIG.trackAllSwimmers !== false;

const EXCLUDED_DATES = new Set([
  '2026-05-03',
  '2026-05-10'
]);
const MAX_PACE_SECONDS = 180; // exclude paces slower than 3:00 /100 m

const SERIES = (CONFIG.series || []).map(s => ({
  ...s,
  resultsUrl: `https://www.balmoralbeachclub.org.au/BaseTemplate.cfm?FileName=SeriesResults.cfm&EventID=${s.eventId}&n=1&Season=${SEASON}&REQUESTTIMEOUT=500&P=BeachPublic&lap=Y`,
  calendarUrl: `https://www.balmoralbeachclub.org.au/BaseTemplate.cfm?FileName=CalendarRep1.cfm&EventID=${s.eventId}&Season=${SEASON}&P=BeachPublic`
}));

function clean(s){ return (s || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim(); }
function normaliseName(s){ return clean(s).toLowerCase().replace(/\s*,\s*/g, ', '); }
function looksLikeName(s){ return /^[A-Za-z][A-Za-z' -]+,\s*[A-Za-z][A-Za-z' -]+(?:\s+[A-Za-z' -]+)?$/.test(clean(s)); }
function unique(arr){ return [...new Set(arr.filter(Boolean))]; }

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

function parsePaceSeconds(value){
  const v = clean(value);
  if(!v || /^[-–—]$/.test(v)) return null;
  const m = v.match(/^(\d+):(\d{1,2})(?:\.(\d+))?$/);
  if(!m) return null;
  const seconds = Number(m[1]) * 60 + Number(m[2]) + Number('0.' + (m[3] || '0'));
  if(!Number.isFinite(seconds)) return null;
  if(seconds > MAX_PACE_SECONDS) return null;
  return seconds;
}

async function fetchText(url){
  const res = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0 BalmoralSwimTracker/1.5' }});
  if(!res.ok) throw new Error(`Fetch failed ${res.status}: ${url}`);
  return await res.text();
}

// Important: this expands colspan/rowspan so the data cells stay aligned with their date headers.
function extractTables(html){
  const $ = cheerio.load(html);
  return $('table').toArray().map(table => {
    const grid = [];
    const spanMap = new Map();

    $(table).find('tr').each((r, tr) => {
      const row = [];
      let c = 0;

      while(spanMap.has(`${r},${c}`)){
        row[c] = spanMap.get(`${r},${c}`);
        c++;
      }

      $(tr).find('th,td').each((_, cell) => {
        while(spanMap.has(`${r},${c}`)){
          row[c] = spanMap.get(`${r},${c}`);
          c++;
        }

        const text = clean($(cell).text());
        const colspan = Math.max(1, parseInt($(cell).attr('colspan') || '1', 10));
        const rowspan = Math.max(1, parseInt($(cell).attr('rowspan') || '1', 10));

        for(let dc = 0; dc < colspan; dc++){
          row[c + dc] = text;
          for(let dr = 1; dr < rowspan; dr++){
            spanMap.set(`${r + dr},${c + dc}`, text);
          }
        }
        c += colspan;
      });

      grid.push(row);
    });

    return grid;
  });
}

function findBestResultsTable(tables){
  return tables
    .map(t => ({ rows:t, cols: Math.max(0, ...t.map(r => r.length)), names: t.flat().filter(looksLikeName).length }))
    .sort((a,b) => (b.names * 1000 + b.cols) - (a.names * 1000 + a.cols))[0]?.rows || [];
}

function getNameFromRow(row){
  for(const cell of row.slice(0, 5)){
    if(looksLikeName(cell)) return clean(cell);
  }
  if(row.length >= 2 && /^[A-Za-z][A-Za-z' -]+$/.test(clean(row[0])) && /^[A-Za-z][A-Za-z' -]+$/.test(clean(row[1]))){
    return `${clean(row[0])}, ${clean(row[1])}`;
  }
  return null;
}

function discoverSwimmersFromResults(tables){
  const names = [];
  for(const table of tables){
    for(const row of table){
      const name = getNameFromRow(row);
      if(name && !/^Name$/i.test(name)) names.push(name);
    }
  }
  return unique(names).sort((a,b) => a.localeCompare(b));
}

function parseCalendar(html){
  const tables = extractTables(html);
  const distances = {};
  const months = {Jan:'01',Feb:'02',Mar:'03',Apr:'04',May:'05',Jun:'06',Jul:'07',Aug:'08',Sep:'09',Oct:'10',Nov:'11',Dec:'12'};

  for(const table of tables){
    for(const row of table){
      const dateCell = row.find(c => /\d{1,2}-[A-Z][a-z]{2}-\d{4}/.test(c));
      if(!dateCell) continue;
      const dm = dateCell.match(/(\d{1,2})-([A-Z][a-z]{2})-(\d{4})/);
      if(!dm || !months[dm[2]]) continue;

      const iso = `${dm[3]}-${months[dm[2]]}-${String(dm[1]).padStart(2,'0')}`;
      const dist = row.map(c => c.match(/^\d{3,4}$/)?.[0]).filter(Boolean).map(Number).find(n => n >= 500 && n <= 3000);
      distances[iso] = dist || null;
    }
  }
  return distances;
}

function buildDateGroups(table){
  // Build a date marker for each table column from all header-like rows before the swimmer rows.
  const firstSwimmerRow = table.findIndex(row => getNameFromRow(row));
  const headerRows = table.slice(0, firstSwimmerRow >= 0 ? firstSwimmerRow : Math.min(8, table.length));
  const maxCols = Math.max(0, ...table.map(r => r.length));
  const dateByCol = Array(maxCols).fill(null);

  for(const row of headerRows){
    for(let c = 0; c < maxCols; c++){
      const iso = toIsoFromText(row[c] || '');
      if(iso) dateByCol[c] = iso;
    }
  }

  // Fill short gaps where dates are only shown once across a group. This happens after colspan expansion
  // if a secondary header row replaces the text in some positions.
  let last = null;
  for(let c = 0; c < maxCols; c++){
    if(dateByCol[c]) last = dateByCol[c];
    else if(last) dateByCol[c] = last;
  }

  const groups = [];
  for(let c = 0; c < maxCols; c++){
    const date = dateByCol[c];
    if(!date) continue;
    if(groups.length && groups[groups.length - 1].date === date){
      groups[groups.length - 1].end = c;
    } else {
      groups.push({ date, start:c, end:c });
    }
  }

  // Remove duplicate groups beyond the first occurrence of each date.
  const seen = new Set();
  return groups.filter(g => {
    if(seen.has(g.date)) return false;
    seen.add(g.date);
    return true;
  });
}

function parseSeriesResults(html, calendarDistances, seriesShort, swimmersToTrack){
  const tables = extractTables(html);
  const table = findBestResultsTable(tables);
  if(!table.length) return { swimmerRaces: {}, warnings: [`No results table found for ${seriesShort}`] };

  const dateGroups = buildDateGroups(table);
  const swimmerRaces = {};
  const warnings = [];

  console.log(`${seriesShort}: found ${dateGroups.length} date groups`);
  if(!dateGroups.length) warnings.push(`${seriesShort}: no date groups detected in results table`);

  const rowsByName = new Map();
  for(const row of table){
    const name = getNameFromRow(row);
    if(name) rowsByName.set(normaliseName(name), row);
  }

  for(const swimmer of swimmersToTrack){
    const row = rowsByName.get(normaliseName(swimmer));
    if(!row){ swimmerRaces[swimmer] = []; continue; }

    const races = [];
    for(const group of dateGroups){
      const candidateCells = row.slice(group.start, group.end + 1);
      const paceCell = candidateCells.find(cell => parsePaceSeconds(cell) !== null);
      const seconds = parsePaceSeconds(paceCell);

      if(seconds === null) continue;
      if(EXCLUDED_DATES.has(group.date)) continue;

      races.push({
        date: group.date,
        day: new Date(group.date + 'T00:00:00Z').toLocaleDateString('en-AU', { weekday:'long', timeZone:'UTC' }),
        series: seriesShort,
        distance_m: calendarDistances[group.date] || null,
        pace_raw: paceCell,
        pace_seconds_per_100m: seconds
      });
    }

    swimmerRaces[swimmer] = races;
    if(races.length) console.log(`${seriesShort}: ${swimmer} ${races.length} race entries`);
  }

  return { swimmerRaces, warnings };
}

const htmlBySeries = [];
const discovered = [];

for(const s of SERIES){
  console.log(`Fetching ${s.name || s.short}`);
  const [resultsHtml, calendarHtml] = await Promise.all([fetchText(s.resultsUrl), fetchText(s.calendarUrl)]);
  htmlBySeries.push({ series:s, resultsHtml, calendarHtml });
  if(TRACK_ALL) discovered.push(...discoverSwimmersFromResults(extractTables(resultsHtml)));
}

SWIMMERS = TRACK_ALL ? unique([PRIMARY_SWIMMER, ...discovered]).sort((a,b) => a.localeCompare(b)) : unique([PRIMARY_SWIMMER, ...SWIMMERS]);
console.log(`Tracking ${SWIMMERS.length} swimmers`);

const swimmerMap = Object.fromEntries(SWIMMERS.map(s => [s, []]));
const warnings = [];

for(const item of htmlBySeries){
  const calendarDistances = parseCalendar(item.calendarHtml);
  const parsed = parseSeriesResults(item.resultsHtml, calendarDistances, item.series.short, SWIMMERS);
  warnings.push(...parsed.warnings);
  for(const swimmer of SWIMMERS){
    swimmerMap[swimmer].push(...(parsed.swimmerRaces[swimmer] || []));
  }
}

const swimmers = SWIMMERS.map(name => ({
  name,
  races: swimmerMap[name].sort((a,b) => a.date.localeCompare(b.date))
}));

const output = {
  last_updated: new Date().toISOString(),
  source: 'Balmoral Beach Club SeriesResults lap=Y and CalendarRep1 pages',
  primarySwimmer: PRIMARY_SWIMMER,
  config: CONFIG,
  filters: {
    excludedDates: [...EXCLUDED_DATES],
    maxPaceSeconds: MAX_PACE_SECONDS
  },
  swimmers,
  warnings
};

await fs.writeFile('data/results.json', JSON.stringify(output, null, 2));
console.log(`Wrote data/results.json for ${swimmers.length} swimmers and ${swimmers.reduce((n,s) => n + s.races.length, 0)} race entries`);
if(warnings.length) console.warn('Warnings:\n' + warnings.join('\n'));
