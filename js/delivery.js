let profile = null;
let currentTrip = null;

const msg = document.getElementById("msg");
function showMsg(text, kind) {
  msg.textContent = text;
  msg.className = "msg " + kind;
}
function hideMsg() {
  msg.className = "msg hidden";
}

document.getElementById("signOutBtn").addEventListener("click", async () => {
  await lpgCloud.signOut();
  window.location.href = "index.html";
});

function todayStr() {
  const d = new Date();
  return d.toISOString().slice(0, 10);
}

function numOrNull(v) {
  if (v === "" || v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isNaN(n) ? null : n;
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

async function loadOrInitTrip() {
  const date = document.getElementById("tripDate").value;
  const existing = await lpgCloud.select("delivery_trips", {
    eq: { driver_id: profile.id, trip_date: date },
  });
  if (existing.length) {
    currentTrip = existing[0];
    document.getElementById("tripVehicle").value = currentTrip.vehicle_number || "";
    document.getElementById("tripLine").value = currentTrip.line || "";
    document.getElementById("tripStartKms").value = currentTrip.starting_kms ?? "";
    document.getElementById("tripEndKms").value = currentTrip.ending_kms ?? "";
    document.getElementById("tripUplifted").value = currentTrip.total_uplifted ?? 0;
    document.getElementById("tripUpliftTime").value = currentTrip.uplift_time || "";
    document.getElementById("tripProduct").value = currentTrip.product || "14.2 Kg Domestic";
    document.getElementById("tripRate").value = currentTrip.rate ?? 0;
    ["n500", "n200", "n100", "n50", "n20", "n10", "c10", "c5", "c2", "c1"].forEach((id) => {
      document.getElementById(id).value = currentTrip[denomFieldMap[id]] ?? 0;
    });
    document.getElementById("paidToAccounts").value = currentTrip.total_paid_to_accounts ?? 0;
    showEntrySections();
    await loadEntries();
    recomputeCashTotal();
  } else {
    currentTrip = null;
    document.getElementById("entriesCard").style.display = "none";
    document.getElementById("listCard").style.display = "none";
    document.getElementById("cashCard").style.display = "none";
  }
}

function showEntrySections() {
  document.getElementById("entriesCard").style.display = "";
  document.getElementById("listCard").style.display = "";
  document.getElementById("cashCard").style.display = "";
}

document.getElementById("tripDate").addEventListener("change", () => {
  loadOrInitTrip().catch((e) => showMsg(e.message, "error"));
});

document.getElementById("tripForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  hideMsg();
  const btn = document.getElementById("tripSaveBtn");
  btn.disabled = true;
  try {
    const payload = {
      driver_id: profile.id,
      driver_name: profile.full_name,
      vehicle_number: document.getElementById("tripVehicle").value.trim(),
      line: document.getElementById("tripLine").value.trim(),
      trip_date: document.getElementById("tripDate").value,
      starting_kms: numOrNull(document.getElementById("tripStartKms").value),
      ending_kms: numOrNull(document.getElementById("tripEndKms").value),
      total_uplifted: num(document.getElementById("tripUplifted").value),
      uplift_time: document.getElementById("tripUpliftTime").value || null,
      product: document.getElementById("tripProduct").value,
      rate: num(document.getElementById("tripRate").value),
    };
    if (currentTrip) {
      const rows = await lpgCloud.update("delivery_trips", currentTrip.id, payload);
      currentTrip = rows[0];
    } else {
      const rows = await lpgCloud.insert("delivery_trips", [payload]);
      currentTrip = rows[0];
    }
    showEntrySections();
    await loadEntries();
    recomputeCashTotal();
    showMsg("Trip details saved.", "ok");
  } catch (err) {
    showMsg(err.message || "Could not save trip.", "error");
  } finally {
    btn.disabled = false;
  }
});

// When set, the form is modifying this existing entry instead of adding.
let editingEntryId = null;

function resetEntryForm() {
  editingEntryId = null;
  document.getElementById("entryForm").reset();
  document.getElementById("eDelivered").value = "1";
  document.getElementById("eReturn").value = "0";
  document.getElementById("eAmount").value = "0";
  document.getElementById("entryAddBtn").textContent = "Add Entry";
}

document.getElementById("entryForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  hideMsg();
  if (!currentTrip) {
    showMsg("Save trip details first.", "error");
    return;
  }
  const btn = document.getElementById("entryAddBtn");
  btn.disabled = true;
  try {
    const payload = {
      consumer_no: document.getElementById("eConsumerNo").value.trim(),
      consumer_name: document.getElementById("eConsumerName").value.trim(),
      phone_no: document.getElementById("ePhone").value.trim(),
      bio_metric: document.getElementById("eBio").value,
      safety_check: document.getElementById("eSafety").value,
      otp: document.getElementById("eOtp").value.trim(),
      delivered_qty: num(document.getElementById("eDelivered").value) || 0,
      return_qty: num(document.getElementById("eReturn").value) || 0,
      amount: num(document.getElementById("eAmount").value) || 0,
    };
    if (editingEntryId) {
      await lpgCloud.update("delivery_entries", editingEntryId, payload);
    } else {
      const existingCount = (
        await lpgCloud.select("delivery_entries", { eq: { trip_id: currentTrip.id } })
      ).length;
      payload.trip_id = currentTrip.id;
      payload.s_no = existingCount + 1;
      await lpgCloud.insert("delivery_entries", [payload]);
    }
    resetEntryForm();
    await loadEntries();
  } catch (err) {
    showMsg(err.message || "Could not save entry.", "error");
  } finally {
    btn.disabled = false;
  }
});

async function loadEntries() {
  const rows = await lpgCloud.select("delivery_entries", {
    eq: { trip_id: currentTrip.id },
    order: { column: "s_no", ascending: true },
  });
  const body = document.getElementById("entriesBody");
  body.innerHTML = "";
  let totalAmount = 0;
  let totalDelivered = 0;
  let totalReturn = 0;
  rows.forEach((r) => {
    totalAmount += Number(r.amount || 0);
    totalDelivered += Number(r.delivered_qty || 0);
    totalReturn += Number(r.return_qty || 0);
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${r.s_no ?? ""}</td>
      <td>${escapeHtml(r.consumer_no)}</td>
      <td>${escapeHtml(r.consumer_name)}</td>
      <td>${escapeHtml(r.phone_no)}</td>
      <td>${escapeHtml(r.bio_metric)}</td>
      <td>${escapeHtml(r.safety_check)}</td>
      <td>${escapeHtml(r.otp)}</td>
      <td>${r.delivered_qty ?? 0}</td>
      <td>${r.return_qty ?? 0}</td>
      <td>${fmt(r.amount)}</td>
      <td style="white-space:nowrap;">
        <button class="btn small secondary" data-edit="${r.id}">Edit</button>
        <button class="btn small danger" data-id="${r.id}">Delete</button>
      </td>
    `;
    body.appendChild(tr);
  });

  // Edit loads the row back into the form; the submit becomes an update.
  const rowsById = {};
  rows.forEach((r) => (rowsById[r.id] = r));
  body.querySelectorAll("button[data-edit]").forEach((b) => {
    b.addEventListener("click", () => {
      const r = rowsById[b.getAttribute("data-edit")];
      editingEntryId = r.id;
      document.getElementById("eConsumerNo").value = r.consumer_no || "";
      document.getElementById("eConsumerName").value = r.consumer_name || "";
      document.getElementById("ePhone").value = r.phone_no || "";
      document.getElementById("eBio").value = r.bio_metric || "";
      document.getElementById("eSafety").value = r.safety_check || "";
      document.getElementById("eOtp").value = r.otp || "";
      document.getElementById("eDelivered").value = r.delivered_qty ?? 1;
      document.getElementById("eReturn").value = r.return_qty ?? 0;
      document.getElementById("eAmount").value = r.amount ?? 0;
      document.getElementById("entryAddBtn").textContent = "Update Entry (S.No " + (r.s_no ?? "") + ")";
      document.getElementById("entriesCard").scrollIntoView({ behavior: "smooth" });
    });
  });
  document.getElementById("totalCount").textContent = rows.length;
  document.getElementById("totalDelivered").textContent = totalDelivered;
  document.getElementById("totalReturn").textContent = totalReturn;
  document.getElementById("totalAmount").textContent = fmt(totalAmount);
  const rate = num(document.getElementById("tripRate").value);
  document.getElementById("talliedAmount").textContent = fmt(totalDelivered * rate);

  body.querySelectorAll("button[data-id]").forEach((b) => {
    b.addEventListener("click", async () => {
      const sb = lpgCloud.client();
      await sb.from("delivery_entries").delete().eq("id", b.getAttribute("data-id"));
      await loadEntries();
    });
  });

  recomputeTallyMsg(totalDelivered * rate);
}

// ---------- Cash & Handover ----------
const denomMap = { n500: 500, n200: 200, n100: 100, n50: 50, n20: 20, n10: 10, c10: 10, c5: 5, c2: 2, c1: 1 };
const denomFieldMap = {
  n500: "note_500", n200: "note_200", n100: "note_100", n50: "note_50", n20: "note_20", n10: "note_10",
  c10: "coin_10", c5: "coin_5", c2: "coin_2", c1: "coin_1",
};

function recomputeCashTotal() {
  let total = 0;
  Object.entries(denomMap).forEach(([id, val]) => (total += num(document.getElementById(id).value) * val));
  document.getElementById("cashTotal").textContent = fmt(total);
  const rate = num(document.getElementById("tripRate").value);
  const totalDelivered = num(document.getElementById("totalDelivered").textContent);
  recomputeTallyMsg(totalDelivered * rate);
  return total;
}
Object.keys(denomMap).forEach((id) => document.getElementById(id).addEventListener("input", recomputeCashTotal));
document.getElementById("paidToAccounts").addEventListener("input", () => recomputeTallyMsg());
document.getElementById("tripRate").addEventListener("input", () => {
  const rate = num(document.getElementById("tripRate").value);
  const totalDelivered = num(document.getElementById("totalDelivered").textContent);
  document.getElementById("talliedAmount").textContent = fmt(totalDelivered * rate);
  recomputeTallyMsg(totalDelivered * rate);
});

function recomputeTallyMsg(talliedOverride) {
  const rate = num(document.getElementById("tripRate").value);
  const totalDelivered = num(document.getElementById("totalDelivered").textContent);
  const tallied = talliedOverride != null ? talliedOverride : totalDelivered * rate;
  const paid = num(document.getElementById("paidToAccounts").value);
  const el = document.getElementById("tallyMsg");
  const diff = Math.round((tallied - paid) * 100) / 100;
  if (Math.abs(diff) > 0.5) {
    el.className = "msg error";
    el.textContent = `Tallied amount (${fmt(tallied)}) does not match Paid to Accounts (${fmt(paid)}) — difference ${fmt(diff)}.`;
  } else {
    el.className = "msg ok";
    el.textContent = `Paid to Accounts matches the tallied amount.`;
  }
}

document.getElementById("cashForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  hideMsg();
  if (!currentTrip) {
    showMsg("Save trip details first.", "error");
    return;
  }
  try {
    const payload = { total_paid_to_accounts: num(document.getElementById("paidToAccounts").value) };
    Object.entries(denomFieldMap).forEach(([id, field]) => (payload[field] = num(document.getElementById(id).value)));
    const rows = await lpgCloud.update("delivery_trips", currentTrip.id, payload);
    currentTrip = rows[0];
    showMsg("Cash & handover saved.", "ok");
  } catch (err) {
    showMsg(err.message || "Could not save cash count.", "error");
  }
});

(async () => {
  try {
    profile = await lpgCloud.requireRole("driver");
    if (!profile) return;
    document.getElementById("whoName").textContent = profile.full_name + " (Driver)";
    document.getElementById("tripDate").value = todayStr();
    document.getElementById("tripVehicle").value = profile.vehicle_number || "";
    document.getElementById("tripLine").value = profile.line || "";
    await loadOrInitTrip();
  } catch (err) {
    showMsg(err.message || "Failed to load.", "error");
  }
})();
