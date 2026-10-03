const express = require("express");
const multer = require("multer");
const cookieSession = require("cookie-session");
const rateLimit = require("express-rate-limit");
const unzipper = require("unzipper");
const { Octokit } = require("@octokit/rest");
const fs = require("fs");
const fsp = fs.promises;
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { execFile } = require("child_process");
const { promisify } = require("util");
const execFileAsync = promisify(execFile);
const { pipeline } = require("stream/promises");

const app = express();
const PORT = process.env.PORT || 3000;

const required = ["APP_PASSWORD", "GITHUB_TOKEN", "GITHUB_OWNER"];
for (const key of required) {
  if (!process.env[key]) {
    console.error(`Missing required environment variable: ${key}`);
    process.exit(1);
  }
}

const fallbackRepo = process.env.GITHUB_REPO || "";
const fallbackBranch = process.env.GITHUB_BRANCH || "";
const maxZipSize = Number(process.env.MAX_ZIP_SIZE || 50 * 1024 * 1024);
const maxFiles = Number(process.env.MAX_FILES || 10000);
const sessionSecret = process.env.SESSION_SECRET || crypto.randomBytes(32).toString("hex");

const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });
const authTokens = new Map();

app.disable("x-powered-by");
app.set("trust proxy", 1);
app.use(express.json({ limit: "100kb" }));
app.use(cookieSession({
  name: "zip_to_git_session",
  keys: [sessionSecret],
  httpOnly: true,
  sameSite: "lax",
  secure: process.env.NODE_ENV === "production",
  path: "/",
  maxAge: 1000 * 60 * 60 * 12
}));

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many login attempts. Try again later." }
});

const uploadLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many uploads. Try again later." }
});

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: maxZipSize, files: 1 },
  fileFilter: (_req, file, cb) => {
    const ok = file.originalname.toLowerCase().endsWith(".zip");
    cb(ok ? null : new Error("Only .zip files are allowed."));
  }
});

app.use(express.static(path.join(__dirname, "public")));

function getBearerToken(req) {
  const header = req.get("authorization") || "";
  return header.startsWith("Bearer ") ? header.slice(7).trim() : "";
}

function requireAuth(req, res, next) {
  const bearer = getBearerToken(req);
  if (bearer && authTokens.has(bearer)) {
    req.authToken = bearer;
    return next();
  }
  if (req.session && req.session.authenticated === true) return next();
  return res.status(401).json({ error: "Unauthorized" });
}

function safeZipPath(input) {
  const normalized = input.replace(/\\/g, "/");
  if (!normalized || normalized.endsWith("/")) return null;
  if (normalized.includes("\0")) throw new Error("Invalid ZIP path.");
  const clean = path.posix.normalize(normalized);
  if (clean === "." || clean.startsWith("../") || clean.includes("/../") || clean.startsWith("/") ||
      clean === ".git" || clean.startsWith(".git/")) {
    throw new Error("Unsafe ZIP path detected.");
  }
  return clean;
}

async function extractZip(buffer, destination) {
  await fsp.mkdir(destination, { recursive: true });
  const directory = await unzipper.Open.buffer(buffer);
  const files = [];

  // If the ZIP has one common top-level folder, strip that folder so its
  // contents are uploaded directly to the repository root.
  const entryPaths = directory.files
    .map((entry) => entry.path.replace(/\\/g, "/"))
    .filter((entry) => entry && !entry.endsWith("/"));
  const firstParts = entryPaths.map((entry) => entry.split("/")[0]);
  const commonRoot = firstParts.length && firstParts.every((part) => part === firstParts[0])
    ? firstParts[0]
    : "";

  for (const entry of directory.files) {
    const rawPath = entry.path.replace(/\\/g, "/");
    const strippedPath = commonRoot && rawPath.startsWith(commonRoot + "/")
      ? rawPath.slice(commonRoot.length + 1)
      : rawPath;
    const relative = safeZipPath(strippedPath);
    if (!relative) continue;

    const target = path.join(destination, relative);
    const resolved = path.resolve(target);
    const root = path.resolve(destination) + path.sep;
    if (!resolved.startsWith(root)) throw new Error("Unsafe ZIP path detected.");

    await fsp.mkdir(path.dirname(resolved), { recursive: true });
    const output = require("fs").createWriteStream(resolved);
    await pipeline(entry.stream(), output);
    files.push({ path: relative, absolute: resolved });
  }

  return files;
}

async function walkFiles(root) {
  const result = [];
  async function walk(current, prefix = "") {
    const entries = await fsp.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(full, rel);
      else if (entry.isFile()) result.push({ path: rel, absolute: full });
    }
  }
  await walk(root);
  return result;
}

function normalizeRepoName(value) {
  if (typeof value !== "string") return "";
  const repo = value.trim();
  return /^[A-Za-z0-9._-]+$/.test(repo) ? repo : "";
}

async function getAllowedRepositories() {
  const repos = [];
  for (let page = 1; page <= 10; page++) {
    const response = await octokit.rest.repos.listForAuthenticatedUser({
      per_page: 100,
      page,
      affiliation: "owner,collaborator,organization_member",
      sort: "full_name",
      direction: "asc"
    });
    repos.push(...response.data);
    if (response.data.length < 100) break;
  }
  return repos
    .filter((repo) => repo.owner?.login === process.env.GITHUB_OWNER && !repo.archived)
    .map((repo) => ({
      name: repo.name,
      fullName: repo.full_name,
      private: repo.private,
      defaultBranch: repo.default_branch || "main"
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

async function getTargetRepo(repoName) {
  const repo = normalizeRepoName(repoName) || normalizeRepoName(fallbackRepo);
  if (!repo) throw new Error("Please select a repository.");

  const response = await octokit.rest.repos.get({
    owner: process.env.GITHUB_OWNER,
    repo
  });

  if (response.data.owner?.login !== process.env.GITHUB_OWNER) {
    throw new Error("Selected repository is not allowed.");
  }

  return {
    owner: process.env.GITHUB_OWNER,
    repo,
    branch: fallbackRepo === repo && fallbackBranch
      ? fallbackBranch
      : (response.data.default_branch || "main")
  };
}

async function getBranchState(target) {
  const ref = await octokit.rest.git.getRef({
    owner: target.owner,
    repo: target.repo,
    ref: `heads/${target.branch}`
  });
  const commitSha = ref.data.object.sha;

  const commit = await octokit.rest.git.getCommit({
    owner: target.owner,
    repo: target.repo,
    commit_sha: commitSha
  });

  return { commitSha, treeSha: commit.data.tree.sha };
}

async function runGit(args, cwd, env) {
  const result = await execFileAsync("git", args, {
    cwd,
    env,
    maxBuffer: 10 * 1024 * 1024,
    timeout: 10 * 60 * 1000
  });
  return result;
}

async function uploadFilesToGitHub(files, message, target) {
  const workDir = await fsp.mkdtemp(path.join(os.tmpdir(), "zip-to-git-repo-"));
  const askPass = path.join(workDir, "askpass.sh");

  try {
    await fsp.writeFile(
      askPass,
      '#!/bin/sh\ncase "$1" in *Username*) printf "%s\\n" "x-access-token" ;; *) printf "%s\\n" "$GITHUB_TOKEN" ;; esac\n',
      { mode: 0o700 }
    );

    const gitEnv = {
      ...process.env,
      GIT_ASKPASS: askPass,
      GIT_TERMINAL_PROMPT: "0"
    };

    const remote = `https://github.com/${target.owner}/${target.repo}.git`;
    const repoDir = path.join(workDir, "repo");

    await runGit(
      ["clone", "--depth", "1", "--branch", target.branch, remote, repoDir],
      workDir,
      gitEnv
    );

    const gitDir = path.join(repoDir, ".git");
    for (const file of files) {
      const destination = path.join(repoDir, file.path);
      await fsp.mkdir(path.dirname(destination), { recursive: true });
      await fsp.copyFile(file.absolute, destination);
    }

    await runGit(["config", "user.name", "ZIP to GitHub"], repoDir, gitEnv);
    await runGit(["config", "user.email", "zip-to-github@users.noreply.github.com"], repoDir, gitEnv);
    await runGit(["add", "-A"], repoDir, gitEnv);

    const status = await runGit(["status", "--porcelain"], repoDir, gitEnv);
    if (!status.stdout.trim()) {
      const head = await runGit(["rev-parse", "HEAD"], repoDir, gitEnv);
      return head.stdout.trim();
    }

    await runGit(["commit", "-m", message], repoDir, gitEnv);
    await runGit(["push", "origin", `HEAD:${target.branch}`], repoDir, gitEnv);

    const head = await runGit(["rev-parse", "HEAD"], repoDir, gitEnv);
    return head.stdout.trim();
  } finally {
    await fsp.rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

const CHUNK_SIZE = 2 * 1024 * 1024; // chunked upload
const chunkUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: CHUNK_SIZE, files: 1 }
});
const activeUploads = new Map();
const jobs = new Map();

async function processArchive(job) {
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "zip-to-git-job-"));
  try {
    job.status = "processing";
    const archivePath = path.join(tempDir, "upload.zip");
    const extractDir = path.join(tempDir, "extracted");
    for (let i = 0; i < job.totalChunks; i++) {
      await fsp.appendFile(archivePath, await fsp.readFile(path.join(job.uploadDir, `chunk-${i}`)));
    }
    await extractZip(await fsp.readFile(archivePath), extractDir);
    const safeFiles = await walkFiles(extractDir);
    if (!safeFiles.length) throw new Error("The ZIP file contains no files.");
    if (safeFiles.length > maxFiles) throw new Error(`ZIP contains too many files (maximum ${maxFiles}).`);
    job.progress = 15;
    const commitSha = await uploadFilesToGitHub(safeFiles, `Upload ZIP: ${job.originalName}`, job.target);
    job.status = "completed";
    job.progress = 100;
    job.result = {
      ok: true,
      message: "Upload completed successfully.",
      files: safeFiles.length,
      commitSha,
      repository: `${job.target.owner}/${job.target.repo}`,
      branch: job.target.branch
    };
  } catch (error) {
    console.error("Upload job failed:", error);
    job.status = "failed";
    job.error = error?.message || "Upload failed.";
  } finally {
    await fsp.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    await fsp.rm(job.uploadDir, { recursive: true, force: true }).catch(() => {});
    activeUploads.delete(job.uploadId);
  }
}

app.post("/api/upload/start", requireAuth, async (req, res) => {
  try {
    const fileName = typeof req.body?.fileName === "string" ? req.body.fileName : "";
    const fileSize = Number(req.body?.fileSize);
    const totalChunks = Number(req.body?.totalChunks);
    if (!fileName.toLowerCase().endsWith(".zip")) return res.status(400).json({ error: "Only .zip files are allowed." });
    if (!Number.isSafeInteger(fileSize) || fileSize <= 0 || fileSize > maxZipSize) {
      return res.status(413).json({ error: `ZIP file is too large. Maximum ${Math.round(maxZipSize / 1024 / 1024)} MB.` });
    }
    if (!Number.isSafeInteger(totalChunks) || totalChunks < 1 || totalChunks > 1000) {
      return res.status(400).json({ error: "Invalid upload size." });
    }

    const target = await getTargetRepo(req.body?.repository);
    const uploadId = crypto.randomBytes(18).toString("hex");
    const uploadDir = await fsp.mkdtemp(path.join(os.tmpdir(), "zip-to-git-upload-"));
    activeUploads.set(uploadId, {
      uploadId,
      ownerToken: req.authToken || "",
      uploadDir,
      totalChunks,
      originalName: path.basename(fileName),
      target
    });
    res.json({ uploadId, chunkSize: CHUNK_SIZE, totalChunks });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error?.message || "Could not start upload." });
  }
});

app.post("/api/upload/chunk", requireAuth, chunkUpload.single("chunk"), async (req, res) => {
  try {
    const uploadId = typeof req.body?.uploadId === "string" ? req.body.uploadId : "";
    const index = Number(req.body?.index);
    const state = activeUploads.get(uploadId);
    if (!state || state.ownerToken !== (req.authToken || "")) return res.status(404).json({ error: "Upload session not found. Please start again." });
    if (!Number.isInteger(index) || index < 0 || index >= state.totalChunks) return res.status(400).json({ error: "Invalid chunk number." });
    if (!req.file) return res.status(400).json({ error: "Missing upload chunk." });
    await fsp.writeFile(path.join(state.uploadDir, `chunk-${index}`), req.file.buffer);
    res.json({ ok: true });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error?.message || "Chunk upload failed." });
  }
});

app.post("/api/upload/complete", requireAuth, async (req, res) => {
  try {
    const uploadId = typeof req.body?.uploadId === "string" ? req.body.uploadId : "";
    const state = activeUploads.get(uploadId);
    if (!state || state.ownerToken !== (req.authToken || "")) return res.status(404).json({ error: "Upload session not found. Please start again." });

    for (let i = 0; i < state.totalChunks; i++) {
      try { await fsp.access(path.join(state.uploadDir, `chunk-${i}`)); }
      catch { return res.status(400).json({ error: `Missing upload chunk ${i + 1} of ${state.totalChunks}.` }); }
    }

    const jobId = crypto.randomBytes(18).toString("hex");
    jobs.set(jobId, {
      jobId, uploadId, uploadDir: state.uploadDir, totalChunks: state.totalChunks,
      originalName: state.originalName, target: state.target, status: "queued", progress: 0
    });
    activeUploads.delete(uploadId);
    setImmediate(() => processArchive(jobs.get(jobId)));
    res.status(202).json({ ok: true, jobId });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error?.message || "Could not finish upload." });
  }
});

app.get("/api/upload/status/:jobId", requireAuth, (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: "Upload job not found." });
  res.json({ status: job.status, progress: job.progress || 0, result: job.result || null, error: job.error || null });
});
 
app.get("/api/repos", requireAuth, async (_req, res) => {
  try {
    res.json({ repositories: await getAllowedRepositories() });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Could not load repositories." });
  }
});

app.get("/api/status", async (req, res) => {
  const bearer = getBearerToken(req);
  const authenticated = (bearer && authTokens.has(bearer)) || req.session?.authenticated === true;
  if (!authenticated) return res.json({ authenticated: false });
  try {
    const repositories = await getAllowedRepositories();
    res.json({ authenticated: true, repositories });
  } catch (error) {
    console.error(error);
    res.status(500).json({ authenticated: true, error: "Could not load repositories." });
  }
});

app.post("/api/login", loginLimiter, (req, res) => {
  const password = typeof req.body?.password === "string" ? req.body.password : "";
  const expected = Buffer.from(process.env.APP_PASSWORD);
  const actual = Buffer.from(password);

  const valid = actual.length === expected.length &&
    crypto.timingSafeEqual(actual, expected);

  if (!valid) return res.status(401).json({ error: "Incorrect password." });

  req.session.authenticated = true;
  const authToken = crypto.randomBytes(32).toString("hex");
  authTokens.set(authToken, Date.now() + 1000 * 60 * 60 * 12);
  res.json({ ok: true, authToken });
});

app.post("/api/logout", (req, res) => {
  const bearer = getBearerToken(req);
  if (bearer) authTokens.delete(bearer);
  req.session = null;
  res.json({ ok: true });
});

app.post("/api/upload", requireAuth, uploadLimiter, upload.single("zip"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "Please select a ZIP file." });

  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "zip-to-git-"));

  try {
    const target = await getTargetRepo(req.body?.repository);
    await extractZip(req.file.buffer, tempDir);
    const safeFiles = await walkFiles(tempDir);

    if (!safeFiles.length) {
      return res.status(400).json({ error: "The ZIP file contains no files." });
    }

    if (safeFiles.length > 1000) {
      return res.status(400).json({ error: "ZIP contains too many files (maximum 1000)." });
    }

    const commitMessage = `Upload ZIP: ${req.file.originalname}`;
    const commitSha = await uploadFilesToGitHub(safeFiles, commitMessage, target);

    res.json({
      ok: true,
      message: "Upload completed successfully.",
      files: safeFiles.length,
      commitSha,
      repository: `${target.owner}/${target.repo}`,
      branch: target.branch
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({
      error: error?.message || "Upload failed."
    });
  } finally {
    await fsp.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
});

app.use((err, _req, res, _next) => {
  if (err instanceof multer.MulterError && err.code === "LIMIT_FILE_SIZE") {
    return res.status(413).json({ error: "ZIP file is too large." });
  }
  res.status(400).json({ error: err?.message || "Request failed." });
});

setInterval(() => {
  const now = Date.now();
  for (const [token, expiresAt] of authTokens) {
    if (expiresAt <= now) authTokens.delete(token);
  }
}, 15 * 60 * 1000).unref();

app.listen(PORT, () => {
  console.log(`zip-to-git listening on port ${PORT} (trust proxy enabled)`);
});