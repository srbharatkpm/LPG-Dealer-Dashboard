const tabSignIn = document.getElementById("tabSignIn");
const tabSignUp = document.getElementById("tabSignUp");
const signInForm = document.getElementById("signInForm");
const signUpForm = document.getElementById("signUpForm");
const msg = document.getElementById("msg");

tabSignIn.addEventListener("click", () => {
  tabSignIn.classList.add("active");
  tabSignUp.classList.remove("active");
  signInForm.style.display = "";
  signUpForm.style.display = "none";
  hideMsg();
});

tabSignUp.addEventListener("click", () => {
  tabSignUp.classList.add("active");
  tabSignIn.classList.remove("active");
  signUpForm.style.display = "";
  signInForm.style.display = "none";
  hideMsg();
});

function showMsg(text, kind) {
  msg.textContent = text;
  msg.className = "msg " + kind;
}
function hideMsg() {
  msg.className = "msg hidden";
}

// Staff logins are created by the owner against a mobile number, which is
// stored as a synthetic email (9876543210@srbharatgas.local) because
// Supabase Auth needs an email identifier. So the sign-in box accepts
// either: 10 digits are treated as a mobile, anything else as an email.
const STAFF_EMAIL_DOMAIN = "srbharatgas.local";

function toLoginEmail(value) {
  const v = String(value || "").trim();
  if (v.indexOf("@") !== -1) return v;
  const digits = v.replace(/\D/g, "");
  if (digits.length === 10 || digits.length === 12) {
    return digits.slice(-10) + "@" + STAFF_EMAIL_DOMAIN;
  }
  return v;
}

function routeForRole(role) {
  if (role === "owner" || role === "manager" || role === "accounts") return "dashboard.html";
  if (role === "staff") return "godown.html";
  if (role === "driver") return "delivery.html";
  return null; // 'pending' (or anything unrecognised) has nowhere to go yet
}

// The role comes from the database, not from anything typed here — a new
// signup sits on 'pending' until the owner assigns it from the Team tab.
function handleProfile(profile) {
  if (!profile) {
    showMsg("Signed in, but no profile was found. Tell the office.", "error");
    return;
  }
  const dest = routeForRole(profile.role);
  if (dest) {
    window.location.href = dest;
    return;
  }
  showMsg(
    "Your account is waiting for the owner to assign your role. " +
      "Once that's done, sign in again and you'll go straight to your page.",
    "ok"
  );
}

signInForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  hideMsg();
  const email = toLoginEmail(document.getElementById("siEmail").value);
  const password = document.getElementById("siPassword").value;
  const btn = document.getElementById("siBtn");
  btn.disabled = true;
  try {
    await lpgCloud.signIn(email, password);
    handleProfile(await lpgCloud.getProfile());
  } catch (err) {
    showMsg(err.message || "Sign in failed.", "error");
  } finally {
    btn.disabled = false;
  }
});

signUpForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  hideMsg();
  const email = document.getElementById("suEmail").value.trim();
  const password = document.getElementById("suPassword").value;
  const full_name = document.getElementById("suName").value.trim();
  const phone = document.getElementById("suPhone").value.trim();
  const vehicle_number = document.getElementById("suVehicle").value.trim();
  const line = document.getElementById("suLine").value.trim();
  const btn = document.getElementById("suBtn");

  btn.disabled = true;
  try {
    const result = await lpgCloud.signUp(email, password, {
      full_name,
      phone,
      vehicle_number,
      line,
    });
    if (result.needsConfirmation) {
      showMsg("Account created. Confirm your email, then sign in.", "ok");
      tabSignIn.click();
      return;
    }
    handleProfile(await lpgCloud.getProfile());
  } catch (err) {
    showMsg(err.message || "Sign up failed.", "error");
  } finally {
    btn.disabled = false;
  }
});

// If already signed in, skip straight to the right page.
(async () => {
  try {
    const session = await lpgCloud.getSession();
    if (session) {
      const profile = await lpgCloud.getProfile();
      const dest = profile && routeForRole(profile.role);
      if (dest) window.location.href = dest;
    }
  } catch (_) {
    // config not set up yet — stay on the login screen
  }
})();
