// server.js
// Local server + /api/export endpoint that runs Playwright+FFmpeg export.

const express = require("express");
const path = require("path");
const fs = require("fs");
const { spawn } = require("child_process");

const app = express();
const PORT = Number(process.env.PORT || 5500);
const ROOT = process.cwd();

const RECORDINGS_DIR = path.join(ROOT, "recordings");
if (!fs.existsSync(RECORDINGS_DIR)) fs.mkdirSync(RECORDINGS_DIR, { recursive: true });

app.use(express.json({ limit: "1mb" }));

// serve recordings
app.use("/recordings", express.static(RECORDINGS_DIR));
// serve app
app.use(express.static(ROOT, { extensions: ["html"] }));

let busy = false;

function safeMp4Name(name, format) {
  let base = (name || "").trim();
  if (!base) base = `deck-${format}-${Date.now()}.mp4`;
  base = base.replace(/[\/\\]/g, "");
  base = base.replace(/[^a-zA-Z0-9._-]/g, "-");
  if (!base.toLowerCase().endsWith(".mp4")) base += ".mp4";
  return base;
}

function newestMp4() {
  const files = fs
    .readdirSync(RECORDINGS_DIR)
    .filter((f) => f.toLowerCase().endsWith(".mp4"))
    .map((f) => ({ f, t: fs.statSync(path.join(RECORDINGS_DIR, f)).mtimeMs }))
    .sort((a, b) => b.t - a.t);
  return files[0]?.f || null;
}

app.post("/api/export", (req, res) => {
  if (busy) {
    return res.status(409).json({ ok: false, error: "An export is already running." });
  }
  busy = true;

  const formatRaw = (req.body?.format || "vertical").toString();
  const format = formatRaw === "horizontal" ? "horizontal" : "vertical";

  const startSlide = Number.isFinite(Number(req.body?.startSlide))
    ? Math.max(0, Math.floor(Number(req.body.startSlide)))
    : 0;

  const dirRaw = (req.body?.dir || "auto").toString();
  const dir = ["auto", "td", "bu", "lr", "rl"].includes(dirRaw) ? dirRaw : "auto";

  const fxRaw = (req.body?.fx || "none").toString();
  const fx = ["none", "zoomIn", "zoomOut"].includes(fxRaw) ? fxRaw : "none";

  const mp4Name = safeMp4Name(req.body?.name, format);

  const args = [
    path.join(ROOT, "export.js"),
    format,
    `http://127.0.0.1:${PORT}`,
    mp4Name,
    "--clean",
    `--start=${startSlide}`,
    `--dir=${dir}`,
    `--fx=${fx}`,
  ];

  const child = spawn(process.execPath, args, { stdio: "inherit" });

  child.on("close", (code) => {
    busy = false;

    if (code !== 0) {
      return res.status(500).json({ ok: false, error: `Export failed with exit code ${code}` });
    }

    const file = fs.existsSync(path.join(RECORDINGS_DIR, mp4Name)) ? mp4Name : newestMp4();
    if (!file) {
      return res.status(500).json({ ok: false, error: "Export finished, but MP4 was not found." });
    }

    return res.json({ ok: true, fileName: file, downloadUrl: `/recordings/${file}` });
  });
});

app.listen(PORT, () => {
  console.log(`✅ Server running at http://localhost:${PORT}`);
  console.log(`✅ Export endpoint: POST http://localhost:${PORT}/api/export`);
});
