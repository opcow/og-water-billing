const XLSX = require('./js/vendor/xlsx.full.min.js');
const fs   = require('fs');
const buf  = fs.readFileSync('Water Meters 2026.ods');
const wb   = XLSX.read(new Uint8Array(buf), { type: 'array', cellDates: false });

const ws   = wb.Sheets[wb.SheetNames[0]];
const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
console.log('All rows for Jan 2026:');
rows.forEach((r, i) => console.log(` row ${String(i).padStart(2)}: ${JSON.stringify(r)}`));
