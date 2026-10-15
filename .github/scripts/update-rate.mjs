// Updates rates/freddie-mac-30yr.json from the Freddie Mac PMMS 30-year series published on FRED.
// Safe to run repeatedly: it only rewrites the file when there is a newer, valid figure.
// RATE_SOURCE can point at another URL or a local file path (used for testing).
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const SOURCE = process.env.RATE_SOURCE || 'https://fred.stlouisfed.org/graph/fredgraph.csv?id=MORTGAGE30US';
const OUT = process.env.RATE_OUT || 'rates/freddie-mac-30yr.json';
const MIN = 2, MAX = 15; // percent; anything outside is treated as a bad download

const text = /^https?:/.test(SOURCE)
  ? await fetch(SOURCE, { headers: { 'user-agent': 'basi.onl rate updater' } }).then((r) => {
      if (!r.ok) throw new Error(`Download failed: HTTP ${r.status}`);
      return r.text();
    })
  : readFileSync(SOURCE, 'utf8');

// Rows look like "2026-10-08,7.40"; FRED marks a missing week with ".". Take the newest real row.
const rows = text.trim().split(/\r?\n/).slice(1)
  .map((line) => line.split(','))
  .filter(([date, v]) => /^\d{4}-\d{2}-\d{2}$/.test(date) && /^\d+(\.\d+)?$/.test((v ?? '').trim()));
if (!rows.length) throw new Error('No usable rows in the download');

const [asOfDate, raw] = rows[rows.length - 1];
const percent = Number(raw);
if (!(percent >= MIN && percent <= MAX)) throw new Error(`Rate ${percent}% is outside ${MIN}-${MAX}%, refusing to publish`);
const value = Math.round(percent * 100) / 10000; // 7.40 -> 0.074

const current = existsSync(OUT) ? JSON.parse(readFileSync(OUT, 'utf8')) : null;
if (current && current.asOfDate >= asOfDate) {
  console.log(`No update: file already has ${current.asOfDate} (${(current.value * 100).toFixed(2)}%), source newest is ${asOfDate}.`);
  process.exit(0);
}
writeFileSync(OUT, JSON.stringify({ value, asOfDate }, null, 2) + '\n');
console.log(`Updated to ${percent}% for week of ${asOfDate}.`);
