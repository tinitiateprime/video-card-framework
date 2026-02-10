// src/app.js

let CONFIG = null;
let formatKey = "vertical";

let slides = [];      // parsed slide objects (logical order)
let rawMarkdown = []; // raw markdown per slide (logical order)

let selectedSlideIndex = 0;

// autoplay
let isPlaying = false;
let playTimer = null;

// transitions
let TRANSITION = {
  dir: "auto",        // auto | td | bu | lr | rl
  fx: "none",         // none | zoomIn | zoomOut
  durationMs: 700,
  easing: "cubic-bezier(0.2, 0.8, 0.2, 1)"
};

let currentLogical = 0;
let scrollDebounce = null;

// prevents double-trigger when we navigate via code
let programmaticNav = false;

// ✅ Export mode flag (for fullscreen capture page)
const EXPORT_MODE =
  (typeof window !== "undefined" && window.__EXPORT_MODE__ === true) ||
  (typeof location !== "undefined" &&
    new URLSearchParams(location.search).get("export") === "1");

// elements
const formatSelect = document.getElementById("formatSelect");
const formatInfo = document.getElementById("formatInfo");

const transitionDir = document.getElementById("transitionDir");
const transitionFx = document.getElementById("transitionFx");

const slideTabs = document.getElementById("slideTabs");
const mdEditor = document.getElementById("mdEditor");
const limitWarning = document.getElementById("limitWarning");

const deck = document.getElementById("deck");
const frame = document.getElementById("frame");
const frameOuter = document.getElementById("frameOuter");

const countInfo = document.getElementById("countInfo");
const slidePos = document.getElementById("slidePos");

const playBtn = document.getElementById("playBtn");
const pauseBtn = document.getElementById("pauseBtn");
const restartBtn = document.getElementById("restartBtn");

// ✅ Export UI
const exportMp4Btn = document.getElementById("exportMp4Btn");
const exportNameInput = document.getElementById("exportName");
const exportStatus = document.getElementById("exportStatus");

// ----------------------------------------------------
// Helpers for consistent root-relative loading
// ----------------------------------------------------
function rootUrl(p) {
  return new URL(p, window.location.origin + "/").href;
}

function normalizeImageUrl(u) {
  if (!u) return null;
  u = u.trim();
  if (!u) return null;

  if (u.startsWith("<") && u.endsWith(">")) u = u.slice(1, -1).trim();
  if (/^https?:\/\//i.test(u)) return u;

  return rootUrl(u);
}

// -----------------------------
// Export helpers
// -----------------------------
function setExportStatus(html) {
  if (!exportStatus) return;
  exportStatus.innerHTML = html || "";
}

async function exportMp4FromCurrent() {
  if (!exportMp4Btn) return;

  exportMp4Btn.disabled = true;
  exportMp4Btn.classList.add("opacity-50");
  setExportStatus("⏳ Exporting MP4...");

  const name = (exportNameInput?.value || "").trim();

  // ✅ export should match current UI selections
  const payload = {
    format: formatKey,
    name,
    startSlide: 0,                 // export all slides from 0
    dir: TRANSITION.dir,
    fx: TRANSITION.fx
  };

  try {
    const res = await fetch("/api/export", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    const data = await res.json().catch(() => ({}));

    if (!res.ok || !data.ok) {
      const msg = data?.error || `Export failed (HTTP ${res.status})`;
      setExportStatus(`<span class="text-rose-300">❌ ${msg}</span>`);
      return;
    }

    setExportStatus(
      `✅ <a class="underline text-emerald-200 hover:text-emerald-100" href="${data.downloadUrl}" download>Download ${data.fileName}</a>`
    );
  } catch {
    setExportStatus(
      `<span class="text-rose-300">❌ /api/export not reachable. Run: <code>node server.js</code></span>`
    );
  } finally {
    exportMp4Btn.disabled = false;
    exportMp4Btn.classList.remove("opacity-50");
  }
}

// -----------------------------
// Markdown parsing helpers
// -----------------------------
function extractDurationSeconds(raw) {
  const m = raw.match(/^\s*Duration:\s*(\d+)\s*s\s*$/im);
  return m ? Number(m[1]) : 10;
}

function stripDurationLine(raw) {
  return raw.replace(/^\s*Duration:\s*\d+\s*s\s*$/im, "").trim();
}

function extractFirstImageUrl(raw) {
  // Markdown image: ![alt](url)
  let m = raw.match(/!\[[^\]]*\]\(([^)]+)\)/);
  if (m) return m[1].trim();

  // HTML img: <img src="...">
  m = raw.match(/<img[^>]+src=["']([^"']+)["'][^>]*>/i);
  if (m) return m[1].trim();

  return null;
}

function removeAllImages(md) {
  return md
    .replace(/!\[[^\]]*\]\([^)]+\)\s*/g, "")
    .replace(/<img[^>]*>\s*/gi, "")
    .trim();
}

function parseSlideMarkdown(rawMd) {
  const duration = extractDurationSeconds(rawMd);
  let md = stripDurationLine(rawMd);

  const imageUrl = normalizeImageUrl(extractFirstImageUrl(md));
  md = removeAllImages(md);

  const parts = md.split("\n---\n");
  const main = parts[0] || "";
  const footerMd = parts[1] || "";

  const lines = main.split("\n");
  let header = "";
  let body = main;

  const headerIdx = lines.findIndex((l) => /^#{1,6}\s+/.test(l.trim()));
  if (headerIdx !== -1) {
    header = lines[headerIdx].replace(/^#{1,6}\s+/, "").trim();
    body = lines.slice(headerIdx + 1).join("\n").trim();
  }

  return { duration, header, bodyMd: body, footerMd, imageUrl };
}

// -----------------------------
// Config / direction rules
// -----------------------------
function getCfg() {
  return CONFIG.formats[formatKey];
}

function getEffectiveDir() {
  const cfg = getCfg();
  if (TRANSITION.dir !== "auto") return TRANSITION.dir;
  return cfg.direction === "y" ? "bu" : "rl";
}

function getAxis() {
  const d = getEffectiveDir();
  return (d === "lr" || d === "rl") ? "x" : "y";
}

function isReverseFlow() {
  const d = getEffectiveDir();
  return d === "td" || d === "lr";
}

function fxClass() {
  if (TRANSITION.fx === "zoomIn") return "fx-zi";
  if (TRANSITION.fx === "zoomOut") return "fx-zo";
  return "fx-none";
}

function formatTextLimitsInfo() {
  if (!formatInfo) return;
  const cfg = getCfg();
  const axis = getAxis();
  const d = getEffectiveDir();

  formatInfo.textContent =
    `${cfg.label} • Resolution: ${cfg.resolution} • Axis: ${axis.toUpperCase()} • ` +
    `Dir: ${d.toUpperCase()} • Effect: ${TRANSITION.fx} • ` +
    `Text limits: Header ≤ ${cfg.headerMax}, Body ≤ ${cfg.bodyMax}, Footer ≤ ${cfg.footerMax}`;
}

function validateLimits(s) {
  if (!limitWarning) return;
  const cfg = getCfg();
  const headerLen = (s.header || "").length;
  const bodyLen = (s.bodyMd || "").length;
  const footerLen = (s.footerMd || "").length;

  const issues = [];
  if (headerLen > cfg.headerMax) issues.push(`Header is ${headerLen} chars (limit ${cfg.headerMax}).`);
  if (bodyLen > cfg.bodyMax) issues.push(`Body is ${bodyLen} chars (limit ${cfg.bodyMax}).`);
  if (footerLen > cfg.footerMax) issues.push(`Footer is ${footerLen} chars (limit ${cfg.footerMax}).`);

  if (issues.length) {
    limitWarning.classList.remove("hidden");
    limitWarning.innerHTML =
      `<div class="font-semibold mb-1">Text limit warnings for ${cfg.label}</div>` +
      `<ul class="list-disc pl-5">${issues.map((x) => `<li>${x}</li>`).join("")}</ul>`;
  } else {
    limitWarning.classList.add("hidden");
    limitWarning.innerHTML = "";
  }
}

function buildFormatDropdown() {
  if (!formatSelect) return;
  formatSelect.innerHTML = "";
  Object.keys(CONFIG.formats).forEach((key) => {
    const opt = document.createElement("option");
    opt.value = key;
    opt.textContent = CONFIG.formats[key].label;
    formatSelect.appendChild(opt);
  });
  formatSelect.value = formatKey;
}

// Responsive sizing
function setFrameAspect() {
  const axis = getAxis();

  // ✅ Export mode = FULLSCREEN
  if (EXPORT_MODE) {
    if (frame) {
      frame.style.width = "100vw";
      frame.style.height = "100vh";
    }
    if (deck) {
      deck.classList.remove("deck-y", "deck-x", "reverse");
      deck.classList.add(axis === "y" ? "deck-y" : "deck-x");
      if (isReverseFlow()) deck.classList.add("reverse");
      deck.style.height = "100%";
      deck.style.width = "100%";
    }
    return;
  }

  const cfg = getCfg();
  const maxW = Math.max(280, Math.floor((frameOuter?.clientWidth || 700) - 24));
  const baseMaxH = Math.floor(window.innerHeight * 0.62);
  const maxH = formatKey === "vertical" ? Math.floor(baseMaxH * 0.85) : baseMaxH;

  let w = maxW;
  let h = Math.round((w * cfg.aspectH) / cfg.aspectW);

  if (h > maxH) {
    h = maxH;
    w = Math.round((h * cfg.aspectW) / cfg.aspectH);
  }

  if (frame) {
    frame.style.width = w + "px";
    frame.style.height = h + "px";
  }

  if (deck) {
    deck.classList.remove("deck-y", "deck-x", "reverse");
    deck.classList.add(axis === "y" ? "deck-y" : "deck-x");
    if (isReverseFlow()) deck.classList.add("reverse");
    deck.style.height = "100%";
    deck.style.width = "100%";
  }
}

// -----------------------------
// Tabs / editor
// -----------------------------
function buildTabs() {
  if (!slideTabs) return;
  slideTabs.innerHTML = "";
  slides.forEach((_, i) => {
    const btn = document.createElement("button");
    btn.className =
      "rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm hover:bg-white/10 " +
      (i === selectedSlideIndex ? "ring-2 ring-white/20" : "");
    btn.textContent = `Slide ${i + 1}`;
    btn.addEventListener("click", () => {
      selectedSlideIndex = i;
      syncEditorFromSlide();
      buildTabs();
      goToSlide(i, { behavior: "smooth", animate: true });
    });
    slideTabs.appendChild(btn);
  });

  if (countInfo) countInfo.textContent = `${slides.length} slides`;
}

function syncEditorFromSlide() {
  if (mdEditor) mdEditor.value = rawMarkdown[selectedSlideIndex] || "";
  validateLimits(slides[selectedSlideIndex]);
}

function updateSlidePos(logical) {
  if (!slidePos) return;
  slidePos.textContent = `Slide ${logical + 1} / ${slides.length}`;
}

// -----------------------------
// Deck render (export-safe classes)
// -----------------------------
let activeObserver = null;

function renderDeck() {
  const reverse = isReverseFlow();
  if (!deck) return;

  deck.innerHTML = "";

  const order = reverse
    ? [...slides].map((_, i) => slides.length - 1 - i)
    : [...slides].map((_, i) => i);

  for (const logicalIdx of order) {
    const s = slides[logicalIdx];

    const slideEl = document.createElement("section");
    slideEl.className = "slide";
    slideEl.dataset.logical = String(logicalIdx);

    // ✅ IMPORTANT for horizontal mode (deck-x is flex)
    slideEl.style.width = "100%";
    slideEl.style.height = "100%";
    slideEl.style.flex = "0 0 100%";
    slideEl.style.flexShrink = "0";

    const inner = document.createElement("div");
    inner.className = "slide-inner";
    inner.style.position = "relative";
    inner.style.width = "100%";
    inner.style.height = "100%";

    const motion = document.createElement("div");
    motion.className = "slide-motion";

    const bg = document.createElement("div");
    bg.className = "slide-bg";
    if (s.imageUrl) {
      bg.style.backgroundImage = `url("${s.imageUrl}")`;
    } else {
      bg.style.backgroundImage =
        "radial-gradient(circle at 30% 20%, rgba(255,255,255,0.12), transparent 50%)," +
        "radial-gradient(circle at 70% 80%, rgba(255,255,255,0.10), transparent 55%)," +
        "linear-gradient(135deg, rgba(255,255,255,0.06), rgba(255,255,255,0.02))";
    }
    motion.appendChild(bg);

    const overlay = document.createElement("div");
    overlay.className = "slide-overlay";
    motion.appendChild(overlay);

    const cfg = getCfg();
    const content = document.createElement("div");
    content.className = `slide-content ${cfg.safePadClass}`;

    const header = document.createElement("div");
    header.className = "slide-title";
    header.textContent = s.header || `Slide ${logicalIdx + 1}`;
    content.appendChild(header);

    const body = document.createElement("div");
    body.className = `slide-body ${formatKey === "vertical" ? "vertical" : "horizontal"}`;
    body.innerHTML = marked.parse(s.bodyMd || "");
    content.appendChild(body);

    const footer = document.createElement("div");
    footer.className = "slide-footer";
    footer.innerHTML = marked.parseInline(s.footerMd || "");
    content.appendChild(footer);

    motion.appendChild(content);
    inner.appendChild(motion);
    slideEl.appendChild(inner);
    deck.appendChild(slideEl);
  }

  setupActiveObserver();
  updateSlidePos(currentLogical);
}

function getSlideElByLogical(logical) {
  if (!deck) return null;
  return deck.querySelector(`section.slide[data-logical="${logical}"]`);
}

function getCurrentLogicalIndex() {
  const axis = getAxis();
  const children = deck ? Array.from(deck.children) : [];
  if (!children.length) return 0;

  let bestEl = children[0];
  let bestDist = Infinity;

  if (axis === "y") {
    const y = deck.scrollTop;
    children.forEach((el) => {
      const d = Math.abs(el.offsetTop - y);
      if (d < bestDist) {
        bestDist = d;
        bestEl = el;
      }
    });
  } else {
    const x = deck.scrollLeft;
    children.forEach((el) => {
      const d = Math.abs(el.offsetLeft - x);
      if (d < bestDist) {
        bestDist = d;
        bestEl = el;
      }
    });
  }

  return Number(bestEl.dataset.logical || 0);
}

// ✅ This is the KEY FIX:
// Autoplay must explicitly trigger direction + effect animation.
// We ALWAYS apply anim-enter (even when fx is "none") so direction works too.
function animateEnter(slideEl) {
  if (!slideEl) return;

  const d = getEffectiveDir();
  const fx = fxClass();

  slideEl.style.setProperty("--tDur", `${TRANSITION.durationMs}ms`);
  slideEl.style.setProperty("--tEase", TRANSITION.easing);

  slideEl.classList.remove(
    "anim-enter",
    "dir-td", "dir-bu", "dir-lr", "dir-rl",
    "fx-none", "fx-zi", "fx-zo"
  );

  // Trigger animation
  slideEl.classList.add("anim-enter", `dir-${d}`, fx);

  window.setTimeout(() => {
    slideEl.classList.remove("anim-enter", `dir-${d}`, "fx-none", "fx-zi", "fx-zo");
  }, TRANSITION.durationMs + 80);
}

function scrollToSlide(logicalIndex, behavior = "auto") {
  const axis = getAxis();
  const max = slides.length - 1;
  const logical = Math.max(0, Math.min(logicalIndex, max));
  const target = getSlideElByLogical(logical);
  if (!target || !deck) return;

  const targetPos = axis === "y" ? target.offsetTop : target.offsetLeft;
  if (axis === "y") deck.scrollTo({ top: targetPos, behavior });
  else deck.scrollTo({ left: targetPos, behavior });

  updateSlidePos(logical);
}

// Unified navigation used by autoplay + clicking tabs
function goToSlide(logicalIndex, { behavior = "auto", animate = true } = {}) {
  const max = slides.length - 1;
  const logical = Math.max(0, Math.min(logicalIndex, max));

  programmaticNav = true;
  clearTimeout(scrollDebounce);
  scrollDebounce = setTimeout(() => (programmaticNav = false), 250);

  currentLogical = logical;
  selectedSlideIndex = logical;

  scrollToSlide(logical, behavior);

  if (animate) {
    requestAnimationFrame(() => {
      animateEnter(getSlideElByLogical(logical));
    });
  }
}

// Active observer (adds .active class)
function setupActiveObserver() {
  if (!deck) return;

  Array.from(deck.children).forEach((el) => el.classList.remove("active"));

  if (activeObserver) activeObserver.disconnect();

  activeObserver = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (e.isIntersecting) e.target.classList.add("active");
        else e.target.classList.remove("active");
      }
    },
    { root: deck, threshold: 0.65 }
  );

  Array.from(deck.children).forEach((el) => activeObserver.observe(el));

  if (!deck.dataset.scrollHooked) {
    deck.dataset.scrollHooked = "1";

    deck.addEventListener(
      "scroll",
      () => {
        clearTimeout(scrollDebounce);
        scrollDebounce = setTimeout(() => {
          if (programmaticNav) return;

          const logical = getCurrentLogicalIndex();
          if (logical !== currentLogical) {
            currentLogical = logical;
            selectedSlideIndex = logical;
            updateSlidePos(currentLogical);

            // ✅ also animate when user scrolls manually
            animateEnter(getSlideElByLogical(currentLogical));
          }
        }, 120);
      },
      { passive: true }
    );
  }
}

// -----------------------------
// Autoplay
// -----------------------------
function stopAutoplay() {
  showPlaying(false);
  isPlaying = false;
  if (playTimer) clearTimeout(playTimer);
  playTimer = null;
}

function scheduleNext() {
  if (!isPlaying) return;

  const waitMs = Math.max(1, slides[currentLogical]?.duration || 10) * 1000;

  playTimer = setTimeout(() => {
    const next = currentLogical + 1;

    // ✅ Export mode: stop at last slide (no looping)
    if (EXPORT_MODE && next >= slides.length) {
      stopAutoplay();
      return;
    }

    // ✅ Normal mode loops
    const target = EXPORT_MODE ? next : (next % slides.length);

    // ✅ autoplay uses "auto" scroll + our animation (direction+fx)
    goToSlide(target, { behavior: "auto", animate: true });
    scheduleNext();
  }, waitMs);
}

function startAutoplay() {
  if (isPlaying) return;

  // ✅ Immediately apply animation on current slide when play starts
  animateEnter(getSlideElByLogical(currentLogical));

  showPlaying(true);
  isPlaying = true;
  scheduleNext();
}

function showPlaying(isOn) {
  if (!playBtn || !pauseBtn) return;
  playBtn.disabled = isOn;
  pauseBtn.disabled = !isOn;
  playBtn.classList.toggle("opacity-50", isOn);
  pauseBtn.classList.toggle("opacity-50", !isOn);
}

// Expose for Playwright export
window.startAutoplay = startAutoplay;

// -----------------------------
// Load + preload images
// -----------------------------
async function loadText(url) {
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`Failed to load: ${url}`);
  return await res.text();
}

async function preloadSlideImages(slidesArr) {
  const urls = slidesArr.map((s) => s.imageUrl).filter(Boolean);

  if (!urls.length) {
    window.__IMAGES_READY__ = true;
    return;
  }

  await Promise.all(
    urls.map(
      (u) =>
        new Promise((resolve) => {
          const img = new Image();
          img.onload = () => resolve(true);
          img.onerror = () => resolve(false);
          img.src = u;
        })
    )
  );

  window.__IMAGES_READY__ = true;
}

async function init() {
  CONFIG = await (await fetch("/data/config.json", { cache: "no-store" })).json();
  formatKey = CONFIG.defaultFormat || "vertical";

  rawMarkdown = await Promise.all(CONFIG.slides.map((p) => loadText(rootUrl(p))));
  slides = rawMarkdown.map(parseSlideMarkdown);

  window.slides = slides;

  // preload all backgrounds (important for export)
  window.__IMAGES_READY__ = false;
  await preloadSlideImages(slides);

  // Query params (used by export.html)
  let startFrom = 0;
  try {
    const qs = new URLSearchParams(location.search);

    const startQ = Number(qs.get("start") || 0);
    startFrom = Number.isFinite(startQ)
      ? Math.max(0, Math.min(startQ, slides.length - 1))
      : 0;

    const qFormat = (qs.get("format") || "").toString();
    if (qFormat && CONFIG.formats[qFormat]) formatKey = qFormat;

    const qDir = (qs.get("dir") || "").toString();
    if (qDir && ["auto", "td", "bu", "lr", "rl"].includes(qDir)) TRANSITION.dir = qDir;

    const qFx = (qs.get("fx") || "").toString();
    if (qFx && ["none", "zoomIn", "zoomOut"].includes(qFx)) TRANSITION.fx = qFx;
  } catch {}

  selectedSlideIndex = startFrom;
  currentLogical = startFrom;

  buildFormatDropdown();
  if (formatSelect) formatSelect.value = formatKey;

  formatTextLimitsInfo();

  if (transitionDir) transitionDir.value = TRANSITION.dir;
  if (transitionFx) transitionFx.value = TRANSITION.fx;

  setFrameAspect();
  renderDeck();

  buildTabs();
  syncEditorFromSlide();

  // show start slide
  goToSlide(startFrom, { behavior: "auto", animate: true });
  showPlaying(false);

  // Events
  if (formatSelect) {
    formatSelect.addEventListener("change", () => {
      stopAutoplay();
      formatKey = formatSelect.value;

      setFrameAspect();
      renderDeck();

      selectedSlideIndex = 0;
      currentLogical = 0;

      buildTabs();
      syncEditorFromSlide();

      formatTextLimitsInfo();
      goToSlide(0, { behavior: "auto", animate: true });
    });
  }

  if (transitionDir) {
    transitionDir.addEventListener("change", () => {
      stopAutoplay();
      TRANSITION.dir = transitionDir.value;

      setFrameAspect();
      renderDeck();

      formatTextLimitsInfo();
      goToSlide(currentLogical, { behavior: "auto", animate: true });
    });
  }

  if (transitionFx) {
    transitionFx.addEventListener("change", () => {
      TRANSITION.fx = transitionFx.value;
      formatTextLimitsInfo();
      animateEnter(getSlideElByLogical(currentLogical));
    });
  }

  if (mdEditor) {
    mdEditor.addEventListener("input", async () => {
      rawMarkdown[selectedSlideIndex] = mdEditor.value || "";
      slides[selectedSlideIndex] = parseSlideMarkdown(rawMarkdown[selectedSlideIndex]);
      window.slides = slides;

      window.__IMAGES_READY__ = false;
      await preloadSlideImages(slides);

      validateLimits(slides[selectedSlideIndex]);

      renderDeck();
      goToSlide(selectedSlideIndex, { behavior: "auto", animate: true });
      buildTabs();
    });
  }

  if (playBtn) playBtn.addEventListener("click", startAutoplay);
  if (pauseBtn) pauseBtn.addEventListener("click", stopAutoplay);

  if (restartBtn) {
    restartBtn.addEventListener("click", () => {
      stopAutoplay();
      selectedSlideIndex = 0;
      currentLogical = 0;
      goToSlide(0, { behavior: "auto", animate: true });
    });
  }

  if (exportMp4Btn) exportMp4Btn.addEventListener("click", exportMp4FromCurrent);

  window.addEventListener("resize", () => {
    setFrameAspect();
    renderDeck();
    goToSlide(currentLogical, { behavior: "auto", animate: false });
  });

  window.__APP_READY__ = true;
}

init().catch((err) => {
  console.error(err);
  alert("Could not load slides. Run:\n\nnode server.js\n\nThen open: http://localhost:5500");
});
