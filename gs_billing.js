// cell J2 contains the address of the rate table
// calcBill(2000, [[2000, 2.93, 1000]]);
// table = [[2000, 3.00, 1000, 25.20],[4999, 8.00, 1000],['-', 9.00, 1000]];

function calcBill(gal) {
  var app = SpreadsheetApp;
  var activeSheet = app.getActiveSpreadsheet().getActiveSheet();
  var tabAddr = activeSheet.getRange('J2').getValue();
  var tab = activeSheet.getRange(tabAddr).getValues();
  var total = Number(tab[0][3]) || 0; // sets total to minimum charge
  var bracket;
  // loop through each rate bracket
  // row[0] holds the bracket size
  // or "-" meaning all remaining gallons
  // row[1] contains the rate per row[2]
  for (var i = 0; i < tab.length; i++) {
    var row = tab[i];
    bracket = row[0];
    if (bracket == '-' || gal <= bracket) {
      bracket = gal;
      total = total + bracket * row[1] / row[2];
      break;
    } else {
      total = total + bracket * row[1] / row[2];
    }
    gal = gal - bracket;
  }
  return total;
}


function setBillingDates(newSheet, latestSheet) {
  // update the dates
  var begDate = newSheet.getRange("B1");
  var endDate = newSheet.getRange("D1");
  var baseEnd = new Date(endDate.getValue());
  var tempEnd = new Date(baseEnd);
  var tempBeg = new Date(baseEnd);

  // set the beginning/end day of month to the 4/3
  var tabAddr = latestSheet.getRange('J2').getValue();
  var billingDay = latestSheet.getRange(tabAddr).getValues()[0][4];
  tempEnd.setDate(billingDay);
  tempBeg.setDate(billingDay + 1);
  begDate.setValue(tempBeg);

  // set new month and handle new year change
  var oldMonth = tempEnd.getMonth();
  tempEnd.setMonth(oldMonth + 1);
  endDate.setValue(tempEnd);
}


// creates a new sheet, copies the previous sheet to
// the new sheet, and copies the previous end column
// to the new start column
function newMonth() {

  var app = SpreadsheetApp;
  var ss = app.getActiveSpreadsheet();
  var latestSheet = ss.getSheets()[ss.getNumSheets() - 1]

  // copy the sheet
  var newSheet = latestSheet.copyTo(ss);
  app.flush();
  ss.setActiveSheet(newSheet);

  setBillingDates(newSheet, latestSheet);
  newSheet.setName(Utilities.formatDate(newSheet.getRange("D1").getValue(), Session.getScriptTimeZone(), "MMM YYYY"));

  // copy end reading to start reading
  var firstRow = newSheet.getRange("H2").getValue();
  var lastRow = newSheet.getRange("I2").getValue();
  var endRange = newSheet.getRange("C" + firstRow + ":C" + lastRow);
  var begRange = newSheet.getRange("B" + firstRow + ":B" + lastRow);
  endRange.copyTo(begRange);

  var protections = latestSheet.getProtections(SpreadsheetApp.ProtectionType.RANGE);
  for (var i = 0; i < protections.length; i++) {
    var p = protections[i];
    var rangeNotation = p.getRange().getA1Notation();
    var p2 = newSheet.getRange(rangeNotation).protect();
    p2.setDescription(p.getDescription());
    p2.setWarningOnly(p.isWarningOnly());
    if (!p.isWarningOnly()) {
      var editors = p.getEditors();
      var newEditors = p2.getEditors();
      if (newEditors.length) {
        p2.removeEditors(newEditors);
      }
      if (editors.length) {
        p2.addEditors(editors);
      }
      if (p.canDomainEdit() !== p2.canDomainEdit()) {
        p2.setDomainEdit(p.canDomainEdit());
      }
    }
  }
}

// prorates the bill for a 30 day period in case of a late reading
function prorateBilling() {
  var app = SpreadsheetApp;
  var activeSheet = app.getActiveSpreadsheet().getActiveSheet();

  var begDate = activeSheet.getRange("B1").getValue();
  var endDate = activeSheet.getRange("D1").getValue();
  var diffTime = Math.ceil((endDate - begDate) / (1000 * 3600 * 24)) + 1;
  if (diffTime < 1) { throw new Error("End date is the same as or before the begin date."); }
  var firstRow = activeSheet.getRange("H2").getValue();
  var lastRow = activeSheet.getRange("I2").getValue();
  var tab = activeSheet.getRange(activeSheet.getRange("J2").getValue()).getValues();

  var billDay = tab[0][4];
  var billMonth = begDate.getMonth();
  var t = new Date(begDate.getFullYear(), begDate.getMonth() + 1, 0);
  var monLength = t.getDate();
  endDate.setMonth(billMonth + 1, billDay);
  activeSheet.getRange("D1").setValue(endDate);

  for (var i = firstRow; i <= lastRow; i++) {
    var beg = "B" + i;
    var end = "C" + i;
    var net = "D" + i;
    var total = activeSheet.getRange(net).getValue();
    total = (total / diffTime) * monLength;
    total = total - total % 10;
    activeSheet.getRange(end).setValue(activeSheet.getRange(beg).getValue() + total);
  }
  // do main meter which is 3 rows below the last
  var total = activeSheet.getRange("D" + (lastRow + 3)).getValue();
  total = (total / diffTime) * monLength;
  total = total - total % 10;
  activeSheet.getRange("C" + (lastRow + 3)).setValue(activeSheet.getRange("B" + (lastRow + 3)).getValue() + total);
}

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('Billing Tools')
    .addItem('Export for PWA import…', 'exportForPWA')
    .addToUi();
}


function exportForPWA() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const tz = Session.getScriptTimeZone();

  function toDateStr(v) {
    return Utilities.formatDate(new Date(v), tz, 'yyyy-MM-dd');
  }

  function cleanRateTable(rows) {
    return rows
      .filter(r => r[0] !== '' && r[0] !== null && r[0] !== undefined)
      .map(r => {
        const out = r.slice(0, 3).map(Number);
        if (typeof r[0] === 'string') out[0] = r[0]; // preserve "-"
        for (let i = 3; i < r.length; i++) {
          if (r[i] !== '' && r[i] !== null) out.push(Number(r[i]));
        }
        return out;
      });
  }

  // Find last data sheet (has a Date in D1)
  const sheets = ss.getSheets();
  let latestSheet = null;
  for (let i = sheets.length - 1; i >= 0; i--) {
    if (sheets[i].getRange('D1').getValue() instanceof Date) {
      latestSheet = sheets[i];
      break;
    }
  }
  if (!latestSheet) throw new Error('No billing sheets found.');

  // Build accounts from latest sheet.
  // I2 (lr0) points to the master meter row; lr0-2 and lr0-1 are totals/blank.
  // Actual sub-accounts occupy rows fr0 through lr0-3.
  const fr0         = latestSheet.getRange('H2').getValue();
  const lr0         = latestSheet.getRange('I2').getValue();
  const acctLr0     = lr0 - 3;
  const nameVals    = latestSheet.getRange('A' + fr0 + ':A' + acctLr0).getValues();

  const accounts = nameVals
    .map(r => String(r[0]).trim())
    .filter(n => n)
    .map((name, i) => ({
      id: i + 1, name, accountHolder: '', phone: '', sortOrder: i,
    }));

  const masterName = String(latestSheet.getRange('A' + lr0).getValue() || 'Master');
  const masterMeter = {
    id: 0, name: masterName, accountHolder: '', phone: '',
    meterDefective: false, fixedCharge: null,
  };

  const nameToId = {};
  accounts.forEach(a => { nameToId[a.name] = a.id; });

  // Rate table from latest sheet
  const tabAddr  = latestSheet.getRange('J2').getValue();
  const rateTable = cleanRateTable(latestSheet.getRange(tabAddr).getValues());

  // Iterate sheets → periods
  const periods = [];
  for (const sheet of sheets) {
    const startVal = sheet.getRange('B1').getValue();
    const endVal   = sheet.getRange('D1').getValue();
    if (!(startVal instanceof Date) || !(endVal instanceof Date)) continue;

    const fr    = sheet.getRange('H2').getValue();
    const lr    = sheet.getRange('I2').getValue(); // master meter row
    const acctLr = lr - 3;                        // last actual account row
    if (!fr || !lr) continue;

    const names  = sheet.getRange('A' + fr + ':A' + acctLr).getValues();
    const starts = sheet.getRange('B' + fr + ':B' + acctLr).getValues();
    const ends   = sheet.getRange('C' + fr + ':C' + acctLr).getValues();

    const readings = names.map((r, i) => ({
      accountId:    nameToId[String(r[0]).trim()] ?? (i + 1),
      startReading: starts[i][0] !== '' ? Number(starts[i][0]) : null,
      endReading:   ends[i][0]   !== '' ? Number(ends[i][0])   : null,
    }));

    const mStart = sheet.getRange('B' + lr).getValue();
    const mEnd   = sheet.getRange('C' + lr).getValue();
    const masterReading = {
      startReading: mStart !== '' ? Number(mStart) : null,
      endReading:   mEnd   !== '' ? Number(mEnd)   : null,
      endReadingAt: null,
    };

    periods.push({
      name:                Utilities.formatDate(endVal, tz, 'MMM yyyy'),
      startDate:           toDateStr(startVal),
      endDate:             toDateStr(endVal),
      rateTableSnapshot:   JSON.parse(JSON.stringify(rateTable)),
      accountsSnapshot:    JSON.parse(JSON.stringify(accounts)),
      readings,
      masterReading,
      normalizationFactor: null,
    });
  }

  // Write to Drive and show download link
  const backup = {
    version: 1,
    exportedAt: new Date().toISOString(),
    rateTable,
    lockStartReadings: true,
    accounts,
    masterMeter,
    periods,
  };

  const today    = Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd');
  const fileName = 'water-billing-export-' + today + '.json';
  const file     = DriveApp.createFile(fileName,
                     JSON.stringify(backup, null, 2), MimeType.PLAIN_TEXT);

  const html = HtmlService.createHtmlOutput(
    '<p style="font-family:sans-serif;margin:12px 0">Exported <b>' + periods.length +
    ' periods</b>, <b>' + accounts.length + ' accounts</b>.</p>' +
    '<p><a href="' + file.getDownloadUrl() + '" target="_blank" ' +
    'style="font-size:14px">⬇ Download ' + fileName + '</a></p>' +
    '<p style="font-size:11px;color:#888">Also saved to your Google Drive root.</p>'
  ).setWidth(440).setHeight(130);

  SpreadsheetApp.getUi().showModalDialog(html, 'PWA Export Ready');
}


function onEdit(e) {
  const ss = e.source;
  const ref = e.range.getA1Notation();

  if (ref !== "A18" && ref !== "A20") return;

  e.range.uncheck();
  ss.getActiveSheet().setActiveSelection('M37');

  if (ref == "A18") {
    newMonth();
  } else {
    prorateBilling();
  }
}

