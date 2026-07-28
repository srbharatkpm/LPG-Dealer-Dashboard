// Main dashboard — one screen tying the whole ERP together.
// Read-only; all figures come from what the other pages have saved.

let ratesCache = {};

async function loadRatesOnce() {
  if (Object.keys(ratesCache).length) return;
  const rows = await lpgCloud.select("product_rates");
  rows.forEach((r) => (ratesCache[r.product] = num(r.rate)));
}

function salesValue(rows) {
  let total = 0;
  rows.forEach((r) => {
    const rate = ratesCache[r.product] != null ? ratesCache[r.product] : (r.product === "14.2 Kg Domestic" ? 890 : 0);
    total += num(r.qty) * rate;
  });
  return total;
}

function dateOffset(dateStr, days) {
  const d = new Date(dateStr + "T00:00:00");
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

function shortDay(dateStr) {
  const d = new Date(dateStr + "T00:00:00");
  return d.toLocaleDateString("en-IN", { day: "numeric", month: "short" });
}

async function loadDashboard() {
  const date = document.getElementById("entryDate").value;
  const mStart = monthStart(date);
  const weekStart = dateOffset(date, -6);
  await loadRatesOnce();

  const [
    sales, debitsRows, manualRows, weekSales, mSales, trips,
    bookings, attendance, monthlyTarget, customers, txns, vehicles, stock,
  ] = await Promise.all([
    lpgCloud.select("godown_vehicle_sales", { eq: { entry_date: date } }),
    lpgCloud.select("godown_debits", { eq: { entry_date: date } }),
    lpgCloud.select("accounts_daily", { eq: { entry_date: date } }),
    lpgCloud.select("godown_vehicle_sales", { gte: { entry_date: weekStart }, lte: { entry_date: date } }),
    lpgCloud.select("godown_vehicle_sales", { gte: { entry_date: mStart }, lte: { entry_date: date } }),
    lpgCloud.select("delivery_trips", { eq: { trip_date: date } }),
    lpgCloud.select("bookings", { eq: { booking_date: date } }),
    lpgCloud.select("staff_attendance", { eq: { entry_date: date } }),
    lpgCloud.select("sales_targets", { eq: { period_type: "monthly", period_start: mStart } }),
    lpgCloud.select("credit_customers"),
    lpgCloud.select("credit_transactions"),
    lpgCloud.select("vehicles"),
    lpgCloud.select("godown_stock", { eq: { entry_date: date } }),
  ]);

  // --- today tiles ---
  const debits = debitsRows[0] || {};
  const manual = manualRows[0] || {};
  const credit = salesValue(sales);
  const expenses =
    num(debits.diesel_expenses) + num(debits.refill_commission) + num(debits.local_expenses) +
    num(debits.vehicle_expenses) + num(manual.salary_advance) + num(manual.admin_other_purchase) +
    num(manual.other_expenses);
  const online = num(debits.online_payment) + num(debits.gpay_payment);
  const balance = num(manual.opening_amount) + credit - expenses - online - num(manual.bank_deposit);

  document.getElementById("kSales").textContent = fmt(credit);
  document.getElementById("kExpenses").textContent = fmt(expenses);
  document.getElementById("kBalance").textContent = fmt(balance);

  let deliveredToday = 0;
  for (const t of trips) {
    const entries = await lpgCloud.select("delivery_entries", { eq: { trip_id: t.id }, columns: "delivered_qty" });
    deliveredToday += entries.reduce((s, e) => s + num(e.delivered_qty), 0);
  }
  document.getElementById("kDelivered").textContent = qty(deliveredToday);
  document.getElementById("kPending").textContent =
    bookings.filter((b) => b.status === "booked" || b.status === "assigned").length;

  const balancesByCustomer = {};
  txns.forEach((t) => {
    balancesByCustomer[t.customer_id] =
      (balancesByCustomer[t.customer_id] || 0) + (t.type === "sale" ? 1 : -1) * num(t.amount);
  });
  const outstanding = Object.values(balancesByCustomer).reduce((s, b) => s + Math.max(0, b), 0);
  document.getElementById("kOutstanding").textContent = fmt(outstanding);

  // --- 7-day trend ---
  const byDay = {};
  for (let i = 0; i < 7; i++) byDay[dateOffset(date, i - 6)] = 0;
  weekSales.forEach((r) => {
    if (r.entry_date in byDay) {
      const rate = ratesCache[r.product] != null ? ratesCache[r.product] : (r.product === "14.2 Kg Domestic" ? 890 : 0);
      byDay[r.entry_date] += num(r.qty) * rate;
    }
  });
  const days = Object.keys(byDay).sort();
  const max = Math.max(1, ...days.map((d) => byDay[d]));
  const peakDay = days.reduce((a, b) => (byDay[b] > byDay[a] ? b : a), days[0]);

  document.getElementById("trendBars").innerHTML = days
    .map((d) => {
      const h = Math.round((byDay[d] / max) * 100);
      return (
        '<div class="bcol' + (d === peakDay && byDay[d] > 0 ? " peak" : "") + '" title="' +
        shortDay(d) + ": " + fmt(byDay[d]) + '">' +
        '<span class="bval">' + Math.round(byDay[d]).toLocaleString("en-IN") + "</span>" +
        '<div class="bar" style="height:' + h + '%"></div></div>'
      );
    })
    .join("");
  document.getElementById("trendLabels").innerHTML =
    days.map((d) => "<span>" + shortDay(d) + "</span>").join("");
  document.getElementById("trendTable").innerHTML = days
    .map((d) => "<tr><td>" + d + "</td><td>" + fmt(byDay[d]) + "</td></tr>")
    .join("");

  // --- month tiles ---
  const mtd = salesValue(mSales);
  document.getElementById("kMtd").textContent = fmt(mtd);
  const target = monthlyTarget[0] ? num(monthlyTarget[0].target_amount) : 0;
  document.getElementById("kTarget").textContent = target ? fmt(target) : "—";
  document.getElementById("kProgress").textContent = target ? Math.round((mtd / target) * 100) + "%" : "—";
  document.getElementById("kPresent").textContent = attendance.length
    ? attendance.filter((a) => a.status === "present").length + " / " + attendance.length
    : "—";

  // --- alerts ---
  const alerts = [];
  const soon = dateOffset(todayStr(), 30);
  vehicles.forEach((v) => {
    [["Insurance", v.insurance_expiry], ["FC", v.fc_expiry], ["Permit", v.permit_expiry]].forEach(([label, d]) => {
      if (d && d <= soon) {
        alerts.push({
          bad: d < todayStr(),
          text: v.vehicle_number + " — " + label + (d < todayStr() ? " EXPIRED on " : " expires ") + d,
        });
      }
    });
  });
  stock
    .filter((s) => s.condition === "full" && num(s.quantity) === 0)
    .forEach((s) => alerts.push({ bad: true, text: "No FULL stock recorded for " + s.product }));
  const pendingCount = bookings.filter((b) => b.status === "booked").length;
  if (pendingCount) alerts.push({ bad: false, text: pendingCount + " booking(s) not yet assigned to a driver" });
  if (outstanding > 0) alerts.push({ bad: false, text: "Credit customers owe " + fmt(outstanding) + " in total" });

  document.getElementById("alertsList").innerHTML = alerts.length
    ? alerts
        .map((a) => '<div class="msg ' + (a.bad ? "error" : "ok") + '">' + escapeHtml(a.text) + "</div>")
        .join("")
    : '<p style="font-size:13px;color:var(--muted);">Nothing needs attention right now.</p>';
}

initDashboard({
  current: "dashboard.html",
  roles: ["owner", "manager", "accounts"],
  load: loadDashboard,
});
