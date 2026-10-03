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

const app = express();
const PORT = process.env.PORT || 3000;

const required = ["APP_PASSWORD", "GITHUB_TOKEN", "GITHUB_OWNER", "GITHUB_REPO"];
for (const key of required) {
  if (!process.env[key]) {
    console.error(`Missing required environment variable: ${key}`);
    process.exit(1);
  }
}

const branch = process.env.GITHUB_BRANCH || "main";
const maxZipSize = Number(process.env.MAX_ZIP_SIZE || 50 * 1024 * 1024);
const sessionSecret = process.env.SESSION_SECRET || crypto.randomBytes(32).toString("hex");

const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });

app.disable("x-powered-by");
app.use(express.json({ limit: "100kb" }));
app.use(cookieSession({
  name: "zip_to_git_session",
  keys: [sessionSecret],
  httpOnly: true,
  sameSite: "lax",
  secure: process.env.NODE_ENV === "production",
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

function requireAuth(req, res, next) {
  if (req.session && req.session.authenticated === true) return next();
  return res.status(401).json({ error: "Unauthorized" });
}

function safeZipPath(input) {
  const normalized = input.replace(/\\/g, "/");
  if (!normalized || normalized.endsWith("/")) return null;
  if (normalized.includes("\0")) throw new Error("Invalid ZIP path.");
  const clean = path.posix.normalize(normalized);
  if (clean === "." || clean.startsWith("../") || clean.includes("/../") || clean.startsWith("/")) {
    throw new Error("Unsafe ZIP path detected.");
  }
  return clean;
}

async function extractZip(buffer, destination) {
  await fsp.mkdir(destination, { recursive: true });
  const directory = await unzipper.Open.buffer(buffer);
  const files = [];

  for (const entry of directory.files) {
    const relative = safeZipPath(entry.path);
    if (!relative) continue;

    const target = path.join(destination, relative);
    const resolved = path.resolve(target);
    const root = path.resolve(destination) + path.sep;
    if (!resolved.startsWith(root)) throw new Error("Unsafe ZIP path detected.");

    await fsp.mkdir(path.dirname(resolved), { recursive: true });
    await entry.stream().pipe(require("fs").createWriteStream(resolved));
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

async function getBranchState() {
  const ref = await octokit.rest.git.getRef({
    owner: process.env.GITHUB_OWNER,
    repo: process.env.GITHUB_REPO,
    ref: `heads/${branch}`
  });
  const commitSha = ref.data.object.sha;

  const commit = await octokit.rest.git.getCommit({
    owner: process.env.GITHUB_OWNER,
    repo: process.env.GITHUB_REPO,
    commit_sha: commitSha
  });

  return { commitSha, treeSha: commit.data.tree.sha };
}

async function uploadFilesToGitHub(files, message) {
  const { commitSha, treeSha } = await getBranchState();

  const treeItems = [];
  for (const file of files) {
    const data = await fsp.readFile(file.absolute);
    const blob = await octokit.rest.git.createBlob({
      owner: process.env.GITHUB_OWNER,
      repo: process.env.GITHUB_REPO,
      content: data.toString("base64"),
      encoding: "base64"
    });

    treeItems.push({
      path: file.path,
      mode: "100644",
      type: "blob",
      sha: blob.data.sha
    });
  }

  const tree = await octokit.rest.git.createTree({
    owner: process.env.GITHUB_OWNER,
    repo: process.env.GITHUB_REPO,
    base_tree: treeSha,
    tree: treeItems
  });

  const commit = await octokit.rest.git.createCommit({
    owner: process.env.GITHUB_OWNER,
    repo: process.env.GITHUB_REPO,
    message,
    tree: tree.data.sha,
    parents: [commitSha]
  });

  await octokit.rest.git.updateRef({
    owner: process.env.GITHUB_OWNER,
    repo: process.env.GITHUB_REPO,
    ref: `heads/${branch}`,
    sha: commit.data.sha,
    force: false
  });

  return commit.data.sha;
}

app.get("/api/status", (req, res) => {
  res.json({ authenticated: req.session?.authenticated === true });
});

app.post("/api/login", loginLimiter, (req, res) => {
  const password = typeof req.body?.password === "string" ? req.body.password : "";
  const expected = Buffer.from(process.env.APP_PASSWORD);
  const actual = Buffer.from(password);

  const valid = actual.length === expected.length &&
    crypto.timingSafeEqual(actual, expected);

  if (!valid) return res.status(401).json({ error: "Incorrect password." });

  req.session.authenticated = true;
  res.json({ ok: true });
});

app.post("/api/logout", (req, res) => {
  req.session = null;
  res.json({ ok: true });
});

app.post("/api/upload", requireAuth, uploadLimiter, upload.single("zip"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "Please select a ZIP file." });

  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "zip-to-git-"));

  try {
    const files = await extractZip(req.file.buffer, tempDir);
    const safeFiles = await walkFiles(tempDir);

    if (!safeFiles.length) {
      return res.status(400).json({ error: "The ZIP file contains no files." });
    }

    if (safeFiles.length > 1000) {
      return res.status(400).json({ error: "ZIP contains too many files (maximum 1000)." });
    }

    const commitMessage = `Upload ZIP: ${req.file.originalname}`;
    const commitSha = await uploadFilesToGitHub(safeFiles, commitMessage);

    res.json({
      ok: true,
      message: "Upload completed successfully.",
      files: safeFiles.length,
      commitSha,
      repository: `${process.env.GITHUB_OWNER}/${process.env.GITHUB_REPO}`,
      branch
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

app.listen(PORT, () => {
  console.log(`zip-to-git listening on port ${PORT}`);
});