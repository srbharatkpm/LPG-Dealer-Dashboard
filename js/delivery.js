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
    showEntrySections();
    await loadEntries();
  } else {
    currentTrip = null;
    document.getElementById("entriesCard").style.display = "none";
    document.getElementById("listCard").style.display = "none";
  }
}

function showEntrySections() {
  document.getElementById("entriesCard").style.display = "";
  document.getElementById("listCard").style.display = "";
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
    showMsg("Trip details saved.", "ok");
  } catch (err) {
    showMsg(err.message || "Could not save trip.", "error");
  } finally {
    btn.disabled = false;
  }
});

function numOrNull(v) {
  if (v === "" || v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isNaN(n) ? null : n;
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
    const existingCount = (await lpgCloud.select("delivery_entries", {
      eq: { trip_id: currentTrip.id },
    })).length;
    const payload = {
      trip_id: currentTrip.id,
      s_no: existingCount + 1,
      consumer_no: document.getElementById("eConsumerNo").value.trim(),
      consumer_name: document.getElementById("eConsumerName").value.trim(),
      phone_no: document.getElementById("ePhone").value.trim(),
      bio_metric: document.getElementById("eBio").value,
      safety_check: document.getElementById("eSafety").value,
      otp: document.getElementById("eOtp").value.trim(),
      amount: numOrNull(document.getElementById("eAmount").value) || 0,
    };
    await lpgCloud.insert("delivery_entries", [payload]);
    document.getElementById("entryForm").reset();
    document.getElementById("eAmount").value = "0";
    await loadEntries();
  } catch (err) {
    showMsg(err.message || "Could not add entry.", "error");
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
  let total = 0;
  rows.forEach((r) => {
    total += Number(r.amount || 0);
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${r.s_no ?? ""}</td>
      <td>${escapeHtml(r.consumer_no)}</td>
      <td>${escapeHtml(r.consumer_name)}</td>
      <td>${escapeHtml(r.phone_no)}</td>
      <td>${escapeHtml(r.bio_metric)}</td>
      <td>${escapeHtml(r.safety_check)}</td>
      <td>${escapeHtml(r.otp)}</td>
      <td>₹${Number(r.amount || 0).toFixed(2)}</td>
      <td><button class="btn small danger" data-id="${r.id}">Delete</button></td>
    `;
    body.appendChild(tr);
  });
  document.getElementById("totalCount").textContent = rows.length;
  document.getElementById("totalAmount").textContent = "₹" + total.toFixed(2);

  body.querySelectorAll("button[data-id]").forEach((b) => {
    b.addEventListener("click", async () => {
      const sb = lpgCloud.client();
      await sb.from("delivery_entries").delete().eq("id", b.getAttribute("data-id"));
      await loadEntries();
    });
  });
}

function escapeHtml(s) {
  if (s === null || s === undefined) return "";
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

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
