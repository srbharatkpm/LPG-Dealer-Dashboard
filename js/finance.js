// Accounts dashboard — read-only daily and month-to-date financial view.
// Entry happens on accounts.html (Ledger Entry); this page only reports.

let ratesCache = {};

async function loadRatesOnce() {
  if (Object.keys(ratesCache).length) return;
  const rows = await lpgCloud.select("product_rates");
  rows.forEach((r) => (ratesCache[r.product] = num(r.rate)));
}

function salesValue(salesRows) {
  let total = 0;
  salesRows.forEach((r) => {
    const rate = ratesCache[r.product] != null ? ratesCache[r.product] : (r.product === "14.2 Kg Domestic" ? 890 : 0);
    total += num(r.qty) * rate;
  });
  return total;
}

function cashCountTotal(r) {
  if (!r) return 0;
  return (
    500 * num(r.note_500) + 200 * num(r.note_200) + 100 * num(r.note_100) +
    50 * num(r.note_50) + 20 * num(r.note_20) + 10 * num(r.note_10) +
    10 * num(r.coin_10) + 5 * num(r.coin_5) + 2 * num(r.coin_2) + 1 * num(r.coin_1)
  );
}

async function loadFinanceDash() {
  const date = document.getElementById("entryDate").value;
  const mStart = monthStart(date);
  await loadRatesOnce();

  const [sales, debitsRows, manualRows, cashRows, mSales, mDebits, mManual, customers, txns] =
    await Promise.all([
      lpgCloud.select("godown_vehicle_sales", { eq: { entry_date: date } }),
      lpgCloud.select("godown_debits", { eq: { entry_date: date } }),
      lpgCloud.select("accounts_daily", { eq: { entry_date: date } }),
      lpgCloud.select("godown_cash_count", { eq: { entry_date: date } }),
      lpgCloud.select("godown_vehicle_sales", { gte: { entry_date: mStart }, lte: { entry_date: date } }),
      lpgCloud.select("godown_debits", { gte: { entry_date: mStart }, lte: { entry_date: date } }),
      lpgCloud.select("accounts_daily", { gte: { entry_date: mStart }, lte: { entry_date: date } }),
      lpgCloud.select("credit_customers"),
      lpgCloud.select("credit_transactions"),
    ]);

  const debits = debitsRows[0] || {};
  const manual = manualRows[0] || {};

  const credit = salesValue(sales);
  const expenseParts = {
    diesel: num(debits.diesel_expenses),
    refill: num(debits.refill_commission),
    local: num(debits.local_expenses),
    vehicle: num(debits.vehicle_expenses),
    salary: num(manual.salary_advance),
    admin: num(manual.admin_other_purchase) + num(manual.other_expenses),
  };
  const debit = Object.values(expenseParts).reduce((a, b) => a + b, 0);
  const online = num(debits.online_payment) + num(debits.gpay_payment);
  const bank = num(manual.bank_deposit);
  const opening = num(manual.opening_amount);
  const balance = opening + credit - debit - online - bank;
  const counted = cashCountTotal(cashRows[0]);

  document.getElementById("dCredit").textContent = fmt(credit);
  document.getElementById("dDebit").textContent = fmt(debit);
  document.getElementById("dOnline").textContent = fmt(online);
  document.getElementById("dBank").textContent = fmt(bank);
  document.getElementById("dBalance").textContent = fmt(balance);
  document.getElementById("dCounted").textContent = fmt(counted);

  const tally = document.getElementById("tallyMsg");
  const diff = Math.round((balance - counted) * 100) / 100;
  if (Math.abs(diff) > 0.5) {
    tally.className = "msg error";
    tally.textContent = `Balance (${fmt(balance)}) differs from cash counted (${fmt(counted)}) by ${fmt(diff)}.`;
  } else {
    tally.className = "msg ok";
    tally.textContent = "Balance matches the cash counted at the godown.";
  }

  document.getElementById("xDiesel").textContent = fmt(expenseParts.diesel);
  document.getElementById("xRefill").textContent = fmt(expenseParts.refill);
  document.getElementById("xLocal").textContent = fmt(expenseParts.local);
  document.getElementById("xVehicle").textContent = fmt(expenseParts.vehicle);
  document.getElementById("xSalary").textContent = fmt(expenseParts.salary);
  document.getElementById("xAdmin").textContent = fmt(expenseParts.admin);

  // month-to-date
  const mRevenue = salesValue(mSales);
  let mExpense = 0;
  mDebits.forEach((r) => {
    mExpense += num(r.diesel_expenses) + num(r.refill_commission) + num(r.local_expenses) + num(r.vehicle_expenses);
  });
  mManual.forEach((r) => {
    mExpense += num(r.salary_advance) + num(r.admin_other_purchase) + num(r.other_expenses);
  });
  document.getElementById("mRevenue").textContent = fmt(mRevenue);
  document.getElementById("mExpenses").textContent = fmt(mExpense);
  document.getElementById("mNet").textContent = fmt(mRevenue - mExpense);

  // credit outstanding
  const balances = {};
  txns.forEach((t) => {
    balances[t.customer_id] = (balances[t.customer_id] || 0) + (t.type === "sale" ? 1 : -1) * num(t.amount);
  });
  const body = document.getElementById("creditBody");
  body.innerHTML = "";
  let outstanding = 0;
  customers
    .map((c) => ({ c, bal: balances[c.id] || 0 }))
    .filter((x) => Math.abs(x.bal) > 0.005)
    .sort((a, b) => b.bal - a.bal)
    .forEach(({ c, bal }) => {
      outstanding += bal;
      const tr = document.createElement("tr");
      tr.innerHTML =
        "<td>" + escapeHtml(c.consumer_no) + "</td><td>" + escapeHtml(c.name) +
        "</td><td>" + escapeHtml(c.phone) + "</td><td>" + fmt(bal) + "</td>";
      body.appendChild(tr);
    });
  document.getElementById("creditTotal").textContent = fmt(outstanding);
}

initDashboard({
  current: "finance.html",
  roles: ["owner", "manager", "accounts"],
  load: loadFinanceDash,
});
