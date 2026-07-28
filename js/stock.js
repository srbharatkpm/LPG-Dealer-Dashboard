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

initDashboard({
  current: "stock.html",
  roles: ["owner", "manager", "staff"],
  load: loadStockDash,
});
