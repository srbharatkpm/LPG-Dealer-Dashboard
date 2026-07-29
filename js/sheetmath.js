// Shared math for driver daily settlement sheets. Used by the driver's
// own page (js/driversheet.js) AND the office rollup (js/finance.js) so
// both always agree on every total.

const DS_STOCK_PRODUCTS = [
  "14.2 Kg Cylinder", "19 Kg Cylinder", "BMCG Cylinder", "5 Kg Cylinder",
  "DPR", "Hose", "Lighter", "Book", "Stove",
];
const DS_STOCK_COLS = ["upload", "sv_load", "sv_empty", "ret_load", "ret_empty", "delivered"];

// Total Sale items in the paper's own order
const DS_SALE_ITEMS = ["14.2 Kg", "19 Kg", "BMCG", "Stove", "Hose", "Lighter", "DPR", "NC", "Add", "Book"];

const DS_DEBITS = [
  ["diesel", "Diesel Expenses"],
  ["refill", "Refill Commission"],
  ["online", "Online Payment"],
  ["gpay", "G-Pay Payment"],
  ["local", "Local ( )"],
  ["vehicle", "Vehicle Expenses"],
];

const DS_DENOMS = [
  ["n500", 500, "500"], ["n200", 200, "200"], ["n100", 100, "100"],
  ["n50", 50, "50"], ["n20", 20, "20"], ["n10", 10, "10"],
  ["c10", 10, "10 Coin"], ["c5", 5, "5 Coin"], ["c2", 2, "2 Coin"], ["c1", 1, "1 Coin"],
];

function dsNum(v) {
  const n = Number(v);
  return Number.isNaN(n) ? 0 : n;
}

function dsFreshData() {
  const d = { vehicle: "", line: "", stock: {}, sale: {}, debits: {}, denoms: {} };
  DS_STOCK_PRODUCTS.forEach((p) => {
    d.stock[p] = {};
    DS_STOCK_COLS.forEach((c) => (d.stock[p][c] = 0));
  });
  DS_SALE_ITEMS.forEach((it) => (d.sale[it] = { qty: 0, rate: 0 }));
  DS_DEBITS.forEach(([k]) => (d.debits[k] = 0));
  DS_DENOMS.forEach(([k]) => (d.denoms[k] = 0));
  return d;
}

// Totals for one sheet's data document.
function dsTotals(data) {
  const sale = DS_SALE_ITEMS.reduce((s, it) => {
    const row = (data.sale || {})[it] || {};
    return s + dsNum(row.qty) * dsNum(row.rate);
  }, 0);
  const debits = DS_DEBITS.reduce((s, [k]) => s + dsNum((data.debits || {})[k]), 0);
  const counted = DS_DENOMS.reduce((s, [k, v]) => s + dsNum((data.denoms || {})[k]) * v, 0);
  const delivered = DS_STOCK_PRODUCTS.reduce(
    (s, p) => s + dsNum(((data.stock || {})[p] || {}).delivered),
    0
  );
  // On the paper sheet online/gpay sit inside Total Debits, so the cash
  // the driver should physically hand over is sale minus all debits.
  return { sale, debits, counted, delivered, expectedCash: sale - debits };
}

// Stock movement a sheet causes in the godown when APPROVED, as
// {"product|condition": delta}. Swap semantics: every delivered
// cylinder is one FULL out and one EMPTY back in; a sold regulator
// comes out of SOUND stock; accessories just reduce their count.
// sign +1 applies, -1 reverses (Reopen).
const DS_TO_GODOWN = [
  ["14.2 Kg Cylinder", "14.2 Kg Domestic", "cyl"],
  ["19 Kg Cylinder", "19 Kg Commercial", "cyl"],
  ["BMCG Cylinder", "5 Kg BMCG", "cyl"],
  ["5 Kg Cylinder", "5 Kg BMCG", "cyl"],
  ["DPR", "DPR (Regulator)", "dpr"],
  ["Hose", "Hose", "acc"],
  ["Lighter", "Lighter", "acc"],
  ["Book", "Book", "acc"],
  ["Stove", "Stove", "acc"],
];

function dsStockDelta(data, sign) {
  const deltas = {};
  const add = (p, c, d) => {
    if (!d) return;
    const k = p + "|" + c;
    deltas[k] = (deltas[k] || 0) + d;
  };
  DS_TO_GODOWN.forEach(([dsProduct, gProduct, kind]) => {
    const delivered = dsNum(((data.stock || {})[dsProduct] || {}).delivered);
    if (!delivered) return;
    if (kind === "cyl") {
      add(gProduct, "full", -sign * delivered);
      add(gProduct, "empty", sign * delivered);
    } else if (kind === "dpr") {
      add(gProduct, "sound", -sign * delivered);
    } else {
      add(gProduct, "qty", -sign * delivered);
    }
  });
  return deltas;
}

// Per-item {qty, amount} for one sheet — used by the Day Sheet to fold
// APPROVED driver sheets into the day's Total Sales item by item.
function dsSaleBreakdown(data) {
  const out = {};
  DS_SALE_ITEMS.forEach((it) => {
    const row = (data.sale || {})[it] || {};
    const q = dsNum(row.qty);
    if (!q) return;
    out[it] = { qty: q, amount: q * dsNum(row.rate) };
  });
  return out;
}
