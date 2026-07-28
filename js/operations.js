// Operations hub — bookings, fleet, attendance, payroll, driver targets,
// plant purchases, plus an overview that pulls it all together.

let opProfile = null;
let team = [];      // all profiles
let drivers = [];   // role === 'driver'
let payStaff = [];  // everyone except pending

const showOpMsg = (text, kind) => {
  const msg = document.getElementById("msg");
  msg.textContent = text;
  msg.className = "msg " + kind;
};

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

function nameOf(id) {
  const p = team.find((t) => t.id === id);
  return p ? p.full_name : "—";
}

function progressCell(done, target) {
  if (!target) return '<span class="delta flat">no target</span>';
  const pct = Math.round((done / target) * 100);
  const cls = pct >= 100 ? "up" : pct >= 60 ? "flat" : "down";
  return '<span class="delta ' + cls + '">' + pct + "%</span>";
}

// ---------- Bookings ----------
async function loadBookings() {
  const rows = await lpgCloud.select("bookings", {
    eq: { booking_date: currentDate() },
    order: { column: "created_at", ascending: true },
  });
  const body = document.getElementById("bookingsBody");
  body.innerHTML = "";
  rows.forEach((b) => {
    const tr = document.createElement("tr");
    const actions =
      b.status === "delivered" || b.status === "cancelled"
        ? ""
        : '<button class="btn small" data-deliver="' + b.id + '">Delivered</button> ' +
          '<button class="btn small danger" data-cancel="' + b.id + '">Cancel</button>';
    tr.innerHTML =
      "<td>" + escapeHtml(b.consumer_name) + (b.consumer_no ? " (" + escapeHtml(b.consumer_no) + ")" : "") + "</td>" +
      "<td>" + escapeHtml(b.phone) + "</td>" +
      "<td>" + escapeHtml(b.line) + "</td>" +
      "<td>" + escapeHtml(b.product) + "</td>" +
      "<td>" + qty(b.qty) + "</td>" +
      "<td>" + escapeHtml(b.payment_mode) + "</td>" +
      "<td>" + escapeHtml(b.assigned_driver ? nameOf(b.assigned_driver) : "—") + "</td>" +
      "<td>" + escapeHtml(b.status) + "</td>" +
      "<td>" + actions + "</td>";
    body.appendChild(tr);
  });
  body.querySelectorAll("[data-deliver]").forEach((btn) =>
    btn.addEventListener("click", async () => {
      await lpgCloud.update("bookings", btn.dataset.deliver, { status: "delivered", delivered_date: currentDate() });
      await loadBookings();
      await loadOverview();
    })
  );
  body.querySelectorAll("[data-cancel]").forEach((btn) =>
    btn.addEventListener("click", async () => {
      await lpgCloud.update("bookings", btn.dataset.cancel, { status: "cancelled" });
      await loadBookings();
      await loadOverview();
    })
  );
}

document.getElementById("bookingForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  try {
    const driver = document.getElementById("bkDriver").value || null;
    await lpgCloud.insert("bookings", [
      {
        booking_date: currentDate(),
        consumer_no: document.getElementById("bkConsumerNo").value.trim(),
        consumer_name: document.getElementById("bkName").value.trim(),
        phone: document.getElementById("bkPhone").value.trim(),
        line: document.getElementById("bkLine").value.trim(),
        product: document.getElementById("bkProduct").value,
        qty: num(document.getElementById("bkQty").value) || 1,
        payment_mode: document.getElementById("bkPayment").value,
        assigned_driver: driver,
        status: driver ? "assigned" : "booked",
        created_by: opProfile.id,
      },
    ]);
    document.getElementById("bookingForm").reset();
    document.getElementById("bkQty").value = "1";
    await loadBookings();
    await loadOverview();
  } catch (err) {
    showOpMsg(err.message || "Could not add the booking.", "error");
  }
});

// ---------- Vehicles ----------
async function loadVehicles() {
  const rows = await lpgCloud.select("vehicles", { order: { column: "vehicle_number", ascending: true } });
  const body = document.getElementById("vehiclesBody");
  body.innerHTML = "";
  const soon = new Date();
  soon.setDate(soon.getDate() + 30);
  const soonStr = soon.toISOString().slice(0, 10);
  const expCell = (d) => {
    if (!d) return "<td>—</td>";
    const cls = d < todayStr() ? "delta down" : d <= soonStr ? "delta flat" : "";
    return '<td><span class="' + cls + '">' + d + "</span></td>";
  };
  rows.forEach((v) => {
    const tr = document.createElement("tr");
    tr.innerHTML =
      "<td>" + escapeHtml(v.vehicle_number) + "</td>" +
      "<td>" + escapeHtml(v.vehicle_type) + "</td>" +
      "<td>" + escapeHtml(v.make_model) + "</td>" +
      expCell(v.insurance_expiry) + expCell(v.fc_expiry) + expCell(v.permit_expiry) +
      '<td><button class="btn small danger" data-del="' + v.id + '">Remove</button></td>';
    body.appendChild(tr);
  });
  body.querySelectorAll("[data-del]").forEach((btn) =>
    btn.addEventListener("click", async () => {
      await lpgCloud.remove("vehicles", btn.dataset.del);
      await loadVehicles();
    })
  );
  return rows;
}

document.getElementById("vehicleForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  try {
    await lpgCloud.upsert(
      "vehicles",
      [
        {
          vehicle_number: document.getElementById("vhNumber").value.trim().toUpperCase(),
          vehicle_type: document.getElementById("vhType").value,
          make_model: document.getElementById("vhModel").value.trim(),
          insurance_expiry: document.getElementById("vhInsurance").value || null,
          fc_expiry: document.getElementById("vhFc").value || null,
          permit_expiry: document.getElementById("vhPermit").value || null,
          created_by: opProfile.id,
        },
      ],
      "vehicle_number"
    );
    document.getElementById("vehicleForm").reset();
    await loadVehicles();
    await loadOverview();
  } catch (err) {
    showOpMsg(err.message || "Could not save the vehicle.", "error");
  }
});

// ---------- Attendance ----------
async function loadAttendance() {
  const rows = await lpgCloud.select("staff_attendance", { eq: { entry_date: currentDate() } });
  const byStaff = {};
  rows.forEach((r) => (byStaff[r.staff_id] = r));

  const body = document.getElementById("attendanceBody");
  body.innerHTML = "";
  payStaff.forEach((p) => {
    const r = byStaff[p.id];
    const status = r ? r.status : "present";
    const options = ["present", "absent", "half_day", "leave"]
      .map((s) => '<option value="' + s + '"' + (s === status ? " selected" : "") + ">" +
        ({ present: "Present", absent: "Absent", half_day: "Half Day", leave: "Leave" }[s]) + "</option>")
      .join("");
    const tr = document.createElement("tr");
    tr.innerHTML =
      "<td>" + escapeHtml(p.full_name) + "</td>" +
      "<td>" + escapeHtml(p.role) + "</td>" +
      '<td><select data-att="' + p.id + '">' + options + "</select></td>" +
      '<td><input type="text" data-att-note="' + p.id + '" value="' + escapeHtml(r ? r.notes || "" : "") + '" /></td>' +
      "<td></td>";
    body.appendChild(tr);
  });
  updateAttendanceTiles();
  body.querySelectorAll("select[data-att]").forEach((s) => s.addEventListener("change", updateAttendanceTiles));
}

function updateAttendanceTiles() {
  let present = 0, absent = 0, other = 0;
  document.querySelectorAll("select[data-att]").forEach((s) => {
    if (s.value === "present") present++;
    else if (s.value === "absent") absent++;
    else other++;
  });
  document.getElementById("attPresent").textContent = present;
  document.getElementById("attAbsent").textContent = absent;
  document.getElementById("attOther").textContent = other;
}

document.getElementById("attSaveBtn").addEventListener("click", async () => {
  try {
    const rows = [];
    document.querySelectorAll("select[data-att]").forEach((s) => {
      const staffId = s.dataset.att;
      const note = document.querySelector('input[data-att-note="' + staffId + '"]');
      rows.push({
        entry_date: currentDate(),
        staff_id: staffId,
        status: s.value,
        notes: note ? note.value.trim() : "",
        created_by: opProfile.id,
      });
    });
    await lpgCloud.upsert("staff_attendance", rows, "entry_date,staff_id");
    showOpMsg("Attendance saved.", "ok");
    await loadOverview();
  } catch (err) {
    showOpMsg(err.message || "Could not save attendance.", "error");
  }
});

// ---------- Payroll ----------
async function loadPayroll() {
  const mStart = monthStart(currentDate());
  const rows = await lpgCloud.select("payroll_entries", {
    gte: { entry_date: mStart },
    lte: { entry_date: currentDate() },
    order: { column: "entry_date", ascending: false },
  });

  const sums = {};
  rows.forEach((r) => {
    const s = (sums[r.staff_id] = sums[r.staff_id] || { salary: 0, advance: 0, bonus: 0, deduction: 0 });
    s[r.type] += num(r.amount);
  });

  const sumBody = document.getElementById("payrollSummaryBody");
  sumBody.innerHTML = "";
  Object.entries(sums).forEach(([staffId, s]) => {
    const net = s.salary + s.bonus - s.advance - s.deduction;
    const tr = document.createElement("tr");
    tr.innerHTML =
      "<td>" + escapeHtml(nameOf(staffId)) + "</td>" +
      "<td>" + fmt(s.salary) + "</td><td>" + fmt(s.advance) + "</td>" +
      "<td>" + fmt(s.bonus) + "</td><td>" + fmt(s.deduction) + "</td>" +
      "<td><strong>" + fmt(net) + "</strong></td>";
    sumBody.appendChild(tr);
  });

  const body = document.getElementById("payrollBody");
  body.innerHTML = "";
  rows.forEach((r) => {
    const tr = document.createElement("tr");
    tr.innerHTML =
      "<td>" + r.entry_date + "</td>" +
      "<td>" + escapeHtml(nameOf(r.staff_id)) + "</td>" +
      "<td>" + escapeHtml(r.type) + "</td>" +
      "<td>" + fmt(r.amount) + "</td>" +
      "<td>" + escapeHtml(r.notes) + "</td>" +
      '<td><button class="btn small danger" data-del="' + r.id + '">Delete</button></td>';
    body.appendChild(tr);
  });
  body.querySelectorAll("[data-del]").forEach((btn) =>
    btn.addEventListener("click", async () => {
      await lpgCloud.remove("payroll_entries", btn.dataset.del);
      await loadPayroll();
    })
  );
}

document.getElementById("payrollForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  try {
    await lpgCloud.insert("payroll_entries", [
      {
        entry_date: currentDate(),
        staff_id: document.getElementById("prStaff").value,
        type: document.getElementById("prType").value,
        amount: num(document.getElementById("prAmount").value),
        notes: document.getElementById("prNotes").value.trim(),
        created_by: opProfile.id,
      },
    ]);
    document.getElementById("payrollForm").reset();
    await loadPayroll();
  } catch (err) {
    showOpMsg(err.message || "Could not record the payment.", "error");
  }
});

// ---------- Driver targets ----------
async function deliveredThisMonthByDriver() {
  const mStart = monthStart(currentDate());
  const trips = await lpgCloud.select("delivery_trips", {
    gte: { trip_date: mStart },
    lte: { trip_date: currentDate() },
  });
  const delivered = {};
  for (const t of trips) {
    const entries = await lpgCloud.select("delivery_entries", { eq: { trip_id: t.id }, columns: "delivered_qty" });
    delivered[t.driver_id] =
      (delivered[t.driver_id] || 0) + entries.reduce((s, e) => s + num(e.delivered_qty), 0);
  }
  return delivered;
}

async function loadTargetsTab() {
  const mStart = monthStart(currentDate());
  const [targets, delivered] = await Promise.all([
    lpgCloud.select("driver_targets", { eq: { month_start: mStart } }),
    deliveredThisMonthByDriver(),
  ]);
  const byDriver = {};
  targets.forEach((t) => (byDriver[t.driver_id] = t));

  const body = document.getElementById("targetsBody");
  body.innerHTML = "";
  drivers.forEach((d) => {
    const t = byDriver[d.id];
    const done = delivered[d.id] || 0;
    const target = t ? num(t.target_qty) : 0;
    const tr = document.createElement("tr");
    tr.innerHTML =
      "<td>" + escapeHtml(d.full_name) + "</td>" +
      '<td><input type="number" step="1" min="0" data-target="' + d.id + '" value="' + target + '" /></td>' +
      "<td>" + qty(done) + "</td>" +
      "<td>" + progressCell(done, target) + "</td>";
    body.appendChild(tr);
  });
}

document.getElementById("targetsSaveBtn").addEventListener("click", async () => {
  try {
    const mStart = monthStart(currentDate());
    const rows = [];
    document.querySelectorAll("input[data-target]").forEach((inp) => {
      rows.push({
        month_start: mStart,
        driver_id: inp.dataset.target,
        target_qty: num(inp.value),
        created_by: opProfile.id,
      });
    });
    await lpgCloud.upsert("driver_targets", rows, "month_start,driver_id");
    showOpMsg("Targets saved.", "ok");
    await loadTargetsTab();
    await loadOverview();
  } catch (err) {
    showOpMsg(err.message || "Could not save targets.", "error");
  }
});

// ---------- Plant purchases ----------
async function loadPurchases() {
  const mStart = monthStart(currentDate());
  const rows = await lpgCloud.select("plant_purchases", {
    gte: { purchase_date: mStart },
    lte: { purchase_date: currentDate() },
    order: { column: "purchase_date", ascending: false },
  });
  const body = document.getElementById("purchasesBody");
  body.innerHTML = "";
  let totalIn = 0, totalValue = 0;
  rows.forEach((r) => {
    totalIn += num(r.qty_received);
    totalValue += num(r.amount);
    const tr = document.createElement("tr");
    tr.innerHTML =
      "<td>" + r.purchase_date + "</td>" +
      "<td>" + escapeHtml(r.invoice_no) + "</td>" +
      "<td>" + escapeHtml(r.product) + "</td>" +
      "<td>" + qty(r.qty_received) + "</td>" +
      "<td>" + qty(r.empties_sent) + "</td>" +
      "<td>" + fmt(r.amount) + "</td>" +
      "<td>" + escapeHtml(r.vehicle_number) + "</td>" +
      '<td><button class="btn small danger" data-del="' + r.id + '">Delete</button></td>';
    body.appendChild(tr);
  });
  document.getElementById("ppTotalIn").textContent = qty(totalIn);
  document.getElementById("ppTotalValue").textContent = fmt(totalValue);
  body.querySelectorAll("[data-del]").forEach((btn) =>
    btn.addEventListener("click", async () => {
      await lpgCloud.remove("plant_purchases", btn.dataset.del);
      await loadPurchases();
    })
  );
}

document.getElementById("purchaseForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  try {
    await lpgCloud.insert("plant_purchases", [
      {
        purchase_date: currentDate(),
        invoice_no: document.getElementById("ppInvoice").value.trim(),
        product: document.getElementById("ppProduct").value,
        qty_received: num(document.getElementById("ppReceived").value),
        empties_sent: num(document.getElementById("ppEmpties").value),
        amount: num(document.getElementById("ppAmount").value),
        vehicle_number: document.getElementById("ppVehicle").value.trim().toUpperCase(),
        created_by: opProfile.id,
      },
    ]);
    document.getElementById("purchaseForm").reset();
    await loadPurchases();
  } catch (err) {
    showOpMsg(err.message || "Could not record the purchase.", "error");
  }
});

// ---------- Overview ----------
async function loadOverview() {
  const date = currentDate();
  const mStart = monthStart(date);

  const [bookings, trips, attendance, targets, delivered, vehicles] = await Promise.all([
    lpgCloud.select("bookings", { eq: { booking_date: date } }),
    lpgCloud.select("delivery_trips", { eq: { trip_date: date } }),
    lpgCloud.select("staff_attendance", { eq: { entry_date: date } }),
    lpgCloud.select("driver_targets", { eq: { month_start: mStart } }),
    deliveredThisMonthByDriver(),
    lpgCloud.select("vehicles"),
  ]);

  document.getElementById("ovBookings").textContent = bookings.length;
  document.getElementById("ovDelivered").textContent = bookings.filter((b) => b.status === "delivered").length;
  document.getElementById("ovPending").textContent =
    bookings.filter((b) => b.status === "booked" || b.status === "assigned").length;
  document.getElementById("ovTrips").textContent = trips.length;
  document.getElementById("ovPresent").textContent = attendance.filter((a) => a.status === "present").length;
  document.getElementById("ovAbsent").textContent = attendance.filter((a) => a.status === "absent").length;

  const byDriver = {};
  targets.forEach((t) => (byDriver[t.driver_id] = num(t.target_qty)));
  const body = document.getElementById("ovDriverBody");
  body.innerHTML = "";
  drivers.forEach((d) => {
    const done = delivered[d.id] || 0;
    const target = byDriver[d.id] || 0;
    const tr = document.createElement("tr");
    tr.innerHTML =
      "<td>" + escapeHtml(d.full_name) + "</td>" +
      "<td>" + qty(done) + "</td>" +
      "<td>" + (target ? qty(target) : "—") + "</td>" +
      "<td>" + progressCell(done, target) + "</td>";
    body.appendChild(tr);
  });

  // expiry alerts within 30 days
  const soon = new Date();
  soon.setDate(soon.getDate() + 30);
  const soonStr = soon.toISOString().slice(0, 10);
  const alerts = [];
  vehicles.forEach((v) => {
    [["Insurance", v.insurance_expiry], ["FC", v.fc_expiry], ["Permit", v.permit_expiry]].forEach(([label, d]) => {
      if (d && d <= soonStr) {
        alerts.push(
          '<div class="msg ' + (d < todayStr() ? "error" : "ok") + '" style="margin-bottom:8px;">' +
          escapeHtml(v.vehicle_number) + " — " + label + " " +
          (d < todayStr() ? "EXPIRED on " : "expires ") + d + "</div>"
        );
      }
    });
  });
  document.getElementById("ovExpiry").innerHTML =
    alerts.join("") || '<p style="font-size:13px;color:var(--muted);">No documents expiring in the next 30 days.</p>';
}

// ---------- init ----------
async function loadAllOps() {
  await Promise.all([
    loadOverview(),
    loadBookings(),
    loadVehicles(),
    loadAttendance(),
    loadPayroll(),
    loadTargetsTab(),
    loadPurchases(),
  ]);
}

initDashboard({
  current: "operations.html",
  roles: ["owner", "manager"],
  load: async (profile) => {
    opProfile = profile;
    if (!team.length) {
      team = await lpgCloud.select("profiles", { order: { column: "full_name", ascending: true } });
      drivers = team.filter((p) => p.role === "driver");
      payStaff = team.filter((p) => p.role !== "pending");
      document.getElementById("bkDriver").innerHTML =
        '<option value="">— later —</option>' +
        drivers.map((d) => '<option value="' + d.id + '">' + escapeHtml(d.full_name) + "</option>").join("");
      document.getElementById("prStaff").innerHTML =
        payStaff.map((p) => '<option value="' + p.id + '">' + escapeHtml(p.full_name) + " (" + p.role + ")</option>").join("");
    }
    await loadAllOps();
  },
});
