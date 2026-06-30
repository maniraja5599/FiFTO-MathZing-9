const ist = new Date(Date.now() + 5.5 * 60 * 60 * 1000);
const day     = ist.getUTCDay();
const hour    = ist.getUTCHours();
const min     = ist.getUTCMinutes();
const dateStr = ist.toISOString().slice(0, 10);

console.log('--- Date.now() Time Resolution ---');
console.log('Date.now():', Date.now());
console.log('ist date string:', ist.toISOString());
console.log('day:', day);
console.log('hour:', hour);
console.log('min:', min);
console.log('dateStr:', dateStr);
