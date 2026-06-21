import fs from 'fs/promises';
import * as cheerio from 'cheerio';

const CONFIG = JSON.parse(await fs.readFile('data/config.json', 'utf8'));
const SEASON = CONFIG.season || 2025;
const PRIMARY_SWIMMER = CONFIG.primarySwimmer || 'Bennett, Emma';
let SWIMMERS = Array.isArray(CONFIG.swimmers) ? CONFIG.swimmers : [];
const TRACK_ALL = CONFIG.trackAllSwimmers !== false;

const SERIES = (CONFIG.series || []).map(s => ({
  ...s,
  resultsUrl: `https://www.balmoralbeachclub.org.au/BaseTemplate.cfm?FileName=SeriesResults.cfm&EventID=${s.eventId}&n=1&Season=${SEASON}&REQUESTTIMEOUT=500&P=BeachPublic&lap=Y`,
  calendarUrl: `https://www.balmoralbeachclub.org.au/BaseTemplate.cfm?FileName=CalendarRep1.cfm&EventID=${s.eventId}&Season=${SEASON}&P=BeachPublic`
}));

function clean(s){
  return (s || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
}

function normaliseName(s){
  return clean(s).toLowerCase().replace(/\s*,\s*/g, ', ');
}

function looksLikeName(s){
  return /^[A-Za-z][A-Za-z' -]+,\s*[A-Za-z][A-Za-z' -]+(?:\s+[A-Za-z' -]+)?$/.test(clean(s));
}

function unique(arr){
  return [...new Set(arr.filter(Boolean))];
}

function parsePaceSeconds(value){
  const v = clean(value);
  if(!v || /^[-–—]$/.test(v)) return null;

  // Only accept proper lap pace values, e.g. 1:36, 1:44, 2:37.
  // Reject simple numbers such as 1, 2, 3 because those are usually points/places.
  const m = v.match(/^(\d+):(\d{1,2})(?:\.(\d+))?$/);
  if(m) return Number(m[1]) * 60 + Number(m[2]) + Number('0.' + (m[3] || '0'));

  return null;
}

async function fetchText(url){
  const res = await fetch(url, {
    headers: { 'user-agent': 'Mozilla/5.0 BalmoralSwimTracker/1.4' }
  });
  if(!res.ok) throw new Error(`Fetch failed ${res.status}: ${url}`);
  return await res.text();
}

function extractTables(html){
  const $ = cheerio.load(html);
  return $('table').toArray().map(table =>
    $(table).find('tr').toArray().map(tr =>
      $(tr).find('th,td').toArray().map(td => clean($(td).text()))
    )
  );
}

function findBestResultsTable(tables){
  return tables
    .map(t => ({
      rows: t,
      cols: Math.max(0, ...t.map(r => r.length)),
      names: t.flat().filter(looksLikeName).length
    }))
    .sort((a, b) => (b.names * 1000 + b.cols) - (a.names * 1000 + a.cols))[0]?.rows || [];
}

function getNameFromRow(row){
  for(const cell of row.slice(0, 4)){
    if(looksLikeName(cell)) return clean(cell);
  }

  // Fallback where surname/firstname are split across adjacent cells.
  if(
    row.length >= 2 &&
    /^[A-Za-z][A-Za-z' -]+$/.test(clean(row[0])) &&
    /^[A-Za-z][A-Za-z' -]+$/.test(clean(row[1]))
  ){
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

  return unique(names).sort((a, b) => a.localeCompare(b));
}

function parseCalendar(html){
  const tables = extractTables(html);
  const calendar = [];

  const months = {
    Jan:'01', Feb:'02', Mar:'03', Apr:'04', May:'05', Jun:'06',
    Jul:'07', Aug:'08', Sep:'09', Oct:'10', Nov:'11', Dec:'12'
  };

  for(const table of tables){
    for(const row of table){
      const dateCell = row.find(c => /\d{1,2}-[A-Z][a-z]{2}-\d{4}/.test(c));
      if(!dateCell) continue;

      const dm = dateCell.match(/(\d{1,2})-([A-Z][a-z]{2})-(\d{4})/);
      if(!dm || !months[dm[2]]) continue;

      const iso = `${dm[3]}-${months[dm[2]]}-${String(dm[1]).padStart(2, '0')}`;

      const dist = row
        .map(c => c.match(/^\d{3,4}$/)?.[0])
        .filter(Boolean)
        .map(Number)
        .find(n => n >= 500 && n <= 3000);

      calendar.push({
        date: iso,
        distance_m: dist || null
      });
    }
  }

  // Remove duplicate dates while preserving calendar order.
  const seen = new Set();
  return calendar.filter(r => {
    if(seen.has(r.date)) return false;
    seen.add(r.date);
    return true;
  });
}

function parseSeriesResults(html, calendarEntries, seriesShort, swimmersToTrack){
  const tables = extractTables(html);
  const table = findBestResultsTable(tables);

  if(!table.length){
    return {
      swimmerRaces: {},
      warnings: [`No results table found for ${seriesShort}`]
    };
  }

  const swimmerRaces = {};
  const warnings = [];

  console.log(`${seriesShort}: calendar has ${calendarEntries.length} race dates`);

  const rowsByName = new Map();
  for(let idx = 0; idx < table.length; idx++){
    const name = getNameFromRow(table[idx]);
    if(name) rowsByName.set(normaliseName(name), table[idx]);
  }

  for(const swimmer of swimmersToTrack){
    const row = rowsByName.get(normaliseName(swimmer));

    if(!row){
      swimmerRaces[swimmer] = [];
      continue;
    }

    // Extract all valid pace fields in row order.
    // The official calendar supplies the race date sequence.
    const paceCells = row.filter(cell => parsePaceSeconds(cell) !== null);
    const races = [];

    for(let i = 0; i < Math.min(paceCells.length, calendarEntries.length); i++){
      const calendarRace = calendarEntries[i];
      const paceCell = paceCells[i];
      const seconds = parsePaceSeconds(paceCell);

      if(seconds === null) continue;

      races.push({
        date: calendarRace.date,
        day: new Date(calendarRace.date + 'T00:00:00Z').toLocaleDateString('en-AU', {
          weekday: 'long',
          timeZone: 'UTC'
        }),
        series: seriesShort,
        distance_m: calendarRace.distance_m,
        pace_raw: paceCell,
        pace_seconds_per_100m: seconds
      });
    }

    swimmerRaces[swimmer] = races;

    if(races.length){
      console.log(`${seriesShort}: ${swimmer} ${races.length} race entries`);
    }
  }

  return { swimmerRaces, warnings };
}

const htmlBySeries = [];
const discovered = [];

for(const s of SERIES){
  console.log(`Fetching ${s.name || s.short}`);
  const [resultsHtml, calendarHtml] = await Promise.all([
    fetchText(s.resultsUrl),
    fetchText(s.calendarUrl)
  ]);

  htmlBySeries.push({ series: s, resultsHtml, calendarHtml });

  if(TRACK_ALL){
    discovered.push(...discoverSwimmersFromResults(extractTables(resultsHtml)));
  }
}

SWIMMERS = TRACK_ALL
  ? unique([PRIMARY_SWIMMER, ...discovered]).sort((a, b) => a.localeCompare(b))
  : unique([PRIMARY_SWIMMER, ...SWIMMERS]);

console.log(`Tracking ${SWIMMERS.length} swimmers`);

const swimmerMap = Object.fromEntries(SWIMMERS.map(s => [s, []]));
const warnings = [];

for(const item of htmlBySeries){
  const calendarEntries = parseCalendar(item.calendarHtml);
  const parsed = parseSeriesResults(item.resultsHtml, calendarEntries, item.series.short, SWIMMERS);

  warnings.push(...parsed.warnings);

  for(const swimmer of SWIMMERS){
    swimmerMap[swimmer].push(...(parsed.swimmerRaces[swimmer] || []));
  }
}

const swimmers = SWIMMERS.map(name => ({
  name,
  races: swimmerMap[name].sort((a, b) => a.date.localeCompare(b.date))
}));

const output = {
  last_updated: new Date().toISOString(),
  source: 'Balmoral Beach Club SeriesResults lap=Y and CalendarRep1 pages',
  primarySwimmer: PRIMARY_SWIMMER,
  config: CONFIG,
  swimmers,
  warnings
};

await fs.writeFile('data/results.json', JSON.stringify(output, null, 2));

console.log(`Wrote data/results.json for ${swimmers.length} swimmers and ${swimmers.reduce((n, s) => n + s.races.length, 0)} race entries`);

if(warnings.length){
  console.warn('Warnings:\n' + warnings.join('\n'));
}
