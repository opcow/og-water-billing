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

// normalizes the bill for a 30 day period in case of a late reading
function normalizeBilling() {
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

function onEdit(e) {
  const ss = e.source;
  const ref = e.range.getA1Notation();

  if (ref !== "A18" && ref !== "A20") return;

  e.range.uncheck();
  ss.getActiveSheet().setActiveSelection('M37');

  if (ref == "A18") {
    newMonth();
  } else {
    normalizeBilling();
  }
}

