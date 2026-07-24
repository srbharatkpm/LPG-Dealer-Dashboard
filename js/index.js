const tabSignIn = document.getElementById("tabSignIn");
const tabSignUp = document.getElementById("tabSignUp");
const signInForm = document.getElementById("signInForm");
const signUpForm = document.getElementById("signUpForm");
const msg = document.getElementById("msg");
const suRole = document.getElementById("suRole");
const suDriverFields = document.getElementById("suDriverFields");

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

suRole.addEventListener("change", () => {
  suDriverFields.style.display = suRole.value === "driver" ? "" : "none";
});

function showMsg(text, kind) {
  msg.textContent = text;
  msg.className = "msg " + kind;
}
function hideMsg() {
  msg.className = "msg hidden";
}

function routeForRole(role) {
  if (role === "owner" || role === "manager" || role === "accounts") return "accounts.html";
  if (role === "staff") return "godown.html";
  if (role === "driver") return "delivery.html";
  return null;
}

signInForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  hideMsg();
  const email = document.getElementById("siEmail").value.trim();
  const password = document.getElementById("siPassword").value;
  const btn = document.getElementById("siBtn");
  btn.disabled = true;
  try {
    await lpgCloud.signIn(email, password);
    const profile = await lpgCloud.getProfile();
    if (!profile) {
      showMsg("Signed in, but no profile role found. Contact the office.", "error");
      return;
    }
    const dest = routeForRole(profile.role);
    if (dest) window.location.href = dest;
  } catch (err) {
    showMsg(err.message || "Sign in failed.", "error");
  } finally {
    btn.disabled = false;
  }
});

signUpForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  hideMsg();
  const role = suRole.value;
  const email = document.getElementById("suEmail").value.trim();
  const password = document.getElementById("suPassword").value;
  const full_name = document.getElementById("suName").value.trim();
  const phone = document.getElementById("suPhone").value.trim();
  const vehicle_number = document.getElementById("suVehicle").value.trim();
  const line = document.getElementById("suLine").value.trim();
  const btn = document.getElementById("suBtn");

  if (!role) {
    showMsg("Please select a role.", "error");
    return;
  }

  btn.disabled = true;
  try {
    const result = await lpgCloud.signUp(email, password, {
      role,
      full_name,
      phone,
      vehicle_number,
      line,
    });
    if (result.needsConfirmation) {
      showMsg("Account created. Please check your email to confirm, then sign in.", "ok");
      tabSignIn.click();
    } else {
      const dest = routeForRole(role);
      if (dest) window.location.href = dest;
    }
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
