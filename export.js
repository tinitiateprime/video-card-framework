// export.js
// Requires: node + playwright + ffmpeg installed (ffmpeg in PATH)

const { chromium } = require("playwright");
const path = require("path");
const fs = require("fs");
const { spawnSync } = require("child_process");

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function toMp4Name(name, format) {
  if (!name) return `deck-${format}-${Date.now()}.mp4`;
  return name.toLowerCase().endsWith(".mp4") ? name : `${name}.mp4`;
}

function getFlag(name, fallback = null) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (!hit) return fallback;
  return hit.split("=").slice(1).join("=");
}

function runFfmpeg(webmPath, mp4Path, outW, outH) {
  // ✅ Downscale with Lanczos for crisp text
  const vf = `fps=30,scale=${outW}:${outH}:flags=lanczos,format=yuv420p`;

  const args = [
    "-y",
    "-i", webmPath,
    "-vf", vf,
    "-c:v", "libx264",
    "-profile:v", "high",
    "-level", "4.2",
    "-crf", "16",            // ✅ higher quality (lower = better)
    "-preset", "slow",       // ✅ better quality
    "-movflags", "+faststart",
    "-an",
    mp4Path,
  ];

  const res = spawnSync("ffmpeg", args, { stdio: "inherit" });
  if (res.error) throw new Error(`FFmpeg failed: ${res.error.message}`);
  if (res.status !== 0) throw new Error(`FFmpeg exited with code ${res.status}`);
}

(async () => {
  try {
    const format = process.argv[2] || "vertical";
    const baseUrl = process.argv[3] || process.env.DECK_URL || "http://localhost:5500";
    const outArg = process.argv[4];
    const clean = process.argv.includes("--clean");

    const start = getFlag("start", "0");
    const dir = getFlag("dir", "auto");
    const fx = getFlag("fx", "none");

    const outDir = path.join(process.cwd(), "recordings");
    ensureDir(outDir);

    // ✅ Final output resolution
    const OUT =
      format === "vertical"
        ? { w: 1080, h: 1920 }
        : { w: 1920, h: 1080 };

    // ✅ Record at 2x resolution to make text sharper
    const SCALE = 2;
    const CAPTURE =
      format === "vertical"
        ? { w: OUT.w * SCALE, h: OUT.h * SCALE }
        : { w: OUT.w * SCALE, h: OUT.h * SCALE };

    const exportUrl =
      baseUrl.replace(/\/$/, "") +
      `/export.html?export=1` +
      `&format=${encodeURIComponent(format)}` +
      `&start=${encodeURIComponent(start)}` +
      `&dir=${encodeURIComponent(dir)}` +
      `&fx=${encodeURIComponent(fx)}`;

    const browser = await chromium.launch();
    const context = await browser.newContext({
      viewport: { width: CAPTURE.w, height: CAPTURE.h },
      deviceScaleFactor: 1, // keep 1; we already increased actual pixels
      recordVideo: {
        dir: outDir,
        size: { width: CAPTURE.w, height: CAPTURE.h },
      },
    });

    const page = await context.newPage();

    page.on("pageerror", (err) => console.error("PAGE ERROR:", err));
    page.on("console", (msg) => console.log("PAGE LOG:", msg.type(), msg.text()));

    await page.goto(exportUrl, { waitUntil: "networkidle" });

    // ✅ wait for init + images + DOM
    await page.waitForFunction(() => window.__APP_READY__ === true, null, { timeout: 120000 });
    await page.waitForFunction(() => window.__IMAGES_READY__ === true, null, { timeout: 120000 });
    await page.waitForFunction(() => document.querySelectorAll("#deck section.slide").length > 0, null, { timeout: 120000 });

    // Start autoplay (no UI click needed)
    await page.evaluate(() => {
      if (typeof window.startAutoplay === "function") window.startAutoplay();
      else document.querySelector("#playBtn")?.click();
    });

    // wait duration (no looping in export mode)
    const durationSeconds = await page.evaluate(() => {
      const s = window.slides || [];
      if (!Array.isArray(s) || !s.length) return 10;

      const qs = new URLSearchParams(location.search);
      const start = Math.max(0, Number(qs.get("start") || 0));

      let total = 0;
      for (let i = start; i < s.length; i++) total += (Number(s[i]?.duration) || 10);
      return total + 2.0;
    });

    await page.waitForTimeout(durationSeconds * 1000);

    const video = page.video();

    await page.close();
    await context.close();
    await browser.close();

    const webmPath = await video.path();

    const mp4Name = toMp4Name(outArg, format);
    const mp4Path = path.isAbsolute(mp4Name) ? mp4Name : path.join(outDir, mp4Name);

    console.log("\nWEBM saved:", webmPath);
    console.log("Converting to MP4...");

    runFfmpeg(webmPath, mp4Path, OUT.w, OUT.h);

    if (clean) {
      try { fs.unlinkSync(webmPath); } catch {}
    }

    console.log("\nDone ✅");
    console.log("MP4 saved:", mp4Path);
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
})();
