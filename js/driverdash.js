// Driver's personal performance dashboard: own delivery counts, OTP &
// eKYC compliance from trip entries, and the team leaderboard via the
// driver_leaderboard() database function (which exposes only delivered
// totals — never cash or sheet contents).

function ddMonthRange(d) {
  const start = new Date(d.getFullYear(), d.getMonth(), 1);
  const iso = (x) =>
    x.getFullYear() + "-" + String(x.getMonth() + 1).padStart(2, "0") + "-" + String(x.getDate()).padStart(2, "0");
  return { start: iso(start), today: iso(d) };
}

function ddLastMonthRange(d) {
  const start = new Date(d.getFullYear(), d.getMonth() - 1, 1);
  const end = new Date(d.getFullYear(), d.getMonth(), 0);
  const iso = (x) =>
    x.getFullYear() + "-" + String(x.getMonth() + 1).padStart(2, "0") + "-" + String(x.getDate()).padStart(2, "0");
  return { start: iso(start), end: iso(end) };
}

function ddDelivered(sheets) {
  return sheets.reduce((s, sh) => s + dsTotals(sh.data || {}).delivered, 0);
}

function ddCommercial(sheets) {
  return sheets.reduce(
    (s, sh) => s + dsNum((((sh.data || {}).stock || {})["19 Kg Cylinder"] || {}).delivered),
    0
  );
}

async function loadDriverDash(profile) {
  const now = new Date();
  const thisM = ddMonthRange(now);
  const lastM = ddLastMonthRange(now);

  // own sheets, last month start -> today, split client-side
  const sheets = await lpgCloud.select("driver_sheets", {
    eq: { driver_id: profile.id },
    gte: { sheet_date: lastM.start },
    lte: { sheet_date: thisM.today },
  });
  const thisSheets = sheets.filter((s) => s.sheet_date >= thisM.start);
  const lastSheets = sheets.filter((s) => s.sheet_date <= lastM.end);

  const thisDel = ddDelivered(thisSheets);
  document.getElementById("dThisMonth").textContent = qty(thisDel);
  document.getElementById("dLastMonth").textContent = qty(ddDelivered(lastSheets));
  document.getElementById("dAverage").textContent = qty(Math.round((thisDel / now.getDate()) * 10) / 10);
  document.getElementById("dCommercial").textContent = qty(ddCommercial(thisSheets));

  // OTP / eKYC compliance from own trip entries this month
  const trips = await lpgCloud.select("delivery_trips", {
    eq: { driver_id: profile.id },
    gte: { trip_date: thisM.start },
  });
  let otp = 0, ekyc = 0, noOtp = 0;
  for (const t of trips) {
    const entries = await lpgCloud.select("delivery_entries", {
      eq: { trip_id: t.id },
      columns: "otp, bio_metric",
    });
    entries.forEach((e) => {
      if (String(e.otp || "").trim()) otp++; else noOtp++;
      if (String(e.bio_metric || "").trim().toUpperCase() === "OK") ekyc++;
    });
  }
  document.getElementById("dOtp").textContent = qty(otp);
  document.getElementById("dEkyc").textContent = qty(ekyc);
  document.getElementById("dNoOtp").textContent = qty(noOtp);

  // leaderboard (this month) — aggregated counts only
  const board = (await lpgCloud.rpc("driver_leaderboard", {
    p_start: thisM.start,
    p_end: thisM.today,
  })) || [];
  board.sort((a, b) => num(b.delivered) - num(a.delivered));

  if (board.length) {
    const top = board[0];
    const least = board[board.length - 1];
    document.getElementById("dTop").textContent = top.driver_name + " — " + qty(num(top.delivered));
    document.getElementById("dLeast").textContent =
      board.length > 1 ? least.driver_name + " — " + qty(num(least.delivered)) : "—";
    const myIdx = board.findIndex((r) => r.driver_id === profile.id);
    document.getElementById("dRank").textContent =
      myIdx === -1 ? "—" : "#" + (myIdx + 1) + " of " + board.length;

    document.getElementById("leaderBody").innerHTML = board
      .map((r, i) => {
        const medal = i === 0 ? "🥇" : i === 1 ? "🥈" : i === 2 ? "🥉" : "";
        const you = r.driver_id === profile.id;
        return (
          '<tr class="' + (you ? "rank-you" : "") + '"><td>' +
          '<span class="medal">' + medal + "</span>#" + (i + 1) + "</td>" +
          "<td>" + escapeHtml(r.driver_name) + (you ? " (you)" : "") + "</td>" +
          "<td>" + qty(num(r.delivered)) + "</td></tr>"
        );
      })
      .join("");
  } else {
    document.getElementById("leaderBody").innerHTML =
      '<tr><td colspan="3" style="color:var(--muted);">No sheets submitted this month yet.</td></tr>';
  }
}

initDashboard({
  current: "driverdash.html",
  roles: ["driver"],
  load: loadDriverDash,
});
