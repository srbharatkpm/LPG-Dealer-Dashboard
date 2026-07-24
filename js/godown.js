const STOCK_PRODUCTS = [
  "14.2 Kg Cylinder",
  "19 Kg Cylinder",
  "5 Kg Cylinder",
  "BMCG Cylinder",
  "DPR",
  "Hose",
  "Lighter",
  "Book",
  "Stove",
];

let profile = null;

const msg = document.getElementById("msg");
function showMsg(text, kind) {
  msg.textContent = text;
  msg.className = "msg " + kind;
}
function hideMsg() {
  msg.className = "msg hidden";
}
function num(v) {
  const n = Number(v);
  return Number.isNaN(n) ? 0 : n;
}
function escapeHtml(s) {
  if (s === null || s === undefined) return "";
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

document.getElementById("signOutBtn").addEventListener("click", async () => {
  await lpgCloud.signOut();
  window.location.href = "index.html";
});

document.querySelectorAll(".tabs button").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tabs button").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    document.querySelectorAll(".tab-panel").forEach((p) => (p.style.display = "none"));
    document.getElementById("panel-" + btn.dataset.tab).style.display = "";
  });
});

function currentDate() {
  return document.getElementById("entryDate").value;
}

// ---------- Stock ----------
function renderStockRows() {
  const body = document.getElementById("stockBody");
  body.innerHTML = "";
  STOCK_PRODUCTS.forEach((p) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${p}</td>
      <td><input type="number" step="1" data-product="${p}" data-field="total_upload" value="0" /></td>
      <td><input type="number" step="1" data-product="${p}" data-field="sv_load" value="0" /></td>
      <td><input type="number" step="1" data-product="${p}" data-field="sv_empty" value="0" /></td>
      <td><input type="number" step="1" data-product="${p}" data-field="return_load" value="0" /></td>
      <td><input type="number" step="1" data-product="${p}" data-field="return_empty" value="0" /></td>
      <td><input type="number" step="1" data-product="${p}" data-field="delivered_load" value="0" /></td>
    `;
    body.appendChild(tr);
  });
}

async function loadStock() {
  const rows = await lpgCloud.select("godown_stock", { eq: { entry_date: currentDate() } });
  const byProduct = {};
  rows.forEach((r) => (byProduct[r.product] = r));
  STOCK_PRODUCTS.forEach((p) => {
    const r = byProduct[p];
    ["total_upload", "sv_load", "sv_empty", "return_load", "return_empty", "delivered_load"].forEach((f) => {
      const input = document.querySelector(`#stockBody input[data-product="${p}"][data-field="${f}"]`);
      input.value = r ? r[f] : 0;
    });
  });
}

document.getElementById("stockSaveBtn").addEventListener("click", async () => {
  hideMsg();
  try {
    const rows = STOCK_PRODUCTS.map((p) => {
      const row = { entry_date: currentDate(), product: p, created_by: profile.id };
      ["total_upload", "sv_load", "sv_empty", "return_load", "return_empty", "delivered_load"].forEach((f) => {
        row[f] = num(document.querySelector(`#stockBody input[data-product="${p}"][data-field="${f}"]`).value);
      });
      return row;
    });
    await lpgCloud.upsert("godown_stock", rows, "entry_date,product");
    showMsg("Stock saved.", "ok");
  } catch (err) {
    showMsg(err.message || "Could not save stock.", "error");
  }
});

// ---------- Vehicle Sales ----------
document.getElementById("salesForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  hideMsg();
  try {
    const row = {
      entry_date: currentDate(),
      vehicle_number: document.getElementById("svVehicle").value.trim(),
      product: document.getElementById("svProduct").value,
      qty: num(document.getElementById("svQty").value),
      created_by: profile.id,
    };
    await lpgCloud.upsert("godown_vehicle_sales", [row], "entry_date,vehicle_number,product");
    document.getElementById("salesForm").reset();
    await loadSales();
  } catch (err) {
    showMsg(err.message || "Could not save sale.", "error");
  }
});

async function loadSales() {
  const rows = await lpgCloud.select("godown_vehicle_sales", { eq: { entry_date: currentDate() } });
  const body = document.getElementById("salesBody");
  body.innerHTML = "";
  rows.forEach((r) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${escapeHtml(r.vehicle_number)}</td>
      <td>${escapeHtml(r.product)}</td>
      <td>${r.qty}</td>
      <td><button class="btn small danger" data-id="${r.id}">Delete</button></td>
    `;
    body.appendChild(tr);
  });
  body.querySelectorAll("button[data-id]").forEach((b) => {
    b.addEventListener("click", async () => {
      const sb = lpgCloud.client();
      await sb.from("godown_vehicle_sales").delete().eq("id", b.getAttribute("data-id"));
      await loadSales();
    });
  });
}

// ---------- Debits ----------
const debitFieldMap = {
  dDiesel: "diesel_expenses",
  dRefill: "refill_commission",
  dOnline: "online_payment",
  dGpay: "gpay_payment",
  dLocal: "local_expenses",
  dVehicle: "vehicle_expenses",
};

function recomputeDebitTotal() {
  let total = 0;
  Object.keys(debitFieldMap).forEach((id) => (total += num(document.getElementById(id).value)));
  document.getElementById("dTotal").textContent = "₹" + total.toFixed(2);
}
Object.keys(debitFieldMap).forEach((id) =>
  document.getElementById(id).addEventListener("input", recomputeDebitTotal)
);

async function loadDebits() {
  const rows = await lpgCloud.select("godown_debits", { eq: { entry_date: currentDate() } });
  const r = rows[0];
  Object.entries(debitFieldMap).forEach(([id, field]) => {
    document.getElementById(id).value = r ? r[field] : 0;
  });
  recomputeDebitTotal();
}

document.getElementById("debitsForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  hideMsg();
  try {
    const row = { entry_date: currentDate(), created_by: profile.id };
    Object.entries(debitFieldMap).forEach(([id, field]) => (row[field] = num(document.getElementById(id).value)));
    await lpgCloud.upsert("godown_debits", [row], "entry_date");
    showMsg("Debits saved.", "ok");
  } catch (err) {
    showMsg(err.message || "Could not save debits.", "error");
  }
});

// ---------- Cash Count ----------
const denomMap = { n500: 500, n200: 200, n100: 100, n50: 50, n20: 20, n10: 10, c10: 10, c5: 5, c2: 2, c1: 1 };
const denomFieldMap = {
  n500: "note_500", n200: "note_200", n100: "note_100", n50: "note_50", n20: "note_20", n10: "note_10",
  c10: "coin_10", c5: "coin_5", c2: "coin_2", c1: "coin_1",
};

function recomputeCashTotal() {
  let total = 0;
  Object.entries(denomMap).forEach(([id, val]) => (total += num(document.getElementById(id).value) * val));
  document.getElementById("cashTotal").textContent = "₹" + total.toFixed(2);
}
Object.keys(denomMap).forEach((id) => document.getElementById(id).addEventListener("input", recomputeCashTotal));

async function loadCash() {
  const rows = await lpgCloud.select("godown_cash_count", { eq: { entry_date: currentDate() } });
  const r = rows[0];
  Object.entries(denomFieldMap).forEach(([id, field]) => {
    document.getElementById(id).value = r ? r[field] : 0;
  });
  document.getElementById("signGodown").value = r ? r.godown_incharge_name || "" : "";
  document.getElementById("signCash").value = r ? r.cash_confirmed_by || "" : "";
  document.getElementById("signDriver").value = r ? r.driver_sign || "" : "";
  recomputeCashTotal();
}

document.getElementById("cashForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  hideMsg();
  try {
    const row = {
      entry_date: currentDate(),
      created_by: profile.id,
      godown_incharge_name: document.getElementById("signGodown").value.trim(),
      cash_confirmed_by: document.getElementById("signCash").value.trim(),
      driver_sign: document.getElementById("signDriver").value.trim(),
    };
    Object.entries(denomFieldMap).forEach(([id, field]) => (row[field] = num(document.getElementById(id).value)));
    await lpgCloud.upsert("godown_cash_count", [row], "entry_date");
    showMsg("Cash count saved.", "ok");
  } catch (err) {
    showMsg(err.message || "Could not save cash count.", "error");
  }
});

// ---------- init ----------
async function loadAllForDate() {
  await Promise.all([loadStock(), loadSales(), loadDebits(), loadCash()]);
}

document.getElementById("entryDate").addEventListener("change", () => {
  loadAllForDate().catch((e) => showMsg(e.message, "error"));
});

(async () => {
  try {
    profile = await lpgCloud.requireRole("godown");
    if (!profile) return;
    document.getElementById("whoName").textContent = profile.full_name + " (Godown Incharge)";
    document.getElementById("entryDate").value = new Date().toISOString().slice(0, 10);
    renderStockRows();
    await loadAllForDate();
  } catch (err) {
    showMsg(err.message || "Failed to load.", "error");
  }
})();
