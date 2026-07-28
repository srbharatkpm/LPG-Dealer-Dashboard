// Driver's daily settlement sheet — digital twin of the printed godown
// page. One document per driver per date (driver_sheets); the driver
// edits through the day and submits when settling with the office.
// Math lives in js/sheetmath.js, shared with the office rollup.

let shProfile = null;
let sheetRow = null; // existing driver_sheets row for the date, if any
let data = dsFreshData();

function showShMsg(text, kind) {
  const msg = document.getElementById("msg");
  msg.textContent = text;
  msg.className = "msg " + kind;
}

function currentDate() {
  return document.getElementById("entryDate").value;
}

// ---------- rendering ----------
function renderStock() {
  document.getElementById("stockBody").innerHTML = DS_STOCK_PRODUCTS.map((p) => {
    const cells = DS_STOCK_COLS.map(
      (c) =>
        '<td><input type="number" step="1" data-stock="' + p + '" data-col="' + c + '" value="' +
        dsNum(data.stock[p][c]) + '" /></td>'
    ).join("");
    return "<tr><td>" + p + "</td>" + cells + "</tr>";
  }).join("");
  document.querySelectorAll("input[data-stock]").forEach((inp) =>
    inp.addEventListener("input", () => {
      data.stock[inp.dataset.stock][inp.dataset.col] = dsNum(inp.value);
      recompute();
    })
  );
}

function renderSale() {
  document.getElementById("saleBody").innerHTML =
    DS_SALE_ITEMS.map((it) => {
      const row = data.sale[it];
      return (
        "<tr><td>" + it + "</td>" +
        '<td><input type="number" step="1" data-sale="' + it + '" data-k="qty" value="' + dsNum(row.qty) + '" /></td>' +
        '<td><input type="number" step="0.01" data-sale="' + it + '" data-k="rate" value="' + dsNum(row.rate) + '" /></td>' +
        '<td class="amt" data-sale-amt="' + it + '">' + fmt(dsNum(row.qty) * dsNum(row.rate)) + "</td></tr>"
      );
    }).join("") +
    '<tr class="tot"><td colspan="3">Total Sale</td><td class="amt" id="saleTotalCell">₹0</td></tr>';
  document.querySelectorAll("input[data-sale]").forEach((inp) =>
    inp.addEventListener("input", () => {
      data.sale[inp.dataset.sale][inp.dataset.k] = dsNum(inp.value);
      const row = data.sale[inp.dataset.sale];
      document.querySelector('[data-sale-amt="' + inp.dataset.sale + '"]').textContent =
        fmt(dsNum(row.qty) * dsNum(row.rate));
      recompute();
    })
  );
}

function renderDebits() {
  document.getElementById("debitBody").innerHTML =
    DS_DEBITS.map(
      ([k, label]) =>
        "<tr><td>" + label + '</td><td><input type="number" step="0.01" data-debit="' + k + '" value="' +
        dsNum(data.debits[k]) + '" /></td></tr>'
    ).join("") +
    '<tr class="tot"><td>Total Debit</td><td class="amt" id="debitTotalCell">₹0</td></tr>';
  document.querySelectorAll("input[data-debit]").forEach((inp) =>
    inp.addEventListener("input", () => {
      data.debits[inp.dataset.debit] = dsNum(inp.value);
      recompute();
    })
  );
}

function renderDenoms() {
  document.getElementById("denomBody").innerHTML = DS_DENOMS.map(
    ([k, v, label]) =>
      "<tr><td>" + label + ' ×</td><td><input type="number" min="0" data-denom="' + k + '" value="' +
      dsNum(data.denoms[k]) + '" /></td><td class="amt" data-denom-amt="' + k + '">' +
      fmt(dsNum(data.denoms[k]) * v) + "</td></tr>"
  ).join("");
  document.querySelectorAll("input[data-denom]").forEach((inp) =>
    inp.addEventListener("input", () => {
      data.denoms[inp.dataset.denom] = dsNum(inp.value);
      const v = DS_DENOMS.find(([k]) => k === inp.dataset.denom)[1];
      document.querySelector('[data-denom-amt="' + inp.dataset.denom + '"]').textContent =
        fmt(dsNum(inp.value) * v);
      recompute();
    })
  );
}

function recompute() {
  const t = dsTotals(data);
  document.getElementById("tSale").textContent = fmt(t.sale);
  document.getElementById("tDebit").textContent = fmt(t.debits);
  document.getElementById("tExpected").textContent = fmt(t.expectedCash);
  document.getElementById("tCounted").textContent = fmt(t.counted);
  const saleCell = document.getElementById("saleTotalCell");
  if (saleCell) saleCell.textContent = fmt(t.sale);
  const debitCell = document.getElementById("debitTotalCell");
  if (debitCell) debitCell.textContent = fmt(t.debits);

  const match = document.getElementById("matchMsg");
  const diff = Math.round((t.expectedCash - t.counted) * 100) / 100;
  if (Math.abs(diff) > 0.5) {
    match.className = "msg error";
    match.textContent =
      "Cash to hand over (" + fmt(t.expectedCash) + ") does not match cash counted (" +
      fmt(t.counted) + ") — difference " + fmt(diff) + ".";
  } else {
    match.className = "msg ok";
    match.textContent = "Cash counted matches the sheet.";
  }
}

function renderAll() {
  document.getElementById("shVehicle").value = data.vehicle || shProfile.vehicle_number || "";
  document.getElementById("shLine").value = data.line || shProfile.line || "";
  renderStock();
  renderSale();
  renderDebits();
  renderDenoms();
  recompute();
  document.getElementById("submitState").textContent =
    sheetRow && sheetRow.submitted ? "submitted" : "not submitted";
  document.getElementById("submitState").className =
    "pill " + (sheetRow && sheetRow.submitted ? "green" : "amber");
}

["shVehicle", "shLine"].forEach((id) =>
  document.getElementById(id).addEventListener("input", () => {
    data.vehicle = document.getElementById("shVehicle").value.trim();
    data.line = document.getElementById("shLine").value.trim();
  })
);

// ---------- load & save ----------
async function loadSheet() {
  const rows = await lpgCloud.select("driver_sheets", {
    eq: { driver_id: shProfile.id, sheet_date: currentDate() },
  });
  sheetRow = rows[0] || null;
  data = sheetRow && sheetRow.data && sheetRow.data.stock ? sheetRow.data : dsFreshData();
  // sheets saved before a product/item was added still need its slots
  const fresh = dsFreshData();
  ["stock", "sale", "debits", "denoms"].forEach((part) => {
    Object.keys(fresh[part]).forEach((k) => {
      if (!(k in data[part])) data[part][k] = fresh[part][k];
    });
  });
  renderAll();
}

async function saveSheet(submit) {
  try {
    data.vehicle = document.getElementById("shVehicle").value.trim();
    data.line = document.getElementById("shLine").value.trim();
    const rows = await lpgCloud.upsert(
      "driver_sheets",
      [
        {
          driver_id: shProfile.id,
          sheet_date: currentDate(),
          driver_name: shProfile.full_name,
          data,
          submitted: submit ? true : sheetRow ? sheetRow.submitted : false,
          updated_at: new Date().toISOString(),
        },
      ],
      "driver_id,sheet_date"
    );
    sheetRow = rows[0] || sheetRow;
    renderAll();
    showShMsg(submit ? "Sheet submitted to the office." : "Sheet saved.", "ok");
  } catch (err) {
    showShMsg(err.message || "Could not save the sheet.", "error");
  }
}

document.getElementById("saveBtn").addEventListener("click", () => saveSheet(false));
document.getElementById("submitBtn").addEventListener("click", () => saveSheet(true));
document.getElementById("printBtn").addEventListener("click", () => window.print());

initDashboard({
  current: "driversheet.html",
  roles: ["driver"],
  load: async (profile) => {
    shProfile = profile;
    await loadSheet();
  },
});
