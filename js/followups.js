// Office follow-ups — refill chase list (derived from the imported BPCL
// consumer master's last-delivery dates) and eKYC pending list (flagged
// by importing the eConnect eKYC report). Every call gets logged.

let fuProfile = null;
let allCustomers = [];
let latestLog = {}; // consumer_no|type -> log row
let activeTier = "1";

const OUTCOMES = [
  ["booked", "Booked"],
  ["no_answer", "No answer"],
  ["call_later", "Call later"],
  ["not_interested", "Not interested"],
  ["done", "Done"],
];

function showFuMsg(text, kind) {
  const msg = document.getElementById("msg");
  msg.textContent = text;
  msg.className = "msg " + kind;
}

document.querySelectorAll(".tabs button").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tabs button").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    document.querySelectorAll(".tab-panel").forEach((p) => (p.style.display = "none"));
    document.getElementById("panel-" + btn.dataset.tab).style.display = "";
  });
});

function daysSince(dateStr) {
  if (!dateStr) return null;
  return Math.floor((Date.now() - new Date(dateStr + "T00:00:00").getTime()) / 86400000);
}

function tierOf(days) {
  if (days === null || days < 90) return null;
  if (days < 120) return "1";
  if (days < 180) return "2";
  if (days >= 365) return "4";
  return "3";
}

const TIER_LABEL = { 1: "Hot", 2: "Warm", 3: "Cold", 4: "Dormant" };

function logCell(c, type) {
  const key = c.consumer_no + "|" + type;
  const log = latestLog[key];
  return log
    ? escapeHtml(log.entry_date + " — " + (OUTCOMES.find((o) => o[0] === log.outcome) || [])[1])
    : '<span style="color:var(--muted);">never</span>';
}

function outcomePicker(c, type) {
  return (
    '<select data-log="' + escapeHtml(c.consumer_no) + '" data-type="' + type + '">' +
    '<option value="">— outcome —</option>' +
    OUTCOMES.map(([v, l]) => '<option value="' + v + '">' + l + "</option>").join("") +
    "</select>"
  );
}

async function saveLog(consumerNo, type, outcome, afterSave) {
  try {
    const rows = await lpgCloud.insert("followup_logs", [
      {
        consumer_no: consumerNo,
        followup_type: type,
        outcome,
        created_by: fuProfile.id,
      },
    ]);
    const row = rows[0] || { entry_date: todayStr(), outcome };
    latestLog[consumerNo + "|" + type] = row;
    showFuMsg("Call logged.", "ok");
    if (afterSave) afterSave();
  } catch (err) {
    showFuMsg(err.message || "Could not log the call.", "error");
  }
}

function wireLogPickers(scope, rerender) {
  scope.querySelectorAll("select[data-log]").forEach((sel) =>
    sel.addEventListener("change", () => {
      if (!sel.value) return;
      saveLog(sel.dataset.log, sel.dataset.type, sel.value, rerender);
    })
  );
}

// ---------- refill ----------
function renderRefill() {
  const search = document.getElementById("refillSearch").value.trim().toLowerCase();
  const counts = { 1: 0, 2: 0, 3: 0, 4: 0 };
  const rows = [];

  allCustomers.forEach((c) => {
    const days = daysSince(c.last_delivery);
    const tier = tierOf(days);
    if (!tier) return;
    counts[tier]++;
    if (tier !== activeTier) return;
    if (
      search &&
      (c.name + " " + c.consumer_no + " " + (c.line || "")).toLowerCase().indexOf(search) === -1
    )
      return;
    rows.push({ c, days, tier });
  });

  ["1", "2", "3", "4"].forEach((t) => (document.getElementById("cntT" + t).textContent = qty(counts[t])));

  rows.sort((a, b) => b.days - a.days);
  const shown = rows.slice(0, 300);
  document.getElementById("refillBody").innerHTML = shown
    .map(
      ({ c, days, tier }) =>
        "<tr><td>" + escapeHtml(c.consumer_no) + "</td>" +
        "<td>" + escapeHtml(c.name) + "</td>" +
        "<td>" + escapeHtml(c.phone || c.alt_phone || "") + "</td>" +
        "<td>" + escapeHtml(c.line) + "</td>" +
        "<td>" + escapeHtml(c.last_delivery || "—") + "</td>" +
        '<td class="tier-' + tier + '">' + days + "d</td>" +
        "<td>" + logCell(c, "refill") + "</td>" +
        "<td>" + outcomePicker(c, "refill") + "</td></tr>"
    )
    .join("");
  document.getElementById("refillCount").textContent =
    shown.length < rows.length
      ? "Showing " + shown.length + " of " + rows.length + " — narrow with search."
      : rows.length + " consumer(s) in this tier.";
  wireLogPickers(document.getElementById("refillBody"), renderRefill);
}

document.getElementById("refillSearch").addEventListener("input", renderRefill);
document.querySelectorAll("#tierFilter button").forEach((btn) =>
  btn.addEventListener("click", () => {
    document.querySelectorAll("#tierFilter button").forEach((b) => b.classList.remove("on"));
    btn.classList.add("on");
    activeTier = btn.dataset.tier;
    renderRefill();
  })
);

// ---------- eKYC ----------
function renderEkyc() {
  const search = document.getElementById("ekycSearch").value.trim().toLowerCase();
  const rows = allCustomers.filter((c) => {
    if (!c.ekyc_pending) return false;
    if (
      search &&
      (c.name + " " + c.consumer_no + " " + (c.line || "")).toLowerCase().indexOf(search) === -1
    )
      return false;
    return true;
  });
  const shown = rows.slice(0, 300);
  document.getElementById("ekycBody").innerHTML = shown
    .map(
      (c) =>
        "<tr><td>" + escapeHtml(c.consumer_no) + "</td>" +
        "<td>" + escapeHtml(c.name) + "</td>" +
        "<td>" + escapeHtml(c.phone || c.alt_phone || "") + "</td>" +
        "<td>" + escapeHtml(c.line) + "</td>" +
        "<td>" + logCell(c, "ekyc") + "</td>" +
        "<td>" + outcomePicker(c, "ekyc") + "</td>" +
        '<td><button class="btn small" data-kycdone="' + c.id + '">eKYC Done</button></td></tr>'
    )
    .join("");
  document.getElementById("ekycCount").textContent =
    (shown.length < rows.length ? "Showing " + shown.length + " of " : "") + rows.length + " pending.";

  wireLogPickers(document.getElementById("ekycBody"), renderEkyc);
  document.querySelectorAll("[data-kycdone]").forEach((btn) =>
    btn.addEventListener("click", async () => {
      try {
        await lpgCloud.update("customers", btn.dataset.kycdone, { ekyc_pending: false });
        const c = allCustomers.find((x) => x.id === btn.dataset.kycdone);
        if (c) c.ekyc_pending = false;
        renderEkyc();
        showFuMsg("Marked eKYC done.", "ok");
      } catch (err) {
        showFuMsg(err.message || "Could not update.", "error");
      }
    })
  );
}

document.getElementById("ekycSearch").addEventListener("input", renderEkyc);

// ---------- init ----------
initDashboard({
  current: "followups.html",
  roles: ["owner", "manager", "accounts"],
  load: async (profile) => {
    fuProfile = profile;
    showFuMsg("Loading consumers…", "ok");
    const [customers, logs] = await Promise.all([
      lpgCloud.selectAll("customers", {
        columns: "id, consumer_no, name, phone, alt_phone, line, last_delivery, ekyc_pending",
      }),
      lpgCloud.selectAll("followup_logs"),
    ]);
    allCustomers = customers;
    latestLog = {};
    logs
      .sort((a, b) => (a.created_at < b.created_at ? -1 : 1))
      .forEach((l) => (latestLog[l.consumer_no + "|" + l.followup_type] = l));
    document.getElementById("msg").className = "msg hidden";
    renderRefill();
    renderEkyc();
  },
});
