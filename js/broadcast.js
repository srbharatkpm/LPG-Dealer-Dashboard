// Customers import + WhatsApp broadcast composer.
// Relies on globals defined in js/accounts.js: lpgCloud, profile, showMsg,
// hideMsg, num, fmt, escapeHtml, currentDate.

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function normalizePhone(raw) {
  let digits = String(raw || "").replace(/\D/g, "");
  if (digits.length === 10) digits = "91" + digits; // bare 10-digit Indian mobile
  if (digits.length === 11 && digits.startsWith("0")) digits = "91" + digits.slice(1);
  return digits;
}

function pickField(row, ...names) {
  for (const key of Object.keys(row)) {
    const norm = key.trim().toLowerCase().replace(/[\s_]/g, "");
    if (names.includes(norm)) return row[key];
  }
  return "";
}

// ---------- Customers ----------
async function loadCustomerSummary() {
  const all = await lpgCloud.selectAll("customers", { columns: "line, opted_out" });
  document.getElementById("customerTotal").textContent = all.length;
  document.getElementById("customerOptedOut").textContent = all.filter((c) => c.opted_out).length;

  const lines = Array.from(new Set(all.map((c) => (c.line || "").trim()).filter(Boolean))).sort();
  const sel = document.getElementById("bcAudience");
  const current = sel.value;
  sel.innerHTML =
    `<option value="all">All Customers</option>` +
    lines.map((l) => `<option value="line:${escapeHtml(l)}">Line: ${escapeHtml(l)}</option>`).join("");
  if ([...sel.options].some((o) => o.value === current)) sel.value = current;
}

// BPCL dates arrive three ways depending on how SheetJS reads the file:
// a "Jul 18, 2026" string, a JS Date, or an Excel serial number (SheetJS
// date-detects CSV cells into serials). Normalise all three to ISO.
function parseBpclDate(v) {
  if (v instanceof Date && !Number.isNaN(v.getTime())) {
    return v.toISOString().slice(0, 10);
  }
  if (typeof v === "number" || /^\d{4,6}(\.\d+)?$/.test(String(v).trim())) {
    const serial = Number(v);
    if (serial > 20000 && serial < 80000) {
      // Excel epoch: serial 1 = 1900-01-01 (with the 1900 leap-year quirk)
      const d = new Date(Date.UTC(1899, 11, 30) + serial * 86400000);
      return d.toISOString().slice(0, 10);
    }
    return null;
  }
  const t = String(v || "").trim();
  if (!t) return null;
  const d = new Date(t);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

// The eConnect "List Of Consumers" export starts with a 2-3 row preamble
// (DistCode etc.) before the real header. Find the header row, then map
// its 51 columns down to what the app stores.
function parseBpclConsumers(sheet) {
  const grid = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "" });
  const headerIdx = grid.findIndex((row) => row.indexOf("ConsumerNumber") !== -1);
  if (headerIdx === -1) return null; // not a BPCL file
  const header = grid[headerIdx];
  const col = {};
  header.forEach((h, i) => (col[h] = i));

  const out = [];
  for (let i = headerIdx + 1; i < grid.length; i++) {
    const row = grid[i];
    if (!row || row.length < 3) continue;
    const consumerNo = String(row[col.ConsumerNumber] || "").trim();
    const name = String(row[col.ConsumerName] || "").trim();
    if (!consumerNo || !name) continue;
    out.push({
      consumer_no: consumerNo,
      name,
      phone: normalizePhone(row[col.MobileNumber]) || normalizePhone(row[col.PhoneNumber]) || "",
      alt_phone: normalizePhone(row[col.PhoneNumber]) || null,
      line: String(row[col.AreaCodeDesc] || "").trim(),
      address: String(row[col.Address] || "").trim(),
      category: String(row[col.ConsumerTypeIdDesc] || "").trim() || null,
      last_delivery: parseBpclDate(row[col.LastDelivDate]),
      subsidy_elig: num(row[col.SubsidyQuotaEligForCurrentYear]) || null,
      subsidy_delv: num(row[col.SubsidyQuotaDelvForCurrentYear]) || null,
      kyc_done: /done/i.test(String(row[col.KYCDone] || "")),
      no_of_cylinders: num(row[col.NoOfCylinder]) || null,
      blue_book: String(row[col.BlueBookNumber] || "").trim() || null,
    });
  }
  // dedupe within the file on consumer number (upsert batches would
  // otherwise conflict with themselves)
  const seen = new Set();
  return out.filter((c) => (seen.has(c.consumer_no) ? false : seen.add(c.consumer_no)));
}

// The eConnect "EKYC Pending Customers" report — header row contains
// "Whether Verified Aadhaar". Marks those consumers ekyc_pending.
function parseEkycPending(sheet) {
  const grid = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "" });
  const findIn = (row, label) =>
    row.findIndex((c) => String(c).toLowerCase().indexOf(label) !== -1);
  const headerIdx = grid.findIndex((row) => findIn(row, "whether verified aadhaar") !== -1);
  if (headerIdx === -1) return null;
  const header = grid[headerIdx];
  const cNo = findIn(header, "consumer number");
  const cName = findIn(header, "consumer name");
  const cMob = findIn(header, "mobile");
  const out = [];
  for (let i = headerIdx + 1; i < grid.length; i++) {
    const row = grid[i];
    const no = String((row && row[cNo]) || "").trim();
    const name = String((row && row[cName]) || "").trim();
    if (!no || !name || !/^\d+$/.test(no)) continue;
    out.push({
      consumer_no: no,
      name,
      phone: normalizePhone(row[cMob]) || "",
      ekyc_pending: true,
    });
  }
  const seen = new Set();
  return out.filter((c) => (seen.has(c.consumer_no) ? false : seen.add(c.consumer_no)));
}

document.getElementById("customerImportBtn").addEventListener("click", async () => {
  const fileInput = document.getElementById("customerFile");
  const importMsg = document.getElementById("importMsg");
  const file = fileInput.files[0];
  if (!file) {
    importMsg.className = "msg error";
    importMsg.textContent = "Choose a .xlsx or .csv file first.";
    return;
  }
  importMsg.className = "msg ok";
  importMsg.textContent = "Reading file...";
  try {
    const buf = await file.arrayBuffer();
    const wb = XLSX.read(buf, { type: "array" });
    const sheet = wb.Sheets[wb.SheetNames[0]];

    // recognised formats, most specific first:
    // eKYC pending report -> BPCL consumer master -> plain name/phone list
    let customers = parseEkycPending(sheet);
    let sourceLabel = "eKYC pending report";
    if (!customers) {
      customers = parseBpclConsumers(sheet);
      sourceLabel = "BPCL consumer list";
    }
    if (!customers) {
      sourceLabel = "simple list";
      const rows = XLSX.utils.sheet_to_json(sheet, { defval: "" });
      customers = rows
        .map((r) => ({
          consumer_no: String(pickField(r, "consumerno", "consumer#", "consumernumber") || "").trim(),
          name: String(pickField(r, "name", "customername", "consumername") || "").trim(),
          phone: normalizePhone(pickField(r, "phone", "phoneno", "mobile", "mobileno", "phonenumber")),
          line: String(pickField(r, "line", "route", "area") || "").trim(),
        }))
        .filter((c) => c.name && (c.phone || c.consumer_no));
    }

    if (!customers.length) {
      importMsg.className = "msg error";
      importMsg.textContent = "No valid rows found in the file.";
      return;
    }
    customers.forEach((c) => (c.created_by = profile.id));

    const withNo = customers.filter((c) => c.consumer_no);
    const withoutNo = customers.filter((c) => !c.consumer_no);
    let done = 0;
    for (const batch of chunk(withNo, 500)) {
      await lpgCloud.upsert("customers", batch, "consumer_no");
      done += batch.length;
      importMsg.textContent = `Importing ${sourceLabel}: ${done} / ${customers.length}...`;
    }
    for (const batch of chunk(withoutNo, 500)) {
      await lpgCloud.insert("customers", batch);
      done += batch.length;
      importMsg.textContent = `Importing ${sourceLabel}: ${done} / ${customers.length}...`;
    }
    importMsg.className = "msg ok";
    importMsg.textContent = `Done — ${customers.length} consumers imported/updated from the ${sourceLabel}.`;
    fileInput.value = "";
    await loadCustomerSummary();
  } catch (err) {
    importMsg.className = "msg error";
    importMsg.textContent = err.message || "Import failed.";
  }
});

// ---------- Templates ----------
let templatesCache = [];

async function loadTemplates() {
  templatesCache = await lpgCloud.select("whatsapp_templates", { order: { column: "name", ascending: true } });
  const body = document.getElementById("templatesBody");
  body.innerHTML = "";
  templatesCache.forEach((t) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${escapeHtml(t.name)}</td>
      <td>${escapeHtml(t.category)}</td>
      <td>${t.param_count}</td>
      <td>${escapeHtml(t.body_text)}</td>
    `;
    body.appendChild(tr);
  });

  const sel = document.getElementById("bcTemplate");
  sel.innerHTML = templatesCache.map((t) => `<option value="${t.id}">${escapeHtml(t.name)} (${t.category})</option>`).join("");
  renderBcParams();
}

document.getElementById("templateForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  hideMsg();
  try {
    await lpgCloud.insert("whatsapp_templates", [
      {
        name: document.getElementById("tplName").value.trim(),
        category: document.getElementById("tplCategory").value,
        language: document.getElementById("tplLanguage").value.trim() || "en",
        body_text: document.getElementById("tplBody").value.trim(),
        param_count: num(document.getElementById("tplParamCount").value),
        created_by: profile.id,
      },
    ]);
    document.getElementById("templateForm").reset();
    document.getElementById("tplLanguage").value = "en";
    document.getElementById("tplParamCount").value = "1";
    await loadTemplates();
    showMsg("Template added.", "ok");
  } catch (err) {
    showMsg(err.message || "Could not add template.", "error");
  }
});

document.getElementById("bcTemplate").addEventListener("change", renderBcParams);

function renderBcParams() {
  const tplId = document.getElementById("bcTemplate").value;
  const tpl = templatesCache.find((t) => t.id === tplId);
  const wrap = document.getElementById("bcParamsWrap");
  wrap.innerHTML = "";
  if (!tpl || !tpl.param_count) return;
  const grid = document.createElement("div");
  grid.className = "grid";
  for (let i = 1; i <= tpl.param_count; i++) {
    const div = document.createElement("div");
    div.innerHTML = `<label>Placeholder {{${i}}}</label><input type="text" class="bcParam" data-param="${i}" />`;
    grid.appendChild(div);
  }
  wrap.appendChild(grid);
}

// ---------- Broadcasts ----------
async function loadBroadcasts() {
  const rows = await lpgCloud.select("whatsapp_broadcasts", { order: { column: "created_at", ascending: false } });
  const body = document.getElementById("broadcastsBody");
  body.innerHTML = "";
  rows.forEach((b) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${escapeHtml(b.title)}</td>
      <td>${escapeHtml(b.status)}</td>
      <td>${b.total_recipients}</td>
      <td>${b.sent_count}</td>
      <td>${b.failed_count}</td>
      <td><button class="btn small" data-send="${b.id}">Send Next Batch</button></td>
    `;
    body.appendChild(tr);
  });
  body.querySelectorAll("button[data-send]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      hideMsg();
      btn.disabled = true;
      try {
        const result = await lpgCloud.callFunction("send-whatsapp-broadcast", {
          broadcast_id: btn.getAttribute("data-send"),
          limit: 250,
        });
        showMsg(`Batch sent: ${result.sent || 0} sent, ${result.failed || 0} failed.`, "ok");
        await loadBroadcasts();
      } catch (err) {
        showMsg(
          (err.message || "Could not send batch.") +
            " — this requires the send-whatsapp-broadcast edge function to be deployed with WhatsApp credentials.",
          "error"
        );
      } finally {
        btn.disabled = false;
      }
    });
  });
}

document.getElementById("broadcastForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  hideMsg();
  try {
    const templateId = document.getElementById("bcTemplate").value;
    if (!templateId) {
      showMsg("Add a template first.", "error");
      return;
    }
    const audience = document.getElementById("bcAudience").value;
    const paramValues = {};
    document.querySelectorAll(".bcParam").forEach((inp) => {
      paramValues[inp.dataset.param] = inp.value;
    });

    let customers = await lpgCloud.selectAll("customers", { eq: { opted_out: false } });
    if (audience.startsWith("line:")) {
      const line = audience.slice(5);
      customers = customers.filter((c) => (c.line || "") === line);
    }
    if (!customers.length) {
      showMsg("No customers match this audience.", "error");
      return;
    }

    const [broadcastRow] = await lpgCloud.insert("whatsapp_broadcasts", [
      {
        title: document.getElementById("bcTitle").value.trim(),
        template_id: templateId,
        audience_filter: audience,
        param_values: paramValues,
        total_recipients: customers.length,
        created_by: profile.id,
      },
    ]);

    const recipientRows = customers.map((c) => ({ broadcast_id: broadcastRow.id, customer_id: c.id }));
    for (const batch of chunk(recipientRows, 500)) {
      await lpgCloud.insert("broadcast_recipients", batch);
    }

    document.getElementById("broadcastForm").reset();
    await loadBroadcasts();
    showMsg(`Broadcast created with ${customers.length} recipients queued (not sent yet).`, "ok");
  } catch (err) {
    showMsg(err.message || "Could not create broadcast.", "error");
  }
});

// ---------- init hook ----------
// Called from accounts.js's loadAllForDate() once the owner/manager profile is known.
async function loadBroadcastTab() {
  await loadCustomerSummary();
  await loadTemplates();
  await loadBroadcasts();
}
