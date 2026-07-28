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
  const all = await lpgCloud.select("customers", { columns: "line, opted_out" });
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
    const rows = XLSX.utils.sheet_to_json(sheet, { defval: "" });

    const customers = rows
      .map((r) => ({
        consumer_no: String(pickField(r, "consumerno", "consumer#", "consumernumber") || "").trim(),
        name: String(pickField(r, "name", "customername", "consumername") || "").trim(),
        phone: normalizePhone(pickField(r, "phone", "phoneno", "mobile", "mobileno", "phonenumber")),
        line: String(pickField(r, "line", "route", "area") || "").trim(),
        created_by: profile.id,
      }))
      .filter((c) => c.phone && c.name);

    if (!customers.length) {
      importMsg.className = "msg error";
      importMsg.textContent = "No valid rows found — need at least name + phone columns.";
      return;
    }

    const batches = chunk(customers, 500);
    let done = 0;
    for (const batch of batches) {
      await lpgCloud.upsert("customers", batch, "phone");
      done += batch.length;
      importMsg.textContent = `Imported ${done} / ${customers.length}...`;
    }
    importMsg.className = "msg ok";
    importMsg.textContent = `Done — imported/updated ${customers.length} customers (skipped ${rows.length - customers.length} rows missing name/phone).`;
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

    let customers = await lpgCloud.select("customers", { eq: { opted_out: false } });
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
