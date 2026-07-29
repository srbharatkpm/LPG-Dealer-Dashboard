// Day Sheet — a 1:1 digital version of the office's Excel/paper daily
// account sheet. One JSONB document per date (day_sheets table).
// Every figure recomputes live, and the balance waterfall is cross-
// checked against the denomination count exactly like the green cell
// on their Excel.

let dsProfile = null;

// The default driver list mirrors their sheet; rows can be added freely.
const DRIVERS = ["Office", "Ramesh", "Velkumar", "Prakash", "Anbu", "Manimaran", "Manikandan"];

const BASE_RATE = 980; // office MRP for 14.2kg; delivery charge = (MRP − base) × no's

// column spec per section: inputs + computed columns
const SECTIONS = {
  domestic: {
    title: "14.2 Kg Cylinder Sale — Domestic",
    cols: [
      { key: "driver", label: "Driver", type: "text" },
      { key: "line", label: "Line", type: "text" },
      { key: "nos", label: "No's", type: "num" },
      { key: "mrp", label: "MRP", type: "num" },
    ],
    computed: [
      { label: "Amount", fn: (r) => num(r.nos) * num(r.mrp) },
      { label: "Delivery Chg", fn: (r) => num(r.nos) * Math.max(0, num(r.mrp) - BASE_RATE) },
    ],
    totalFn: (r) => num(r.nos) * num(r.mrp),
    defaults: DRIVERS.map((d) => ({ driver: d, line: "", nos: 0, mrp: 0 })),
  },
  commercial: {
    title: "19 Kg Cylinder Sale — Commercial",
    cols: [
      { key: "label", label: "Party / Driver", type: "text" },
      { key: "nos", label: "No's", type: "num" },
      { key: "rate", label: "Rate", type: "num" },
    ],
    computed: [{ label: "Amount", fn: (r) => num(r.nos) * num(r.rate) }],
    totalFn: (r) => num(r.nos) * num(r.rate),
    defaults: [{ label: "", nos: 0, rate: 0 }],
  },
  nc: {
    title: "NC & Old Ujjwala",
    cols: [
      { key: "label", label: "By", type: "text" },
      { key: "nos", label: "No's", type: "num" },
      { key: "rate", label: "Rate", type: "num" },
    ],
    computed: [{ label: "Amount", fn: (r) => num(r.nos) * num(r.rate) }],
    totalFn: (r) => num(r.nos) * num(r.rate),
    defaults: [{ label: "", nos: 0, rate: 4500 }],
  },
  additional: {
    title: "Additional Cylinder",
    cols: [
      { key: "label", label: "By", type: "text" },
      { key: "nos", label: "No's", type: "num" },
      { key: "rate", label: "Rate", type: "num" },
    ],
    computed: [{ label: "Amount", fn: (r) => num(r.nos) * num(r.rate) }],
    totalFn: (r) => num(r.nos) * num(r.rate),
    defaults: [{ label: "", nos: 0, rate: 3500 }],
  },
  other_sales: {
    title: "Other Sales (5kg / DPR / Hose / Lighter / Book / Stove)",
    cols: [
      { key: "label", label: "Item", type: "text" },
      { key: "nos", label: "No's", type: "num" },
      { key: "rate", label: "Rate", type: "num" },
    ],
    computed: [{ label: "Amount", fn: (r) => num(r.nos) * num(r.rate) }],
    totalFn: (r) => num(r.nos) * num(r.rate),
    defaults: [{ label: "", nos: 0, rate: 0 }],
  },

  diesel: debitSec("Diesel Expenses", DRIVERS.slice(1).map((d) => "Diesel - " + d)),
  refill_commission: debitSec("Refill Commission", DRIVERS.slice(1).map((d) => "Commission - " + d)),
  local: debitSec("Local Expenses", []),
  salary: debitSec("Salary & Advance", []),
  vehicle: debitSec("Vehicle Expenses", []),
  admin: debitSec("Other Purchase (Admin)", []),
  other_exp: debitSec("Other Expenses", []),

  online: {
    title: "Online, G-Pay & Amazon Payment",
    cols: [
      { key: "label", label: "Office / Driver", type: "text" },
      { key: "online", label: "Online", type: "num" },
      { key: "amazon", label: "Amazon", type: "num" },
      { key: "gpay", label: "G-Pay", type: "num" },
    ],
    computed: [{ label: "Total", fn: (r) => num(r.online) + num(r.amazon) + num(r.gpay) }],
    totalFn: (r) => num(r.online) + num(r.amazon) + num(r.gpay),
    defaults: DRIVERS.map((d) => ({ label: d, online: 0, amazon: 0, gpay: 0 })),
  },
};

function debitSec(title, labels) {
  return {
    title,
    cols: [
      { key: "label", label: "Detail", type: "text" },
      { key: "amount", label: "Amount", type: "num" },
    ],
    computed: [],
    totalFn: (r) => num(r.amount),
    defaults: (labels.length ? labels : [""]).map((l) => ({ label: l, amount: 0 })),
  };
}

const CREDIT_SECS = ["domestic", "commercial", "nc", "additional", "other_sales"];
const DEBIT_SECS = ["diesel", "refill_commission", "local", "salary", "vehicle", "admin", "other_exp"];

const DENOMS = [
  ["n500", 500, "₹500"], ["n200", 200, "₹200"], ["n100", 100, "₹100"],
  ["n50", 50, "₹50"], ["n20", 20, "₹20"], ["n10", 10, "₹10"],
  ["c10", 10, "10 Coin"], ["c5", 5, "5 Coin"], ["c2", 2, "2 Coin"], ["c1", 1, "1 Coin"],
];

let state = { sections: {}, denoms: {}, waterfall: {} };

function freshState() {
  const s = { sections: {}, denoms: {}, waterfall: { opening: 0, bank: 0, handover: 0 } };
  Object.keys(SECTIONS).forEach((k) => {
    s.sections[k] = SECTIONS[k].defaults.map((r) => Object.assign({}, r));
  });
  DENOMS.forEach(([k]) => (s.denoms[k] = 0));
  return s;
}

// ---------- rendering ----------
function renderSection(key) {
  const spec = SECTIONS[key];
  const host = document.querySelector('[data-sec="' + key + '"]');
  const rows = state.sections[key];

  const head =
    "<tr>" +
    spec.cols.map((c) => "<th>" + c.label + "</th>").join("") +
    spec.computed.map((c) => '<th class="amt">' + c.label + "</th>").join("") +
    "<th></th></tr>";

  const body = rows
    .map((row, i) => {
      const inputs = spec.cols
        .map(
          (c) =>
            "<td><input type=" +
            (c.type === "num" ? '"number" step="0.01"' : '"text"') +
            ' data-sec="' + key + '" data-idx="' + i + '" data-key="' + c.key + '" value="' +
            escapeHtml(row[c.key] ?? (c.type === "num" ? 0 : "")) + '" /></td>'
        )
        .join("");
      const computed = spec.computed
        .map((c) => '<td class="amt">' + fmtN(c.fn(row)) + "</td>")
        .join("");
      return (
        "<tr>" + inputs + computed +
        '<td><button class="btn small danger no-print" data-drop="' + key + ":" + i + '">×</button></td></tr>'
      );
    })
    .join("");

  const total = rows.reduce((s, r) => s + spec.totalFn(r), 0);
  const totalRow =
    '<tr class="tot"><td colspan="' + spec.cols.length + '">Total</td><td class="amt" colspan="' +
    (spec.computed.length || 1) + '">' + fmtN(total) + "</td><td></td></tr>";

  host.innerHTML =
    "<h4>" + spec.title + "</h4>" +
    '<div class="table-wrap"><table><thead>' + head + "</thead><tbody>" + body + totalRow + "</tbody></table></div>" +
    '<button class="btn small secondary addrow no-print" data-add="' + key + '">+ Row</button>';

  host.querySelectorAll("input[data-sec]").forEach((inp) =>
    inp.addEventListener("input", () => {
      const { sec, idx, key: k } = inp.dataset;
      state.sections[sec][Number(idx)][k] = inp.type === "number" ? num(inp.value) : inp.value;
      softRefresh(sec);
    })
  );
  host.querySelector("[data-add]").addEventListener("click", () => {
    const blank = {};
    spec.cols.forEach((c) => (blank[c.key] = c.type === "num" ? 0 : ""));
    rows.push(blank);
    renderSection(key);
    recompute();
  });
  host.querySelectorAll("[data-drop]").forEach((btn) =>
    btn.addEventListener("click", () => {
      const [sec, idx] = btn.dataset.drop.split(":");
      state.sections[sec].splice(Number(idx), 1);
      renderSection(sec);
      recompute();
    })
  );
}

// refresh a section's computed cells without rebuilding inputs (keeps focus)
function softRefresh(key) {
  const spec = SECTIONS[key];
  const host = document.querySelector('[data-sec="' + key + '"]');
  const rows = state.sections[key];
  host.querySelectorAll("tbody tr").forEach((tr, i) => {
    if (i >= rows.length) return; // total row
    const cells = tr.querySelectorAll("td.amt");
    spec.computed.forEach((c, ci) => {
      if (cells[ci]) cells[ci].textContent = fmtN(c.fn(rows[i]));
    });
  });
  const total = rows.reduce((s, r) => s + spec.totalFn(r), 0);
  const totCell = host.querySelector("tr.tot td.amt");
  if (totCell) totCell.textContent = fmtN(total);
  recompute();
}

function renderDenoms() {
  const tbody = document.querySelector("#denomTable tbody");
  tbody.innerHTML = DENOMS.map(
    ([k, v, label]) =>
      "<tr><td>" + label + ' ×</td><td><input type="number" min="0" data-denom="' + k + '" value="' +
      (state.denoms[k] || 0) + '" /></td><td class="amt" data-denom-amt="' + k + '">' +
      fmtN((state.denoms[k] || 0) * v) + "</td></tr>"
  ).join("");
  tbody.querySelectorAll("input[data-denom]").forEach((inp) =>
    inp.addEventListener("input", () => {
      state.denoms[inp.dataset.denom] = num(inp.value);
      const v = DENOMS.find(([k]) => k === inp.dataset.denom)[1];
      tbody.querySelector('[data-denom-amt="' + inp.dataset.denom + '"]').textContent =
        fmtN(num(inp.value) * v);
      recompute();
    })
  );
}

function fmtN(n) {
  return Number(n || 0).toLocaleString("en-IN");
}

function secTotal(keys) {
  return keys.reduce(
    (sum, k) => sum + state.sections[k].reduce((s, r) => s + SECTIONS[k].totalFn(r), 0),
    0
  );
}

function recompute() {
  // manual credit sections PLUS the approved driver sheets' sales
  const credit = secTotal(CREDIT_SECS) + approvedSaleTotal;
  const debit = secTotal(DEBIT_SECS);
  const online = secTotal(["online"]);
  const counted = DENOMS.reduce((s, [k, v]) => s + (state.denoms[k] || 0) * v, 0);

  state.waterfall.opening = num(document.getElementById("wOpening").value);
  state.waterfall.bank = num(document.getElementById("wBank").value);
  state.waterfall.handover = num(document.getElementById("wHandOver").value);

  const balance =
    state.waterfall.opening + credit - debit - online - state.waterfall.bank - state.waterfall.handover;

  document.getElementById("totCredit").textContent = fmtN(credit);
  document.getElementById("totDebit").textContent = fmtN(debit);
  document.getElementById("wCredit").textContent = fmtN(credit);
  document.getElementById("wDebit").textContent = fmtN(debit);
  document.getElementById("wOnline").textContent = fmtN(online);
  document.getElementById("wBalance").textContent = fmtN(balance);
  document.getElementById("denomTotal").textContent = fmtN(counted);

  const match = document.getElementById("matchMsg");
  const diff = Math.round((balance - counted) * 100) / 100;
  if (Math.abs(diff) > 0.5) {
    match.className = "msg error";
    match.textContent =
      "Balance In Office (" + fmtN(balance) + ") does NOT match cash counted (" + fmtN(counted) +
      ") — difference " + fmtN(diff) + ".";
  } else {
    match.className = "msg ok";
    match.textContent = "Balance In Office matches the cash denomination count (" + fmtN(counted) + ").";
  }
}

["wOpening", "wBank", "wHandOver"].forEach((id) =>
  document.getElementById(id).addEventListener("input", recompute)
);

// ---------- driver handover (from trip sheets, read-only) ----------
async function loadHandover() {
  const trips = await lpgCloud.select("delivery_trips", {
    eq: { trip_date: document.getElementById("entryDate").value },
  });
  const tbody = document.querySelector("#handoverTable tbody");
  let total = 0;
  tbody.innerHTML =
    trips
      .map((t) => {
        total += num(t.total_paid_to_accounts);
        return "<tr><td>" + escapeHtml(t.driver_name) + '</td><td class="amt">' +
          fmtN(t.total_paid_to_accounts) + "</td></tr>";
      })
      .join("") +
    '<tr class="tot"><td>Total</td><td class="amt">' + fmtN(total) + "</td></tr>";
}

// ---------- driver sheet verification & approval ----------
// Submitted sheets land here automatically; Approve folds their sales
// into this day sheet's Credit (see approvedAgg / recompute).
let approvedAgg = {};      // item -> {qty, amount}, from APPROVED sheets only
let approvedSaleTotal = 0;

function sheetStatusOf(s) {
  return s.status || (s.submitted ? "submitted" : "draft");
}

async function loadDriverSheets() {
  const date = document.getElementById("entryDate").value;
  const sheets = await lpgCloud.select("driver_sheets", { eq: { sheet_date: date } });

  approvedAgg = {};
  approvedSaleTotal = 0;
  sheets.filter((s) => sheetStatusOf(s) === "approved").forEach((s) => {
    const parts = dsSaleBreakdown(s.data || {});
    Object.entries(parts).forEach(([item, p]) => {
      const slot = (approvedAgg[item] = approvedAgg[item] || { qty: 0, amount: 0 });
      slot.qty += p.qty;
      slot.amount += p.amount;
      approvedSaleTotal += p.amount;
    });
  });

  // verification list
  const tbody = document.querySelector("#sheetApprovalTable tbody");
  tbody.innerHTML = sheets.length
    ? sheets
        .map((s) => {
          const t = dsTotals(s.data || {});
          const status = sheetStatusOf(s);
          const label =
            status === "approved" ? '<span class="pill green">approved</span>' :
            status === "submitted" ? '<span class="pill amber">pending</span>' :
            '<span class="pill amber">draft</span>';
          const action =
            status === "approved"
              ? '<button class="btn small secondary" data-reopen="' + s.id + '">Reopen</button>'
              : status === "submitted"
              ? '<button class="btn small" data-approve="' + s.id + '">Approve</button>'
              : "";
          return (
            "<tr><td>" + escapeHtml(s.driver_name || "—") + "</td>" +
            '<td class="amt">' + fmtN(t.sale) + "</td>" +
            '<td class="amt">' + fmtN(t.counted) + "</td>" +
            "<td>" + label + "</td><td>" + action + "</td></tr>"
          );
        })
        .join("")
    : '<tr><td colspan="5" style="color:var(--muted);">No driver sheets for this date.</td></tr>';

  const byId = {};
  sheets.forEach((s) => (byId[s.id] = s));

  // Apply (or reverse) a sheet's deliveries onto that date's godown
  // stock: full down / empty up per delivered cylinder, and so on.
  async function applyStockDelta(sheet, sign) {
    const deltas = dsStockDelta(sheet.data || {}, sign);
    const keys = Object.keys(deltas);
    if (!keys.length) return;
    const existing = await lpgCloud.select("godown_stock", { eq: { entry_date: sheet.sheet_date } });
    const byKey = {};
    existing.forEach((r) => (byKey[r.product + "|" + r.condition] = r));
    const rows = keys.map((k) => {
      const [product, condition] = k.split("|");
      const current = byKey[k] ? num(byKey[k].quantity) : 0;
      return {
        entry_date: sheet.sheet_date,
        product,
        condition,
        quantity: current + deltas[k],
        created_by: dsProfile.id,
      };
    });
    await lpgCloud.upsert("godown_stock", rows, "entry_date,product,condition");
  }

  tbody.querySelectorAll("[data-approve]").forEach((b) =>
    b.addEventListener("click", async () => {
      const sheet = byId[b.dataset.approve];
      try {
        if (!sheet.stock_applied) await applyStockDelta(sheet, +1);
        await lpgCloud.update("driver_sheets", sheet.id, {
          status: "approved",
          approved_by: dsProfile.id,
          approved_at: new Date().toISOString(),
          stock_applied: true,
        });
        await loadDriverSheets();
        recompute();
      } catch (err) {
        document.getElementById("msg").className = "msg error";
        document.getElementById("msg").textContent = err.message || "Could not approve.";
      }
    })
  );
  tbody.querySelectorAll("[data-reopen]").forEach((b) =>
    b.addEventListener("click", async () => {
      const sheet = byId[b.dataset.reopen];
      try {
        if (sheet.stock_applied) await applyStockDelta(sheet, -1);
        await lpgCloud.update("driver_sheets", sheet.id, {
          status: "submitted",
          approved_by: null,
          approved_at: null,
          stock_applied: false,
        });
        await loadDriverSheets();
        recompute();
      } catch (err) {
        document.getElementById("msg").className = "msg error";
        document.getElementById("msg").textContent = err.message || "Could not reopen.";
      }
    })
  );

  // approved-sales breakdown in the Credit column
  const salesBody = document.querySelector("#approvedSalesTable tbody");
  const items = Object.entries(approvedAgg);
  salesBody.innerHTML =
    (items.length
      ? items
          .map(
            ([item, p]) =>
              "<tr><td>" + escapeHtml(item) + "</td><td>" + fmtN(p.qty) +
              '</td><td class="amt">' + fmtN(p.amount) + "</td></tr>"
          )
          .join("")
      : '<tr><td colspan="3" style="color:var(--muted);">No approved sheets yet.</td></tr>') +
    '<tr class="tot"><td colspan="2">Total</td><td class="amt">' + fmtN(approvedSaleTotal) + "</td></tr>";
}

// ---------- load & save ----------
function renderAll() {
  Object.keys(SECTIONS).forEach(renderSection);
  renderDenoms();
  document.getElementById("wOpening").value = state.waterfall.opening || 0;
  document.getElementById("wBank").value = state.waterfall.bank || 0;
  document.getElementById("wHandOver").value = state.waterfall.handover || 0;
  recompute();
}

async function loadSheet() {
  const date = document.getElementById("entryDate").value;
  const rows = await lpgCloud.select("day_sheets", { eq: { entry_date: date } });
  if (rows.length && rows[0].data && rows[0].data.sections) {
    state = rows[0].data;
    // sections added after this sheet was saved still need defaults
    Object.keys(SECTIONS).forEach((k) => {
      if (!state.sections[k]) state.sections[k] = SECTIONS[k].defaults.map((r) => Object.assign({}, r));
    });
    state.denoms = state.denoms || {};
    state.waterfall = state.waterfall || { opening: 0, bank: 0, handover: 0 };
  } else {
    state = freshState();
  }
  renderAll();
  await loadHandover();
  await loadDriverSheets();
  recompute();
}

document.getElementById("saveBtn").addEventListener("click", async () => {
  const msg = document.getElementById("msg");
  try {
    await lpgCloud.upsert(
      "day_sheets",
      [
        {
          entry_date: document.getElementById("entryDate").value,
          data: state,
          created_by: dsProfile.id,
          updated_at: new Date().toISOString(),
        },
      ],
      "entry_date"
    );
    msg.className = "msg ok";
    msg.textContent = "Day sheet saved.";
  } catch (err) {
    msg.className = "msg error";
    msg.textContent = err.message || "Could not save the sheet.";
  }
});

document.getElementById("printBtn").addEventListener("click", () => window.print());

initDashboard({
  current: "daysheet.html",
  roles: ["owner", "manager", "accounts"],
  load: async (profile) => {
    dsProfile = profile;
    await loadSheet();
  },
});
