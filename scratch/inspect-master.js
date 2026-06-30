import { readFileSync } from 'fs';

const master = JSON.parse(readFileSync('./instrument-master-cache.json', 'utf8'));
const today = new Date('2026-06-01');

const niftyOpts = master.data.filter(r => 
  r.exch_seg === 'NFO' && 
  r.name === 'NIFTY' && 
  r.instrumenttype === 'OPTIDX'
);

const uniqueExpiries = [...new Set(niftyOpts.map(r => r.expiry))];
const MONTHS = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];

function parseMasterExpiry(exp) {
  const dd = parseInt(exp.slice(0, 2), 10);
  const mmStr = exp.slice(2, 5);
  const yyyy = parseInt(exp.slice(5), 10);
  const mm = MONTHS.indexOf(mmStr);
  return new Date(yyyy, mm, dd);
}

const chronExpiries = uniqueExpiries
  .map(exp => ({ exp, date: parseMasterExpiry(exp) }))
  .sort((a, b) => a.date - b.date);

console.log('Chronological expiries from June 1, 2026:');
chronExpiries.forEach(({ exp, date }) => {
  if (date >= today) {
    console.log(`- ${exp} (${date.toISOString().split('T')[0]})`);
  }
});
