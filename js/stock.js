// Godown Stock dashboard — read-only view of what the Godown Incharge
// entered for the chosen date, with day-before comparison.

const PRODUCT_ORDER = [
  "14.2 Kg Domestic",
  "19 Kg Commercial",
  "5 Kg BMCG",
  "DPR (Regulator)",
  "Hose",
  "Lighter",
  "Book",
  "Stove",
];

const CONDITION_LABELS = { full: "Full", empty: "Empty", sound: "Sound", defective: "Defective", qty: "Qty" };
// Falling "full"/"sound" counts read as bad news; a falling "empty" or
// "defective" pile is fine, so those don't get the red treatment.
const WARN_WHEN_LOW = { full: true, sound: true };

function prevDate(dateStr) {
  const d = new Date(dateStr + "T00:00:00");
  d.setDate(d.getDate() - 1);
  return d.toISOString().slice(0, 10);
}

async function loadStockDash() {
  const date = document.getElementById("entryDate").value;

  const [rows, prevRows, sales] = await Promise.all([
    lpgCloud.select("godown_stock", { eq: { entry_date: date } }),
    lpgCloud.select("godown_stock", { eq: { entry_date: prevDate(date) } }),
    lpgCloud.select("godown_vehicle_sales", { eq: { entry_date: date } }),
  ]);

  const prevByKey = {};
  prevRows.forEach((r) => (prevByKey[r.product + "|" + r.condition] = num(r.quantity)));

  // group today's rows per product, keeping condition order stable
  const byProduct = {};
  rows.forEach((r) => {
    (byProduct[r.product] = byProduct[r.product] || []).push(r);
  });

  const grid = document.getElementById("stockGrid");
  grid.innerHTML = "";
  const products = PRODUCT_ORDER.filter((p) => byProduct[p]).concat(
    Object.keys(byProduct).filter((p) => PRODUCT_ORDER.indexOf(p) === -1).sort()
  );

  document.getElementById("stockEmpty").style.display = products.length ? "none" : "";

  products.forEach((product) => {
    const conditions = byProduct[product];
    const counts = conditions
      .map((r) => {
        const prev = prevByKey[r.product + "|" + r.condition];
        const diff = prev === undefined ? 0 : num(r.quantity) - prev;
        const warn = WARN_WHEN_LOW[r.condition] && num(r.quantity) === 0;
        return (
          '<div class="count' + (warn ? " warn" : "") + '">' +
          '<div class="n">' + qty(r.quantity) + "</div>" +
          '<div class="l">' + (CONDITION_LABELS[r.condition] || r.condition) + "</div>" +
          delta(diff, WARN_WHEN_LOW[r.condition] !== undefined) +
          "</div>"
        );
      })
      .join("");
    const card = document.createElement("div");
    card.className = "stock-card";
    card.innerHTML = '<div class="name">' + escapeHtml(product) + '</div><div class="counts">' + counts + "</div>";
    grid.appendChild(card);
  });

  // vehicle-wise dispatch
  const body = document.getElementById("vehicleBody");
  body.innerHTML = "";
  let sent = 0;
  sales.forEach((r) => {
    sent += num(r.qty);
    const tr = document.createElement("tr");
    tr.innerHTML =
      "<td>" + escapeHtml(r.vehicle_number) + "</td><td>" + escapeHtml(r.product) + "</td><td>" + qty(r.qty) + "</td>";
    body.appendChild(tr);
  });
  document.getElementById("sentTotal").textContent = qty(sent);
}

// ---------- Owner-only manual adjustment ----------
const ADJUST_CONFIG = [
  { product: "14.2 Kg Domestic", conditions: ["full", "empty"] },
  { product: "19 Kg Commercial", conditions: ["full", "empty"] },
  { product: "5 Kg BMCG", conditions: ["full", "empty"] },
  { product: "5 Kg FTL", conditions: ["full", "empty"] },
  { product: "DPR (Regulator)", conditions: ["sound", "defective"] },
  { product: "Hose", conditions: ["qty"] },
  { product: "Lighter", conditions: ["qty"] },
  { product: "Book", conditions: ["qty"] },
  { product: "Stove", conditions: ["qty"] },
];

async function loadAdjust(profile) {
  if (!["owner", "manager", "accounts"].includes(profile.role)) return;
  document.getElementById("adjustCard").style.display = "";
  const date = document.getElementById("entryDate").value;
  const rows = await lpgCloud.select("godown_stock", { eq: { entry_date: date } });
  const byKey = {};
  rows.forEach((r) => (byKey[r.product + "|" + r.condition] = num(r.quantity)));

  const grid = document.getElementById("adjustGrid");
  grid.innerHTML = "";
  ADJUST_CONFIG.forEach(({ product, conditions }) => {
    const card = document.createElement("div");
    card.className = "stock-card";
    card.innerHTML =
      '<div class="name">' + escapeHtml(product) + '</div><div class="counts" style="gap:8px;">' +
      conditions
        .map(
          (c) =>
            '<div style="flex:1;"><label style="font-size:11px;">' +
            (CONDITION_LABELS[c] || c) +
            '</label><input type="number" step="1" data-adj="' + product + '|' + c + '" value="' +
            (byKey[product + "|" + c] || 0) + '" /></div>'
        )
        .join("") +
      "</div>";
    grid.appendChild(card);
  });

  document.getElementById("adjustSaveBtn").onclick = async () => {
    try {
      const upserts = [];
      grid.querySelectorAll("input[data-adj]").forEach((inp) => {
        const [product, condition] = inp.dataset.adj.split("|");
        upserts.push({
          entry_date: date,
          product,
          condition,
          quantity: num(inp.value),
          created_by: profile.id,
        });
      });
      await lpgCloud.upsert("godown_stock", upserts, "entry_date,product,condition");
      const msg = document.getElementById("msg");
      msg.className = "msg ok";
      msg.textContent = "Stock adjusted.";
      await loadStockDash();
      await loadAdjust(profile);
    } catch (err) {
      const msg = document.getElementById("msg");
      msg.className = "msg error";
      msg.textContent = err.message || "Could not adjust stock.";
    }
  };
}

initDashboard({
  current: "stock.html",
  roles: ["owner", "manager", "accounts", "staff"],
  load: async (profile) => {
    await loadStockDash();
    await loadAdjust(profile);
  },
});
