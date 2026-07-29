// Settings — Owner/Manager: create staff logins (mobile + password) and
// manage everyone's role. Uses the create-team-user edge function, which
// verifies the caller's own JWT server-side before creating anything.

let stProfile = null;

function showStMsg(text, kind) {
  const msg = document.getElementById("msg");
  msg.textContent = text;
  msg.className = "msg " + kind;
}

function roleLabel(role) {
  return {
    owner: "Owner", manager: "Manager", accounts: "Accounts",
    staff: "Staff", driver: "Delivery Boy", pending: "Pending",
  }[role] || role;
}

// ---------- create login ----------
document.getElementById("createUserForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const out = document.getElementById("cuMsg");
  const btn = document.getElementById("cuBtn");
  out.className = "msg hidden";
  btn.disabled = true;
  try {
    const mobile = document.getElementById("cuMobile").value.replace(/\D/g, "").slice(-10);
    if (mobile.length !== 10) throw new Error("Mobile number must be 10 digits.");
    const password = document.getElementById("cuPassword").value;

    await lpgCloud.callFunction("create-team-user", {
      full_name: document.getElementById("cuName").value.trim(),
      mobile,
      role: document.getElementById("cuRole").value,
      password,
      vehicle_number: document.getElementById("cuVehicle").value.trim(),
      line: document.getElementById("cuLine").value.trim(),
    });

    out.className = "msg ok";
    out.textContent = `Login created. Tell them: mobile ${mobile}, password ${password}.`;
    document.getElementById("createUserForm").reset();
    document.getElementById("cuPassword").value = "lpg@1234";
    await loadTeam();
  } catch (err) {
    out.className = "msg error";
    out.textContent =
      (err.message || "Could not create the login.") +
      (String(err.message || "").indexOf("Failed to send a request") !== -1
        ? " — the create-team-user function is not deployed yet (see SETUP.md)."
        : "");
  } finally {
    btn.disabled = false;
  }
});

// ---------- team & roles ----------
async function loadTeam() {
  const rows = await lpgCloud.select("profiles", { order: { column: "full_name", ascending: true } });
  const body = document.getElementById("teamBody");
  body.innerHTML = "";
  rows.forEach((r) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${escapeHtml(r.full_name)}</td>
      <td>${escapeHtml(r.phone)}</td>
      <td>${escapeHtml([r.vehicle_number, r.line].filter(Boolean).join(" / "))}</td>
      <td>
        <select data-id="${r.id}" class="roleSelect">
          ${["pending", "owner", "manager", "accounts", "staff", "driver"]
            .map((role) => `<option value="${role}" ${r.role === role ? "selected" : ""}>${roleLabel(role)}</option>`)
            .join("")}
        </select>
      </td>
      <td style="white-space:nowrap;">
        <button class="btn small" data-save="${r.id}">Save</button>
        ${r.role !== "owner" ? `<button class="btn small danger" data-remove="${r.id}" data-name="${escapeHtml(r.full_name)}">Remove</button>` : ""}
      </td>
    `;
    body.appendChild(tr);
  });
  body.querySelectorAll("button[data-save]").forEach((b) => {
    b.addEventListener("click", async () => {
      const id = b.getAttribute("data-save");
      const sel = body.querySelector(`select[data-id="${id}"]`);
      try {
        await lpgCloud.update("profiles", id, { role: sel.value });
        showStMsg("Role updated.", "ok");
      } catch (err) {
        showStMsg(err.message || "Could not update the role.", "error");
      }
    });
  });
  body.querySelectorAll("button[data-remove]").forEach((b) => {
    b.addEventListener("click", async () => {
      if (!confirm(`Remove ${b.dataset.name}'s login completely? They will no longer be able to sign in.`)) return;
      try {
        await lpgCloud.callFunction("create-team-user", { action: "delete", user_id: b.dataset.remove });
        showStMsg("Login removed.", "ok");
        await loadTeam();
      } catch (err) {
        showStMsg(err.message || "Could not remove the login.", "error");
      }
    });
  });
}

initDashboard({
  current: "settings.html",
  roles: ["owner", "manager"],
  load: async (profile) => {
    stProfile = profile;
    await loadTeam();
  },
});
