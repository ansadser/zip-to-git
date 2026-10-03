const $ = (id) => document.getElementById(id);
const loginCard = $("loginCard");
const appCard = $("appCard");
const loginForm = $("loginForm");
const uploadForm = $("uploadForm");
const password = $("password");
const loginError = $("loginError");
const zip = $("zip");
const fileName = $("fileName");
const uploadButton = $("uploadButton");
const progress = $("progress");
const barFill = $("barFill");
const progressText = $("progressText");
const result = $("result");

function showApp(authenticated) {
  loginCard.classList.toggle("hidden", authenticated);
  appCard.classList.toggle("hidden", !authenticated);
}

async function checkSession() {
  const response = await fetch("/api/status");
  const data = await response.json();
  showApp(data.authenticated);
}

loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  loginError.textContent = "";
  const response = await fetch("/api/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password: password.value })
  });
  const data = await response.json();
  if (!response.ok) {
    loginError.textContent = data.error || "Login failed.";
    return;
  }
  password.value = "";
  showApp(true);
});

$("logout").addEventListener("click", async () => {
  await fetch("/api/logout", { method: "POST" });
  showApp(false);
});

zip.addEventListener("change", () => {
  fileName.textContent = zip.files[0]?.name || "Choose a ZIP file";
});

uploadForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const file = zip.files[0];
  if (!file) return;

  result.className = "result hidden";
  progress.classList.remove("hidden");
  barFill.style.width = "0%";
  progressText.textContent = "Uploading ZIP…";
  uploadButton.disabled = true;

  const formData = new FormData();
  formData.append("zip", file);

  const xhr = new XMLHttpRequest();
  xhr.open("POST", "/api/upload");

  xhr.upload.onprogress = (event) => {
    if (event.lengthComputable) {
      const percent = Math.round((event.loaded / event.total) * 100);
      barFill.style.width = percent + "%";
      progressText.textContent = percent < 100 ? `Uploading ZIP… ${percent}%` : "Extracting and committing…";
    }
  };

  xhr.onload = () => {
    uploadButton.disabled = false;
    progress.classList.add("hidden");
    let data = {};
    try { data = JSON.parse(xhr.responseText); } catch {}

    result.classList.remove("hidden");
    if (xhr.status >= 200 && xhr.status < 300) {
      result.className = "result success";
      result.textContent = `✅ ${data.message}\n\nFiles: ${data.files}\nRepository: ${data.repository}\nBranch: ${data.branch}\nCommit: ${data.commitSha}`;
      uploadForm.reset();
      fileName.textContent = "Choose a ZIP file";
    } else {
      result.className = "result fail";
      result.textContent = `❌ ${data.error || "Upload failed."}`;
    }
  };

  xhr.onerror = () => {
    uploadButton.disabled = false;
    progress.classList.add("hidden");
    result.className = "result fail";
    result.classList.remove("hidden");
    result.textContent = "❌ Network error. Please try again.";
  };

  xhr.send(formData);
});

checkSession();