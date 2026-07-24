let profile = null;
let ratesCache = {}; // product -> rate

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
function fmt(n) {
  return "₹" + Number(n || 0).toFixed(2);
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

// ---------- Vehicle sales + rates ----------
async function loadRates() {
  const rows = await lpgCloud.select("product_rates");
  ratesCache = {};
  rows.forEach((r) => (ratesCache[r.product] = Number(r.rate)));
}

async function loadSalesAndRates() {
  const sales = await lpgCloud.select("godown_vehicle_sales", { eq: { entry_date: currentDate() } });

  const rawBody = document.getElementById("rawSalesBody");
  rawBody.innerHTML = "";
  sales.forEach((r) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td>${escapeHtml(r.vehicle_number)}</td><td>${escapeHtml(r.product)}</td><td>${r.qty}</td>`;
    rawBody.appendChild(tr);
  });

  const totalsByProduct = {};
  sales.forEach((r) => {
    totalsByProduct[r.product] = (totalsByProduct[r.product] || 0) + Number(r.qty || 0);
  });
  // include known rate-list products even with zero qty so the office can set rates ahead of time
  const knownProducts = [
    "14.2 Kg", "19 Kg", "5 Kg BMCG", "Stove", "Hose", "Lighter", "DPR", "NC", "Additional Cylinder", "Book",
  ];
  knownProducts.forEach((p) => {
    if (!(p in totalsByProduct)) totalsByProduct[p] = 0;
  });

  const body = document.getElementById("ratesBody");
  body.innerHTML = "";
  let totalCredit = 0;
  Object.entries(totalsByProduct).forEach(([product, qty]) => {
    const rate = ratesCache[product] != null ? ratesCache[product] : (product === "14.2 Kg" ? 890 : 0);
    const amount = qty * rate;
    totalCredit += amount;
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${escapeHtml(product)}</td>
      <td>${qty}</td>
      <td><input type="number" step="0.01" data-product="${product}" class="rateInput" value="${rate}" /></td>
      <td class="amountCell">${fmt(amount)}</td>
    `;
    body.appendChild(tr);
  });

  body.querySelectorAll(".rateInput").forEach((inp) => {
    inp.addEventListener("input", recomputeCreditFromTable);
  });

  document.getElementById("sumCredit").textContent = fmt(totalCredit);
  return totalCredit;
}

function recomputeCreditFromTable() {
  let total = 0;
  document.querySelectorAll("#ratesBody tr").forEach((tr) => {
    const qty = num(tr.children[1].textContent);
    const rate = num(tr.querySelector(".rateInput").value);
    const amount = qty * rate;
    tr.querySelector(".amountCell").textContent = fmt(amount);
    total += amount;
  });
  document.getElementById("sumCredit").textContent = fmt(total);
  recomputeBalance();
  return total;
}

document.getElementById("ratesSaveBtn").addEventListener("click", async () => {
  hideMsg();
  try {
    const rows = [];
    document.querySelectorAll("#ratesBody .rateInput").forEach((inp) => {
      rows.push({ product: inp.dataset.product, rate: num(inp.value) });
    });
    await lpgCloud.upsert("product_rates", rows, "product");
    await loadRates();
    showMsg("Rates saved.", "ok");
  } catch (err) {
    showMsg(err.message || "Could not save rates.", "error");
  }
});

// ---------- Delivery trips ----------
async function loadTrips() {
  const trips = await lpgCloud.select("delivery_trips", { eq: { trip_date: currentDate() } });
  const body = document.getElementById("tripsBody");
  body.innerHTML = "";
  let total = 0;
  for (const t of trips) {
    const entries = await lpgCloud.select("delivery_entries", { eq: { trip_id: t.id } });
    const amt = entries.reduce((s, e) => s + Number(e.amount || 0), 0);
    total += amt;
    const km = t.starting_kms != null && t.ending_kms != null ? `${t.starting_kms} → ${t.ending_kms}` : "-";
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${escapeHtml(t.driver_name)}</td>
      <td>${escapeHtml(t.vehicle_number)}</td>
      <td>${escapeHtml(t.line)}</td>
      <td>${km}</td>
      <td>${entries.length}</td>
      <td>${fmt(amt)}</td>
    `;
    body.appendChild(tr);
  }
  document.getElementById("deliveryTotal").textContent = fmt(total);
}

// ---------- Godown debits (reference) ----------
let godownDebits = { diesel_expenses: 0, refill_commission: 0, online_payment: 0, gpay_payment: 0, local_expenses: 0, vehicle_expenses: 0 };

async function loadGodownDebits() {
  const rows = await lpgCloud.select("godown_debits", { eq: { entry_date: currentDate() } });
  godownDebits = rows[0] || { diesel_expenses: 0, refill_commission: 0, online_payment: 0, gpay_payment: 0, local_expenses: 0, vehicle_expenses: 0 };
  document.getElementById("gDiesel").textContent = fmt(godownDebits.diesel_expenses);
  document.getElementById("gRefill").textContent = fmt(godownDebits.refill_commission);
  document.getElementById("gLocal").textContent = fmt(godownDebits.local_expenses);
  document.getElementById("gVehicle").textContent = fmt(godownDebits.vehicle_expenses);
  document.getElementById("gOnline").textContent = fmt(godownDebits.online_payment);
  document.getElementById("gGpay").textContent = fmt(godownDebits.gpay_payment);
}

async function loadGodownCash() {
  const rows = await lpgCloud.select("godown_cash_count", { eq: { entry_date: currentDate() } });
  const r = rows[0];
  if (!r) {
    document.getElementById("sumCounted").textContent = fmt(0);
    return 0;
  }
  const total =
    500 * r.note_500 + 200 * r.note_200 + 100 * r.note_100 + 50 * r.note_50 + 20 * r.note_20 + 10 * r.note_10 +
    10 * r.coin_10 + 5 * r.coin_5 + 2 * r.coin_2 + 1 * r.coin_1;
  document.getElementById("sumCounted").textContent = fmt(total);
  return total;
}

// ---------- Manual office entries ----------
let accountsDaily = null;

async function loadManual() {
  const rows = await lpgCloud.select("accounts_daily", { eq: { entry_date: currentDate() } });
  accountsDaily = rows[0] || null;
  document.getElementById("mOpening").value = accountsDaily ? accountsDaily.opening_amount : 0;
  document.getElementById("mSalary").value = accountsDaily ? accountsDaily.salary_advance : 0;
  document.getElementById("mAdmin").value = accountsDaily ? accountsDaily.admin_other_purchase : 0;
  document.getElementById("mOther").value = accountsDaily ? accountsDaily.other_expenses : 0;
  document.getElementById("mBank").value = accountsDaily ? accountsDaily.bank_deposit : 0;
  document.getElementById("mNotes").value = accountsDaily ? accountsDaily.notes || "" : "";
}

document.getElementById("manualForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  hideMsg();
  try {
    const row = {
      entry_date: currentDate(),
      opening_amount: num(document.getElementById("mOpening").value),
      salary_advance: num(document.getElementById("mSalary").value),
      admin_other_purchase: num(document.getElementById("mAdmin").value),
      other_expenses: num(document.getElementById("mOther").value),
      bank_deposit: num(document.getElementById("mBank").value),
      notes: document.getElementById("mNotes").value.trim(),
      created_by: profile.id,
      updated_at: new Date().toISOString(),
    };
    await lpgCloud.upsert("accounts_daily", [row], "entry_date");
    await loadManual();
    recomputeBalance();
    showMsg("Office entries saved.", "ok");
  } catch (err) {
    showMsg(err.message || "Could not save.", "error");
  }
});
["mOpening", "mSalary", "mAdmin", "mOther", "mBank"].forEach((id) =>
  document.getElementById(id).addEventListener("input", recomputeBalance)
);

// ---------- Balance ----------
let lastCounted = 0;

function recomputeBalance() {
  const credit = num(document.getElementById("sumCredit").textContent.replace(/[₹,]/g, ""));
  const debit =
    num(godownDebits.diesel_expenses) + num(godownDebits.refill_commission) +
    num(godownDebits.local_expenses) + num(godownDebits.vehicle_expenses) +
    num(document.getElementById("mSalary").value) + num(document.getElementById("mAdmin").value) +
    num(document.getElementById("mOther").value);
  const onlineGpay = num(godownDebits.online_payment) + num(godownDebits.gpay_payment);
  const bankDeposit = num(document.getElementById("mBank").value);
  const opening = num(document.getElementById("mOpening").value);
  const balance = opening + credit - debit - onlineGpay - bankDeposit;

  document.getElementById("sumDebit").textContent = fmt(debit);
  document.getElementById("sumOnlineGpay").textContent = fmt(onlineGpay);
  document.getElementById("sumBankDeposit").textContent = fmt(bankDeposit);
  document.getElementById("sumBalance").textContent = fmt(balance);

  const mismatchEl = document.getElementById("mismatchMsg");
  const diff = Math.round((balance - lastCounted) * 100) / 100;
  if (Math.abs(diff) > 0.5) {
    mismatchEl.className = "msg error";
    mismatchEl.textContent = `Balance (${fmt(balance)}) does not match cash counted by Godown (${fmt(lastCounted)}) — difference ${fmt(diff)}.`;
  } else {
    mismatchEl.className = "msg ok";
    mismatchEl.textContent = `Balance matches cash counted by Godown.`;
  }
}

// ---------- init ----------
async function loadAllForDate() {
  await loadRates();
  await loadSalesAndRates();
  await loadTrips();
  await loadGodownDebits();
  lastCounted = await loadGodownCash();
  await loadManual();
  recomputeBalance();
}

document.getElementById("entryDate").addEventListener("change", () => {
  loadAllForDate().catch((e) => showMsg(e.message, "error"));
});

(async () => {
  try {
    profile = await lpgCloud.requireRole("accounts");
    if (!profile) return;
    document.getElementById("whoName").textContent = profile.full_name + " (Accounts)";
    document.getElementById("entryDate").value = new Date().toISOString().slice(0, 10);
    await loadAllForDate();
  } catch (err) {
    showMsg(err.message || "Failed to load.", "error");
  }
})();
