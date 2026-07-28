let profile = null;
let ratesCache = {}; // product -> rate
let customersCache = [];

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
function moneyText(el) {
  return num(el.textContent.replace(/[₹,]/g, ""));
}
function escapeHtml(s) {
  if (s === null || s === undefined) return "";
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function roleLabel(role) {
  return { owner: "Owner", manager: "Manager", accounts: "Accounts", staff: "Staff", driver: "Driver", pending: "Pending" }[role] || role;
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

function monthRange(dateStr) {
  const d = new Date(dateStr + "T00:00:00");
  const start = new Date(d.getFullYear(), d.getMonth(), 1).toISOString().slice(0, 10);
  return { start, end: dateStr };
}

// ---------- Vehicle sales + rates ----------
async function loadRates() {
  const rows = await lpgCloud.select("product_rates");
  ratesCache = {};
  rows.forEach((r) => (ratesCache[r.product] = Number(r.rate)));
}

const KNOWN_PRODUCTS = [
  "14.2 Kg Domestic", "19 Kg Commercial", "5 Kg BMCG", "DPR (Regulator)",
  "Hose", "Lighter", "Stove", "Book", "NC", "Additional Cylinder",
];

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
  KNOWN_PRODUCTS.forEach((p) => {
    if (!(p in totalsByProduct)) totalsByProduct[p] = 0;
  });

  const body = document.getElementById("ratesBody");
  body.innerHTML = "";
  let totalCredit = 0;
  Object.entries(totalsByProduct).forEach(([product, qty]) => {
    const rate = ratesCache[product] != null ? ratesCache[product] : (product === "14.2 Kg Domestic" ? 890 : 0);
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
  const credit = moneyText(document.getElementById("sumCredit"));
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

// ---------- Credit Customers ----------
async function loadCustomers() {
  customersCache = await lpgCloud.select("credit_customers", { order: { column: "name", ascending: true } });
  const sel = document.getElementById("txnCustomer");
  sel.innerHTML = customersCache
    .map((c) => `<option value="${c.id}">${escapeHtml(c.name)} (${escapeHtml(c.consumer_no || "-")})</option>`)
    .join("");

  const allTxns = await lpgCloud.select("credit_transactions");
  const balances = {};
  allTxns.forEach((t) => {
    const sign = t.type === "sale" ? 1 : -1;
    balances[t.customer_id] = (balances[t.customer_id] || 0) + sign * Number(t.amount || 0);
  });

  const body = document.getElementById("customersBody");
  body.innerHTML = "";
  customersCache.forEach((c) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${escapeHtml(c.consumer_no)}</td>
      <td>${escapeHtml(c.name)}</td>
      <td>${escapeHtml(c.phone)}</td>
      <td>${fmt(balances[c.id] || 0)}</td>
    `;
    body.appendChild(tr);
  });
}

document.getElementById("customerForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  hideMsg();
  try {
    await lpgCloud.insert("credit_customers", [
      {
        consumer_no: document.getElementById("ccConsumerNo").value.trim(),
        name: document.getElementById("ccName").value.trim(),
        phone: document.getElementById("ccPhone").value.trim(),
        address: document.getElementById("ccAddress").value.trim(),
        created_by: profile.id,
      },
    ]);
    document.getElementById("customerForm").reset();
    await loadCustomers();
    showMsg("Customer added.", "ok");
  } catch (err) {
    showMsg(err.message || "Could not add customer.", "error");
  }
});

document.getElementById("creditTxnForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  hideMsg();
  try {
    await lpgCloud.insert("credit_transactions", [
      {
        customer_id: document.getElementById("txnCustomer").value,
        entry_date: document.getElementById("txnDate").value,
        type: document.getElementById("txnType").value,
        product: document.getElementById("txnProduct").value.trim(),
        qty: num(document.getElementById("txnQty").value) || null,
        amount: num(document.getElementById("txnAmount").value),
        notes: document.getElementById("txnNotes").value.trim(),
        created_by: profile.id,
      },
    ]);
    document.getElementById("creditTxnForm").reset();
    document.getElementById("txnDate").value = currentDate();
    await loadCustomers();
    showMsg("Transaction recorded.", "ok");
  } catch (err) {
    showMsg(err.message || "Could not record transaction.", "error");
  }
});

// ---------- Targets (Owner/Manager) ----------
async function monthlyRevenueAndExpenses(dateStr) {
  const { start, end } = monthRange(dateStr);
  const sales = await lpgCloud.select("godown_vehicle_sales", { gte: { entry_date: start }, lte: { entry_date: end } });
  let revenue = 0;
  sales.forEach((r) => {
    const rate = ratesCache[r.product] != null ? ratesCache[r.product] : 0;
    revenue += Number(r.qty || 0) * rate;
  });
  const debits = await lpgCloud.select("godown_debits", { gte: { entry_date: start }, lte: { entry_date: end } });
  let expenses = 0;
  debits.forEach((r) => {
    expenses += num(r.diesel_expenses) + num(r.refill_commission) + num(r.local_expenses) + num(r.vehicle_expenses);
  });
  const manuals = await lpgCloud.select("accounts_daily", { gte: { entry_date: start }, lte: { entry_date: end } });
  manuals.forEach((r) => {
    expenses += num(r.salary_advance) + num(r.admin_other_purchase) + num(r.other_expenses);
  });
  return { revenue, expenses };
}

async function loadTargets() {
  const daily = await lpgCloud.select("sales_targets", { eq: { period_type: "daily", period_start: currentDate() } });
  document.getElementById("targetDaily").value = daily[0] ? daily[0].target_amount : 0;
  const { start } = monthRange(currentDate());
  const monthly = await lpgCloud.select("sales_targets", { eq: { period_type: "monthly", period_start: start } });
  document.getElementById("targetMonthly").value = monthly[0] ? monthly[0].target_amount : 0;

  document.getElementById("targetDailyActual").textContent = document.getElementById("sumCredit").textContent;
  const { revenue } = await monthlyRevenueAndExpenses(currentDate());
  document.getElementById("targetMonthlyActual").textContent = fmt(revenue);
}

document.getElementById("targetSaveBtn").addEventListener("click", async () => {
  hideMsg();
  try {
    const { start } = monthRange(currentDate());
    await lpgCloud.upsert(
      "sales_targets",
      [{ period_type: "daily", period_start: currentDate(), target_amount: num(document.getElementById("targetDaily").value), created_by: profile.id }],
      "period_type,period_start"
    );
    await lpgCloud.upsert(
      "sales_targets",
      [{ period_type: "monthly", period_start: start, target_amount: num(document.getElementById("targetMonthly").value), created_by: profile.id }],
      "period_type,period_start"
    );
    showMsg("Targets saved.", "ok");
  } catch (err) {
    showMsg(err.message || "Could not save targets.", "error");
  }
});

// ---------- Profit & Loss (Owner only) ----------
async function loadPL() {
  const revenue = moneyText(document.getElementById("sumCredit"));
  const expenses = moneyText(document.getElementById("sumDebit"));
  document.getElementById("plRevenue").textContent = fmt(revenue);
  document.getElementById("plExpenses").textContent = fmt(expenses);
  document.getElementById("plToday").textContent = fmt(revenue - expenses);

  const { revenue: mRevenue, expenses: mExpenses } = await monthlyRevenueAndExpenses(currentDate());
  document.getElementById("plMonthRevenue").textContent = fmt(mRevenue);
  document.getElementById("plMonthExpenses").textContent = fmt(mExpenses);
  document.getElementById("plMonth").textContent = fmt(mRevenue - mExpenses);
}

// ---------- Team (Owner only) ----------
async function loadTeam() {
  const rows = await lpgCloud.select("profiles", { order: { column: "full_name", ascending: true } });
  const body = document.getElementById("teamBody");
  body.innerHTML = "";
  rows.forEach((r) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${escapeHtml(r.full_name)}</td>
      <td>${escapeHtml(r.phone)}</td>
      <td>${escapeHtml(r.vehicle_number)} ${escapeHtml(r.line)}</td>
      <td>
        <select data-id="${r.id}" class="roleSelect">
          <option value="pending" ${r.role === "pending" ? "selected" : ""}>Pending — no access</option>
          <option value="owner" ${r.role === "owner" ? "selected" : ""}>Owner</option>
          <option value="manager" ${r.role === "manager" ? "selected" : ""}>Manager</option>
          <option value="accounts" ${r.role === "accounts" ? "selected" : ""}>Accounts</option>
          <option value="staff" ${r.role === "staff" ? "selected" : ""}>Staff</option>
          <option value="driver" ${r.role === "driver" ? "selected" : ""}>Delivery Boy</option>
        </select>
      </td>
      <td><button class="btn small" data-save="${r.id}">Save</button></td>
    `;
    body.appendChild(tr);
  });
  body.querySelectorAll("button[data-save]").forEach((b) => {
    b.addEventListener("click", async () => {
      const id = b.getAttribute("data-save");
      const sel = body.querySelector(`select[data-id="${id}"]`);
      try {
        await lpgCloud.update("profiles", id, { role: sel.value });
        showMsg("Role updated.", "ok");
      } catch (err) {
        showMsg(err.message || "Could not update role.", "error");
      }
    });
  });
}

// ---------- Create a staff login (owner only) ----------
document.getElementById("createUserForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const out = document.getElementById("cuMsg");
  const btn = document.getElementById("cuBtn");
  out.className = "msg hidden";
  btn.disabled = true;
  try {
    const mobile = document.getElementById("cuMobile").value.replace(/\D/g, "").slice(-10);
    if (mobile.length !== 10) throw new Error("Mobile number must be 10 digits.");
    const password = document.getElementById("cuPassword").value;

    await lpgCloud.callFunction("create-team-user", {
      full_name: document.getElementById("cuName").value.trim(),
      mobile,
      role: document.getElementById("cuRole").value,
      password,
      vehicle_number: document.getElementById("cuVehicle").value.trim(),
      line: document.getElementById("cuLine").value.trim(),
    });

    out.className = "msg ok";
    out.textContent = `Login created. Tell them: mobile ${mobile}, password ${password}.`;
    document.getElementById("createUserForm").reset();
    document.getElementById("cuPassword").value = "lpg@1234";
    await loadTeam();
  } catch (err) {
    out.className = "msg error";
    out.textContent = err.message || "Could not create the login.";
  } finally {
    btn.disabled = false;
  }
});

// ---------- Role-based visibility ----------
// Owner and Manager both get the full set of tabs. What still separates
// them is enforced in the database, not here: only the owner can touch
// the owner account itself, and the owner role is pinned to one email.
function applyRoleVisibility(role) {
  const full = role === "owner" || role === "manager";
  ["tabTargets", "tabBroadcast", "tabPL", "tabTeam"].forEach((id) => {
    document.getElementById(id).style.display = full ? "" : "none";
  });
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
  await loadCustomers();
  if (profile.role === "owner" || profile.role === "manager") {
    await loadTargets();
    await loadBroadcastTab();
    await loadPL();
    await loadTeam();
  }
}

document.getElementById("entryDate").addEventListener("change", () => {
  document.getElementById("txnDate").value = currentDate();
  loadAllForDate().catch((e) => showMsg(e.message, "error"));
});

(async () => {
  try {
    profile = await lpgCloud.requireRole(["owner", "manager", "accounts"]);
    if (!profile) return;
    document.getElementById("whoName").textContent = profile.full_name + " (" + roleLabel(profile.role) + ")";
    applyRoleVisibility(profile.role);
    document.getElementById("entryDate").value = new Date().toISOString().slice(0, 10);
    document.getElementById("txnDate").value = currentDate();
    await loadAllForDate();
  } catch (err) {
    showMsg(err.message || "Failed to load.", "error");
  }
})();
