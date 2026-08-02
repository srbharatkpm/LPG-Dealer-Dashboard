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
    driverSheets, leaderboard,
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
    lpgCloud.select("driver_sheets", { eq: { sheet_date: date }, columns: "id, status, submitted" }),
    lpgCloud.rpc("driver_leaderboard", { p_start: mStart, p_end: date }).catch(() => []),
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

  // --- stock snapshot (composite view) ---
  const stockByKey = {};
  stock.forEach((r) => (stockByKey[r.product + "|" + r.condition] = num(r.quantity)));
  const snapshotSpec = [
    ["14.2 Kg Full", "14.2 Kg Domestic|full", "credit"],
    ["14.2 Kg Empty", "14.2 Kg Domestic|empty", ""],
    ["19 Kg Full", "19 Kg Commercial|full", "credit"],
    ["5 Kg BMCG Full", "5 Kg BMCG|full", ""],
    ["DPR Sound", "DPR (Regulator)|sound", ""],
    ["DPR Defective", "DPR (Regulator)|defective", "debit"],
  ];
  document.getElementById("stockSnapshot").innerHTML = snapshotSpec
    .map(
      ([label, key, cls]) =>
        '<div class="tile ' + cls + '"><div class="label">' + label + '</div><div class="value">' +
        qty(stockByKey[key] || 0) + "</div></div>"
    )
    .join("");

  // --- drivers (composite view) ---
  const statusOf = (s) => s.status || (s.submitted ? "submitted" : "draft");
  document.getElementById("drvSubmitted").textContent =
    driverSheets.filter((s) => statusOf(s) !== "draft").length;
  document.getElementById("drvApproved").textContent =
    driverSheets.filter((s) => statusOf(s) === "approved").length;
  document.getElementById("drvPending").textContent =
    driverSheets.filter((s) => statusOf(s) === "submitted").length;

  const board = (leaderboard || []).slice().sort((a, b) => num(b.delivered) - num(a.delivered));
  document.getElementById("drvLeaderBody").innerHTML = board.length
    ? board
        .map((r, i) => {
          const medal = i === 0 ? "🥇 " : i === 1 ? "🥈 " : i === 2 ? "🥉 " : "";
          return (
            "<tr><td>" + medal + "#" + (i + 1) + "</td><td>" + escapeHtml(r.driver_name) +
            "</td><td>" + qty(num(r.delivered)) + "</td></tr>"
          );
        })
        .join("")
    : '<tr><td colspan="3" style="color:var(--muted);">No driver sheets this month yet.</td></tr>';

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
  if (!attendance.length) alerts.push({ bad: true, text: "Attendance not marked yet today (Operations → Attendance)" });
  if (outstanding > 0) alerts.push({ bad: false, text: "Credit customers owe " + fmt(outstanding) + " in total" });

  document.getElementById("alertsList").innerHTML = alerts.length
    ? alerts
        .map((a) => '<div class="msg ' + (a.bad ? "error" : "ok") + '">' + escapeHtml(a.text) + "</div>")
        .join("")
    : '<p style="font-size:13px;color:var(--muted);">Nothing needs attention right now.</p>';
}

// ---------- Daily registers & day-end checklist ----------
// Everything the manager/owner must confirm daily before day end.
// item_key is stored; labels are display-only.
const CHECKLIST_GROUPS = [
  ["Registers", [
    ["stock", "Stock Registers"],
    ["dpr", "DPR Register"],
    ["defective_dpr", "Defective DPR Register"],
    ["sv_tv", "SV / TV Register"],
    ["complaint", "Complaint Register"],
    ["pdi", "PDI Register"],
    ["sqc", "SQC Register"],
  ]],
  ["Day-End Confirmations", [
    ["attendance_marked", "Attendance marked for all staff"],
    ["stock_tallied", "Godown stock tallied with physical count"],
    ["commercial_invoice", "19 Kg commercial cylinder — invoice taken"],
    ["registers_confirmed", "Register update confirmation done"],
  ]],
];
const REGISTERS = CHECKLIST_GROUPS.flatMap(([, items]) => items);

let dashProfile = null;
let teamNames = {};

async function loadRegisterChecklist() {
  const date = document.getElementById("entryDate").value;
  const [rows, team] = await Promise.all([
    lpgCloud.select("register_checklist", { eq: { entry_date: date } }),
    lpgCloud.select("profiles", { columns: "id, full_name" }),
  ]);
  teamNames = {};
  team.forEach((p) => (teamNames[p.id] = p.full_name));
  const byKey = {};
  rows.forEach((r) => (byKey[r.item_key] = r));

  const body = document.getElementById("registerBody");
  body.innerHTML = CHECKLIST_GROUPS.map(([groupLabel, items]) => {
    const header =
      '<tr><td colspan="4" style="background:#eef3f8;font-weight:700;color:var(--blue-dark);font-size:12px;">' +
      escapeHtml(groupLabel) + "</td></tr>";
    const rows = items.map(([key, label]) => {
      const r = byKey[key];
      const done = r && r.checked;
      return (
        "<tr><td style='text-align:center;'>" +
        '<input type="checkbox" data-reg="' + key + '"' + (done ? " checked" : "") + " /></td>" +
        "<td" + (done ? "" : ' style="font-weight:600;"') + ">" + escapeHtml(label) + "</td>" +
        "<td>" + (done ? escapeHtml(teamNames[r.checked_by] || "—") : "—") + "</td>" +
        "<td>" + (done && r.checked_at ? new Date(r.checked_at).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" }) : "—") + "</td></tr>"
      );
    }).join("");
    return header + rows;
  }).join("");

  body.querySelectorAll("input[data-reg]").forEach((cb) =>
    cb.addEventListener("change", async () => {
      try {
        await lpgCloud.upsert(
          "register_checklist",
          [
            {
              entry_date: date,
              item_key: cb.dataset.reg,
              checked: cb.checked,
              checked_by: cb.checked ? dashProfile.id : null,
              checked_at: cb.checked ? new Date().toISOString() : null,
            },
          ],
          "entry_date,item_key"
        );
        await loadRegisterChecklist();
      } catch (err) {
        const msg = document.getElementById("msg");
        msg.className = "msg error";
        msg.textContent = err.message || "Could not save the tick.";
      }
    })
  );

  const doneCount = REGISTERS.filter(([k]) => byKey[k] && byKey[k].checked).length;
  const prog = document.getElementById("regProgress");
  prog.textContent = doneCount + " / " + REGISTERS.length;
  prog.className = "pill " + (doneCount === REGISTERS.length ? "green" : "amber");

  const warn = document.getElementById("regWarn");
  if (doneCount === REGISTERS.length) {
    warn.className = "msg ok";
    warn.textContent = "Checklist complete for the day.";
  } else {
    const missing = REGISTERS.filter(([k]) => !(byKey[k] && byKey[k].checked)).map(([, l]) => l);
    warn.className = "msg error";
    warn.textContent =
      "Pending before day end: " +
      missing.slice(0, 4).join(", ") +
      (missing.length > 4 ? " + " + (missing.length - 4) + " more" : "");
  }
}

// ---------- Overall (from–to) sales & purchases ----------
// Sales come from every driver sheet's sale items plus office counter
// sales; purchases from plant runs. All product spellings collapse
// into buckets via dsProductBucket().
const OV_BUCKETS = ["14.2 Kg", "19 Kg", "5 Kg BMCG", "FTL", "DPR", "Hose", "Book", "Lighter", "Stove", "Other"];

async function loadOverall() {
  const from = document.getElementById("ovFrom").value || "2000-01-01";
  const to = document.getElementById("ovTo").value || todayStr();

  const [sheets, officeSales, purchases] = await Promise.all([
    lpgCloud.selectAll("driver_sheets", { columns: "sheet_date, data" }).then(
      (rows) => rows.filter((r) => r.sheet_date >= from && r.sheet_date <= to)
    ),
    lpgCloud.selectAll("office_sales").then(
      (rows) => rows.filter((r) => r.entry_date >= from && r.entry_date <= to)
    ),
    lpgCloud.selectAll("plant_purchases").then(
      (rows) => rows.filter((r) => r.purchase_date >= from && r.purchase_date <= to)
    ),
  ]);

  const agg = {};
  OV_BUCKETS.forEach((b) => (agg[b] = { soldQty: 0, soldVal: 0, purQty: 0, purVal: 0 }));
  const bucketOf = (name) => agg[dsProductBucket(name)] || agg.Other;

  sheets.forEach((s) => {
    const parts = dsSaleBreakdown(s.data || {});
    Object.entries(parts).forEach(([item, p]) => {
      const b = bucketOf(item);
      b.soldQty += p.qty;
      b.soldVal += p.amount;
    });
  });
  officeSales.forEach((r) => {
    const b = bucketOf(r.product);
    b.soldQty += num(r.qty);
    b.soldVal += num(r.qty) * num(r.rate);
  });
  purchases.forEach((r) => {
    const b = bucketOf(r.product);
    b.purQty += num(r.qty_received);
    b.purVal += num(r.amount);
  });

  let sQty = 0, sVal = 0, pQty = 0, pVal = 0;
  document.getElementById("ovBreakdownBody").innerHTML = OV_BUCKETS
    .filter((bkt) => {
      const b = agg[bkt];
      return b.soldQty || b.soldVal || b.purQty || b.purVal;
    })
    .map((bkt) => {
      const b = agg[bkt];
      sQty += b.soldQty; sVal += b.soldVal; pQty += b.purQty; pVal += b.purVal;
      return (
        "<tr><td>" + bkt + "</td><td>" + qty(b.soldQty) + "</td><td>" + fmt(b.soldVal) +
        "</td><td>" + qty(b.purQty) + "</td><td>" + fmt(b.purVal) + "</td></tr>"
      );
    })
    .join("") || '<tr><td colspan="5" style="color:var(--muted);">No records in this period.</td></tr>';

  document.getElementById("ovSalesValue").textContent = fmt(sVal);
  document.getElementById("ovSalesQty").textContent = qty(sQty);
  document.getElementById("ovPurchValue").textContent = fmt(pVal);
  document.getElementById("ovPurchQty").textContent = qty(pQty);
}

["ovFrom", "ovTo"].forEach((id) =>
  document.getElementById(id).addEventListener("change", () =>
    loadOverall().catch((e) => showDashMsg(e.message))
  )
);
function showDashMsg(text) {
  const msg = document.getElementById("msg");
  msg.className = "msg error";
  msg.textContent = text;
}
document.getElementById("ovPresetAll").addEventListener("click", () => {
  document.getElementById("ovFrom").value = "";
  document.getElementById("ovTo").value = todayStr();
  loadOverall().catch((e) => showDashMsg(e.message));
});
document.getElementById("ovPresetMonth").addEventListener("click", () => {
  document.getElementById("ovFrom").value = monthStart(todayStr());
  document.getElementById("ovTo").value = todayStr();
  loadOverall().catch((e) => showDashMsg(e.message));
});
document.getElementById("ovPresetToday").addEventListener("click", () => {
  document.getElementById("ovFrom").value = todayStr();
  document.getElementById("ovTo").value = todayStr();
  loadOverall().catch((e) => showDashMsg(e.message));
});

initDashboard({
  current: "dashboard.html",
  roles: ["owner", "manager", "accounts"],
  load: async (profile) => {
    dashProfile = profile;
    document.getElementById("ovTo").value = todayStr();
    await loadDashboard();
    await loadRegisterChecklist();
    await loadOverall();
  },
});
