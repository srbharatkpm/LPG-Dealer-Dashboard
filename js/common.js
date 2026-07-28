// Shared helpers for the dashboard pages (stock / finance / operations).
// The data-entry pages predate this and keep their own copies; this is
// only used by the three read-only dashboards.

function num(v) {
  const n = Number(v);
  return Number.isNaN(n) ? 0 : n;
}

function fmt(n) {
  return "₹" + Number(n || 0).toLocaleString("en-IN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function qty(n) {
  return Number(n || 0).toLocaleString("en-IN");
}

function escapeHtml(s) {
  if (s === null || s === undefined) return "";
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

function monthStart(dateStr) {
  const d = new Date(dateStr + "T00:00:00");
  return new Date(d.getFullYear(), d.getMonth(), 1).toISOString().slice(0, 10);
}

// Signed change, coloured by direction. `goodWhenUp` flips the colouring
// for figures where a fall is the good news (defective cylinders, say).
function delta(value, goodWhenUp) {
  if (!value) return '<span class="delta flat">no change</span>';
  const up = value > 0;
  const good = goodWhenUp === false ? !up : up;
  return (
    '<span class="delta ' + (good ? "up" : "down") + '">' +
    (up ? "▲ " : "▼ ") + qty(Math.abs(value)) + "</span>"
  );
}

const NAV_ITEMS = [
  { href: "stock.html", label: "Stock", roles: ["owner", "manager", "staff"] },
  { href: "finance.html", label: "Accounts", roles: ["owner", "manager", "accounts"] },
  { href: "operations.html", label: "Operations", roles: ["owner", "manager"] },
];

const ENTRY_ITEMS = [
  { href: "accounts.html", label: "Ledger Entry", roles: ["owner", "manager", "accounts"] },
  { href: "daysheet.html", label: "Day Sheet", roles: ["owner", "manager", "accounts"] },
  { href: "godown.html", label: "Godown Entry", roles: ["staff"] },
  { href: "delivery.html", label: "Trip Sheet", roles: ["driver"] },
];

function renderNav(currentHref, role) {
  const el = document.getElementById("dashNav");
  if (!el) return;
  const allowed = (item) => item.roles.indexOf(role) !== -1;
  const link = (item) =>
    '<a href="' + item.href + '"' +
    (item.href === currentHref ? ' class="on" aria-current="page"' : "") +
    ">" + escapeHtml(item.label) + "</a>";

  const dashboards = NAV_ITEMS.filter(allowed).map(link).join("");
  const entries = ENTRY_ITEMS.filter(allowed).map(link).join("");
  el.innerHTML = dashboards + (entries ? '<span class="nav-sep"></span>' + entries : "");
}

// Every dashboard shares the same shell: require a role, wire the date
// box and sign-out, draw the nav, then hand back the profile.
async function initDashboard(opts) {
  const msg = document.getElementById("msg");
  const show = (text, kind) => {
    msg.textContent = text;
    msg.className = "msg " + kind;
  };

  const signOutBtn = document.getElementById("signOutBtn");
  if (signOutBtn) {
    signOutBtn.addEventListener("click", async () => {
      await lpgCloud.signOut();
      window.location.href = "index.html";
    });
  }

  try {
    const profile = await lpgCloud.requireRole(opts.roles);
    if (!profile) return null;

    document.getElementById("whoName").textContent = profile.full_name;
    renderNav(opts.current, profile.role);

    const dateEl = document.getElementById("entryDate");
    if (dateEl) {
      dateEl.value = todayStr();
      dateEl.addEventListener("change", () => {
        opts.load(profile).catch((e) => show(e.message, "error"));
      });
    }

    await opts.load(profile);
    return profile;
  } catch (err) {
    show(err.message || "Could not load this page.", "error");
    return null;
  }
}
