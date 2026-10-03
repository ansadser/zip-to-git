const $ = (id) => document.getElementById(id);
const loginCard = $("loginCard");
const appCard = $("appCard");
const loginForm = $("loginForm");
const uploadForm = $("uploadForm");
const password = $("password");
const repository = $("repository");
const repoError = $("repoError");
const loginError = $("loginError");
const zip = $("zip");
const fileName = $("fileName");
const uploadButton = $("uploadButton");
const progress = $("progress");
const barFill = $("barFill");
const progressText = $("progressText");
const result = $("result");
let authToken = sessionStorage.getItem("zip_to_git_auth") || "";

function authHeaders() {
  return authToken ? { Authorization: `Bearer ${authToken}` } : {};
}

function showApp(authenticated) {
  loginCard.classList.toggle("hidden", authenticated);
  appCard.classList.toggle("hidden", !authenticated);
  if (authenticated) loadRepositories();
}

async function loadRepositories(repositoriesFromStatus = null) {
  repoError.textContent = "";
  repository.innerHTML = '<option value="">Loading repositories…</option>';
  try {
    let data;
    if (repositoriesFromStatus) {
      data = { repositories: repositoriesFromStatus };
    } else {
      const response = await fetch("/api/repos", { credentials: "include", cache: "no-store", headers: authHeaders() });
      data = await response.json();
      if (!response.ok) throw new Error(data.error || "Could not load repositories.");
    }
    repository.innerHTML = '<option value="">Select a repository</option>';
    for (const repo of data.repositories) {
      const option = document.createElement("option");
      option.value = repo.name;
      option.textContent = repo.name + (repo.private ? " 🔒" : "");
      repository.appendChild(option);
    }
    if (!data.repositories.length) {
      repoError.textContent = "No accessible repositories were found for this GitHub token.";
    }
  } catch (error) {
    repository.innerHTML = '<option value="">Could not load repositories</option>';
    repoError.textContent = error.message;
  }
}

async function checkSession() {
  const response = await fetch("/api/status", { credentials: "include", cache: "no-store", headers: authHeaders() });
  const data = await response.json();
  showApp(data.authenticated);
  if (data.authenticated && data.repositories) loadRepositories(data.repositories);
}

loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  loginError.textContent = "";
  const response = await fetch("/api/login", {
    credentials: "include",
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password: password.value })
  });
  const data = await response.json();
  if (!response.ok) {
    loginError.textContent = data.error || "Login failed.";
    return;
  }
  authToken = data.authToken || "";
  if (authToken) sessionStorage.setItem("zip_to_git_auth", authToken);
  password.value = "";

  const statusResponse = await fetch("/api/status", {
    credentials: "include",
    cache: "no-store",
    headers: authHeaders()
  });
  const statusData = await statusResponse.json();
  if (!statusData.authenticated) {
    loginError.textContent = "Login succeeded, but authentication could not be established. Please try again.";
    authToken = "";
    sessionStorage.removeItem("zip_to_git_auth");
    showApp(false);
    return;
  }
  showApp(true);
});

$("logout").addEventListener("click", async () => {
  await fetch("/api/logout", { method: "POST", credentials: "include", headers: authHeaders() });
  authToken = "";
  sessionStorage.removeItem("zip_to_git_auth");
  showApp(false);
});

zip.addEventListener("change", () => {
  fileName.textContent = zip.files[0]?.name || "Choose a ZIP file";
});

uploadForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const file = zip.files[0];
  const selectedRepo = repository.value;
  if (!selectedRepo) { repoError.textContent = "Please select a repository."; return; }
  if (!file) return;

  repoError.textContent = "";
  result.className = "result hidden";
  progress.classList.remove("hidden");
  barFill.style.width = "0%";
  progressText.textContent = "Starting upload…";
  uploadButton.disabled = true;

  const CHUNK_SIZE = 2 * 1024 * 1024;

  try {
    const startResponse = await fetch("/api/upload/start", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify({
        fileName: file.name,
        fileSize: file.size,
        totalChunks: Math.ceil(file.size / CHUNK_SIZE),
        repository: selectedRepo
      })
    });
    const startData = await startResponse.json();
    if (!startResponse.ok) throw new Error(startData.error || "Could not start upload.");

    for (let index = 0; index < startData.totalChunks; index++) {
      const chunk = file.slice(index * CHUNK_SIZE, Math.min(file.size, (index + 1) * CHUNK_SIZE));
      let attempts = 0;
      while (true) {
        try {
          const formData = new FormData();
          formData.append("uploadId", startData.uploadId);
          formData.append("index", String(index));
          formData.append("chunk", chunk, file.name);

          const response = await fetch("/api/upload/chunk", {
            method: "POST",
            credentials: "include",
            headers: authHeaders(),
            body: formData
          });
          const data = await response.json();
          if (!response.ok) throw new Error(data.error || "Chunk upload failed.");

          const percent = Math.round(((index + 1) / startData.totalChunks) * 100);
          barFill.style.width = percent + "%";
          progressText.textContent = `Uploading ZIP… ${percent}%`;
          break;
        } catch (error) {
          attempts++;
          if (attempts >= 3) throw error;
          progressText.textContent = `Retrying chunk ${index + 1}…`;
          await new Promise(resolve => setTimeout(resolve, attempts * 1000));
        }
      }
    }

    progressText.textContent = "Upload received. Processing…";
    const completeResponse = await fetch("/api/upload/complete", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify({ uploadId: startData.uploadId })
    });
    const completeData = await completeResponse.json();
    if (!completeResponse.ok) throw new Error(completeData.error || "Could not finish upload.");

    let statusData;
    do {
      await new Promise(resolve => setTimeout(resolve, 1500));
      const statusResponse = await fetch(`/api/upload/status/${encodeURIComponent(completeData.jobId)}`, {
        credentials: "include", cache: "no-store", headers: authHeaders()
      });
      statusData = await statusResponse.json();
      if (!statusResponse.ok) throw new Error(statusData.error || "Could not check upload status.");
      if (statusData.status === "processing") progressText.textContent = "Extracting and committing to GitHub…";
    } while (statusData.status === "queued" || statusData.status === "processing");

    if (statusData.status !== "completed") throw new Error(statusData.error || "Upload failed.");

    barFill.style.width = "100%";
    result.className = "result success";
    result.classList.remove("hidden");
    result.textContent = `✅ ${statusData.result.message}\n\nFiles: ${statusData.result.files}\nRepository: ${statusData.result.repository}\nBranch: ${statusData.result.branch}\nCommit: ${statusData.result.commitSha}`;
    uploadForm.reset();
    fileName.textContent = "Choose a ZIP file";
  } catch (error) {
    result.className = "result fail";
    result.classList.remove("hidden");
    result.textContent = `❌ ${error.message || "Upload failed."}`;
  } finally {
    uploadButton.disabled = false;
    progress.classList.add("hidden");
  }
});

checkSession();