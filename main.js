import { deriveKey, openJSON, openBytes, base64ToBytes } from "./crypto.js";
import { createRippleEffect } from "./ripple.js";

const gate = document.getElementById("gate");
const form = document.getElementById("gate-form");
const input = document.getElementById("pw");
const errorEl = document.getElementById("gate-error");
const contentRoot = document.getElementById("content");
const bgCanvas = document.getElementById("bg-canvas");
const blendCanvas = document.getElementById("blend-fx");
const rippleCanvas = document.getElementById("ripple-fx");
const xpWindowEl = document.querySelector(".xp-window");

const MAIN_FADE_MS = 2400;

// ---------- background: blank pre-unlock (flat CSS color only), generative grid+particles after unlock ----------

// The scroll journey, in one continuous renderer.
//
//   act 1  ground level on the grid          the opening
//   act 2  the horizon starts rushing at you  the messages
//   act 3  nose up, the grid falls away       the gallery
//   act 4  warp — stars stretch into lines    the closing
//
// There are no separate scenes: every visual is a continuous function of one
// number, `stage` (0..4), so the acts blend into each other with no seams. And
// stage comes from scroll *position*, not from scroll events, so the sequence
// scrubs — scroll back up and it runs backwards, park anywhere and it holds.
//
// The act boundaries are measured from the content itself (the [data-act]
// sections), not hardcoded, so adding another message never desynchronises
// the visuals from the text.

const ACT_COUNT = 4;

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const lerp = (a, b, t) => a + (b - a) * t;
const smooth = (x) => {
  const c = clamp01(x);
  return c * c * (3 - 2 * c);
};
// Eased 0->1 as `stage` crosses from s0 to s1.
const ramp = (stage, s0, s1) => smooth((stage - s0) / (s1 - s0));

function setupBgCanvas() {
  const ctx = bgCanvas.getContext("2d");
  let w, h, dpr;

  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  // --- one 3D star field for the whole journey -------------------------------
  // Held still it reads as a night sky; given velocity it becomes travel; given
  // more it streaks. Using a single field rather than swapping systems is what
  // lets act 2 slide into act 4 without a visible cut.
  const STAR_COUNT = 240;
  const Z_NEAR = 0.35;
  const Z_FAR = 6;
  const CONNECTED = 46; // constellation lines are O(n^2), so only over a subset

  let stars = [];

  function placeStar(star, z) {
    // Rejection-sample away from dead centre, or everything piles onto the
    // vanishing point and the warp has nothing to radiate.
    let x, y;
    do {
      x = Math.random() * 2 - 1;
      y = Math.random() * 2 - 1;
    } while (Math.hypot(x, y) < 0.06);
    star.x = x;
    star.y = y;
    star.z = z;
    return star;
  }

  function initStars() {
    stars = Array.from({ length: STAR_COUNT }, () =>
      placeStar(
        {
          size: 0.6 + Math.random() * 1.2,
          baseAlpha: 0.5 + Math.random() * 0.35,
          twinkle: Math.random() < 0.22,
          phase: Math.random() * Math.PI * 2,
          rate: 0.4 + Math.random() * 0.8,
          sx: 0,
          sy: 0,
          vis: false,
        },
        Z_NEAR + Math.random() * (Z_FAR - Z_NEAR),
      ),
    );
  }

  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    w = bgCanvas.width = Math.floor(innerWidth * dpr);
    h = bgCanvas.height = Math.floor(innerHeight * dpr);
    bgCanvas.style.width = innerWidth + "px";
    bgCanvas.style.height = innerHeight + "px";
    measureActs();
  }

  // --- where each act begins, measured from the rendered content -------------

  let actStops = null;

  function measureActs() {
    const sections = document.querySelectorAll("#content [data-act]");
    const maxScroll = Math.max(1, document.documentElement.scrollHeight - innerHeight);
    if (!sections.length) {
      actStops = null;
      return;
    }
    const firstOfAct = new Map();
    for (const el of sections) {
      const act = Number(el.dataset.act);
      if (!firstOfAct.has(act)) firstOfAct.set(act, el);
    }
    // An act begins when its first section has risen to just above the middle
    // of the viewport — i.e. when you're actually reading it.
    const stops = [0];
    for (let act = 2; act <= ACT_COUNT; act++) {
      const el = firstOfAct.get(act);
      const target = el
        ? el.getBoundingClientRect().top + window.scrollY - innerHeight * 0.55
        : (maxScroll * (act - 1)) / ACT_COUNT;
      stops.push(Math.min(maxScroll, Math.max(stops[stops.length - 1] + 1, target)));
    }
    stops.push(Math.max(maxScroll, stops[stops.length - 1] + 1));
    actStops = stops;
  }

  function scrollStage() {
    if (!actStops) return 0;
    const y = window.scrollY;
    for (let i = 0; i < ACT_COUNT; i++) {
      const from = actStops[i];
      const to = actStops[i + 1];
      if (y < to || i === ACT_COUNT - 1) return i + clamp01((y - from) / Math.max(1, to - from));
    }
    return ACT_COUNT;
  }

  // --- state -----------------------------------------------------------------

  let mode = "gate";
  let mainModeStart = null;
  let stage = 0;
  let travel = 0; // accumulated grid distance, in grid rows
  let lastFrame = 0;

  function drawMain(now) {
    const dt = Math.min(0.05, lastFrame ? (now - lastFrame) / 1000 : 0.016);
    lastFrame = now;

    const introFactor = mainModeStart === null ? 1 : Math.min(1, (now - mainModeStart) / MAIN_FADE_MS);
    const eased = smooth(introFactor);

    // Ease toward the scroll-derived stage rather than snapping to it, so a
    // trackpad flick reads as acceleration instead of a jump. Position still
    // fully determines where it settles.
    stage += (scrollStage() - stage) * Math.min(1, dt * 5);

    // Act 3's ramps finish early rather than spanning the whole act. Every
    // message and photo owns a screen now, so act 3 is by far the longest
    // stretch of scrolling; spread the takeoff across all of it and nothing
    // appears to happen from one screen to the next. Instead: lift off over the
    // first few screens, then cruise through the stars for the rest of it.
    const motion = reduceMotion ? 0.15 : 1;
    const gridSpeed = lerp(0.1, 3.2, ramp(stage, 0.15, 2.0)) * motion;
    const starSpeed = lerp(0, 3.4, ramp(stage, 1.75, 2.45)) * motion;
    const warp = ramp(stage, 3.0, 3.95) * (reduceMotion ? 0.25 : 1);
    const groundAlpha = 1 - ramp(stage, 2.02, 2.24);
    const gridHorizon = lerp(0.6, 1.45, ramp(stage, 2.0, 2.25)) * h;
    const starCentre = lerp(0.6, 0.5, ramp(stage, 2.0, 2.25)) * h;
    const starAlpha = lerp(0.55, 1, ramp(stage, 2.0, 2.3));
    const linkAlpha = (1 - ramp(stage, 1.2, 2.2)) * groundAlpha;

    travel += gridSpeed * dt;

    const cx = w / 2;
    const f = w * 0.55;

    ctx.fillStyle = "#100a1f";
    ctx.fillRect(0, 0, w, h);

    // --- stars -----------------------------------------------------------
    for (const s of stars) {
      s.z -= starSpeed * dt;
      if (s.z <= Z_NEAR) placeStar(s, s.z + (Z_FAR - Z_NEAR));

      const sx = cx + (s.x / s.z) * f;
      const sy = starCentre + (s.y / s.z) * f;
      s.sx = sx;
      s.sy = sy;
      s.vis = sx > -60 && sx < w + 60 && sy > -60 && sy < h + 60;
      if (!s.vis) continue;

      // Fade in from the far plane so recycled stars don't pop into existence.
      const depth = clamp01(((Z_FAR - s.z) / (Z_FAR - Z_NEAR)) * 1.5);
      let alpha = s.baseAlpha * starAlpha * depth * eased;
      if (s.twinkle && starSpeed < 0.5) {
        alpha *= 0.35 + 0.65 * (0.5 + 0.5 * Math.sin(now * 0.001 * s.rate + s.phase));
      }
      if (alpha < 0.01) continue;

      const radius = Math.max(0.5, ((s.size * dpr) / s.z) * 0.85);

      if (warp > 0.015) {
        // The streak is the same star projected from further away: one line
        // between two depths, which is exactly what motion blur would give.
        const tz = s.z + warp * (1.2 + s.z * 1.1);
        ctx.strokeStyle = `rgba(226,244,255,${alpha})`;
        ctx.lineWidth = radius;
        ctx.beginPath();
        ctx.moveTo(cx + (s.x / tz) * f, starCentre + (s.y / tz) * f);
        ctx.lineTo(sx, sy);
        ctx.stroke();
      } else {
        ctx.fillStyle = `rgba(244,240,255,${alpha})`;
        ctx.beginPath();
        ctx.arc(sx, sy, radius, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // --- constellation lines, early acts only -----------------------------
    if (linkAlpha > 0.02) {
      const maxDist = 150 * dpr;
      ctx.lineWidth = 1;
      for (let i = 0; i < CONNECTED; i++) {
        const a = stars[i];
        if (!a.vis) continue;
        for (let j = i + 1; j < CONNECTED; j++) {
          const b = stars[j];
          if (!b.vis) continue;
          const dist = Math.hypot(a.sx - b.sx, a.sy - b.sy);
          if (dist >= maxDist) continue;
          ctx.strokeStyle = `rgba(255,43,214,${0.14 * (1 - dist / maxDist) * linkAlpha * eased})`;
          ctx.beginPath();
          ctx.moveTo(a.sx, a.sy);
          ctx.lineTo(b.sx, b.sy);
          ctx.stroke();
        }
      }
    }

    // --- ground and grid ---------------------------------------------------
    if (groundAlpha > 0.01 && gridHorizon < h) {
      // Opaque ground hides the stars that project below the horizon while
      // you're still standing on the grid; as it fades in act 3 they're
      // revealed, which is what sells the nose-up.
      ctx.fillStyle = `rgba(16,10,31,${groundAlpha})`;
      ctx.fillRect(0, gridHorizon, w, h - gridHorizon);

      const depth = h - gridHorizon;
      const glow = ctx.createLinearGradient(0, gridHorizon - 40 * dpr, 0, gridHorizon + 6 * dpr);
      glow.addColorStop(0, "rgba(35,230,255,0)");
      glow.addColorStop(1, `rgba(35,230,255,${0.28 * groundAlpha * eased})`);
      ctx.fillStyle = glow;
      ctx.fillRect(0, gridHorizon - 40 * dpr, w, 46 * dpr);

      ctx.lineWidth = 1;
      for (let i = -12; i <= 12; i++) {
        ctx.strokeStyle = `rgba(139,92,246,${0.18 * groundAlpha * eased})`;
        ctx.beginPath();
        ctx.moveTo(cx, gridHorizon);
        ctx.lineTo(cx + i * w * 0.085, h);
        ctx.stroke();
      }

      // Rows live at integer depths and are dragged toward the viewer by
      // `travel`; the perspective divide does the rest, so they bunch up near
      // the horizon and race apart underfoot exactly as speed increases.
      const ROWS = 18;
      const offset = travel % 1;
      for (let n = 1; n <= ROWS; n++) {
        const z = n - offset;
        if (z <= 0) continue;
        const y = gridHorizon + depth / z;
        if (y > h) continue;
        const nearness = 1 - (z - 1) / ROWS;
        ctx.strokeStyle = `rgba(35,230,255,${(0.03 + 0.22 * nearness) * groundAlpha * eased})`;
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(w, y);
        ctx.stroke();
      }
    }
  }

  function frame(now) {
    if (mode === "main") drawMain(now);
    requestAnimationFrame(frame);
  }

  initStars();
  resize();
  window.addEventListener("resize", resize);
  requestAnimationFrame(frame);

  return {
    setMode(m) {
      if (m === "main" && mode !== "main") mainModeStart = performance.now();
      mode = m;
    },
    // Called once the content is in the DOM, and again whenever it reflows
    // (images decoding, a voice note wrapping) — the act boundaries move with it.
    measure: measureActs,
  };
}

// ---------- reveal transition: real ripples build up, then blend into the TRON view ----------
//
// Three acts:
//  1. Build — the gate's background/window stay exactly as they are; a real
//     wave-equation ripple simulation (ripple.js) runs on top, seeded with
//     staggered "drops" that spread and interfere like actual water. The
//     simulation refracts a painted replica of the window, not the whole
//     page, so there's nothing to reveal at the edges.
//  2. Hold — a brief static beat once the surface is disturbed, before it turns.
//  3. Blend — cross-fade from the gate (still wet) into the TRON view, with a
//     burst of glitch/artifact debris layered into the crossfade itself.

const BUILD_MS = 2600;
const HOLD_MS = 900;
const BLEND_MS = 2200;
const REVEAL_FRACTION = 0.45; // how far into the blend the content swap happens
const GATE_FADE_MS = 1300; // keep in sync with .gate transition duration in CSS

function roundedRectPath(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

// A painted stand-in for "the gate as last seen" — this becomes the WebGL
// background texture that actually gets refracted. Reads real positions,
// colors and text straight from the live DOM (getBoundingClientRect /
// getComputedStyle) rather than hardcoded guesses, so it actually looks
// like the window instead of a blank abstraction of it. Doesn't need to be
// pixel-perfect: the form is already disabled by this point (the password
// was correct), so the real window can be hidden in favor of this replica
// for the few seconds the ripple plays, and it's being visually disturbed
// the whole time anyway.
// Exact line boxes for an element's text, straight from the layout engine.
// Re-wrapping by hand with measureText() would land a word differently now and
// then, and the mismatch would be visible for a frame at the instant the canvas
// replica takes over from the real DOM. Asking a Range where each character
// actually sits costs one pass and cannot disagree with what's on screen.
function wrappedLines(el) {
  const node = el.firstChild;
  if (!node || node.nodeType !== Node.TEXT_NODE) return [];
  const text = node.textContent;
  const range = document.createRange();
  const lines = [];
  let current = null;
  for (let i = 0; i < text.length; i++) {
    range.setStart(node, i);
    range.setEnd(node, i + 1);
    const r = range.getBoundingClientRect();
    if (!r.width && !r.height) continue;
    if (!current || Math.abs(r.top - current.top) > 1) {
      current = { top: r.top, left: r.left, text: "" };
      lines.push(current);
    }
    current.text += text[i];
  }
  return lines;
}

function paintText(ctx, el, dpr) {
  const style = getComputedStyle(el);
  const fontSize = parseFloat(style.fontSize);
  const lineHeight = parseFloat(style.lineHeight) || fontSize * 1.2;
  const baseline = (lineHeight - fontSize) / 2 + fontSize * 0.8;
  ctx.fillStyle = style.color;
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
  ctx.font = `${style.fontWeight} ${fontSize * dpr}px ${style.fontFamily}`;
  for (const line of wrappedLines(el)) {
    ctx.fillText(line.text, line.left * dpr, (line.top + baseline) * dpr);
  }
}

function paintXpButton(ctx, btnEl, dpr, fontFamily) {
  const rect = btnEl.getBoundingClientRect();
  const x = rect.left * dpr, y = rect.top * dpr, w = rect.width * dpr, h = rect.height * dpr;
  const grad = ctx.createLinearGradient(0, y, 0, y + h);
  grad.addColorStop(0, "#fefefe");
  grad.addColorStop(0.45, "#ece9d8");
  grad.addColorStop(0.5, "#d9d3c0");
  grad.addColorStop(1, "#ece9d8");
  ctx.fillStyle = grad;
  ctx.fillRect(x, y, w, h);
  ctx.strokeStyle = "#716f64";
  ctx.lineWidth = dpr;
  ctx.strokeRect(x, y, w, h);
  ctx.fillStyle = "#101010";
  ctx.textAlign = "center";
  ctx.font = `${13 * dpr}px ${fontFamily}`;
  ctx.fillText(btnEl.textContent, x + w / 2, y + h * 0.68);
  ctx.textAlign = "left";
}

// Frame + titlebar for any .xp-window; `paintBody` fills in whatever that
// particular window contains.
function paintXpWindow(ctx, winEl, dpr, controlGlyphs, paintBody) {
  const rect = winEl.getBoundingClientRect();
  const x = rect.left * dpr, y = rect.top * dpr, w = rect.width * dpr, h = rect.height * dpr;
  const titlebarEl = winEl.querySelector(".xp-titlebar");
  const bodyEl = winEl.querySelector(".xp-body");
  const titleEl = winEl.querySelector(".xp-title");
  const titlebarH = titlebarEl.getBoundingClientRect().height * dpr;

  ctx.save();
  roundedRectPath(ctx, x, y, w, h, 8 * dpr);
  ctx.clip();

  const titleGrad = ctx.createLinearGradient(0, y, 0, y + titlebarH);
  titleGrad.addColorStop(0, "#4fa3ff");
  titleGrad.addColorStop(0.46, "#1657c9");
  titleGrad.addColorStop(1, "#0a3fa0");
  ctx.fillStyle = titleGrad;
  ctx.fillRect(x, y, w, titlebarH);
  ctx.fillStyle = getComputedStyle(bodyEl).backgroundColor;
  ctx.fillRect(x, y + titlebarH, w, h - titlebarH);

  const iconSize = 13 * dpr;
  const iconY = y + (titlebarH - iconSize) / 2;
  ctx.fillStyle = winEl.classList.contains("xp-dialog-error") ? "#e81123" : "#f4b400";
  if (winEl.classList.contains("xp-dialog-error")) {
    ctx.beginPath();
    ctx.arc(x + 8 * dpr + iconSize / 2, iconY + iconSize / 2, iconSize / 2, 0, Math.PI * 2);
    ctx.fill();
  } else {
    ctx.fillRect(x + 8 * dpr, iconY, iconSize, iconSize);
  }

  const titleStyle = getComputedStyle(titleEl);
  ctx.fillStyle = "#ffffff";
  ctx.textBaseline = "middle";
  ctx.textAlign = "left";
  ctx.font = `${titleStyle.fontWeight} ${parseFloat(titleStyle.fontSize) * dpr}px ${titleStyle.fontFamily}`;
  ctx.fillText(titleEl.textContent, x + 8 * dpr + iconSize + 6 * dpr, y + titlebarH / 2);

  ctx.font = `${12 * dpr}px ${titleStyle.fontFamily}`;
  ctx.textAlign = "right";
  ctx.fillText(controlGlyphs, x + w - 8 * dpr, y + titlebarH / 2);
  ctx.textAlign = "left";

  paintBody({ x, y, w, h, titlebarH, fontFamily: titleStyle.fontFamily });
  ctx.restore();
}

// A canvas stand-in for whatever the gate currently looks like — the login
// window, plus the door-policy dialog on top of it if one is still open. The
// ripple shader needs a texture, and this is what the user is looking at.
function paintGateReplica(width, height, dpr) {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");

  ctx.fillStyle = getComputedStyle(gate).backgroundColor;
  ctx.fillRect(0, 0, width, height);

  paintXpWindow(ctx, xpWindowEl, dpr, "_  \u25a1  \u00d7", ({ fontFamily }) => {
    paintText(ctx, xpWindowEl.querySelector(".xp-line"), dpr);
    paintText(ctx, xpWindowEl.querySelector(".xp-field-label"), dpr);

    const inputRect = input.getBoundingClientRect();
    const ix = inputRect.left * dpr, iy = inputRect.top * dpr;
    const iw = inputRect.width * dpr, ih = inputRect.height * dpr;
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(ix, iy, iw, ih);
    ctx.strokeStyle = "#7f9db9";
    ctx.lineWidth = dpr;
    ctx.strokeRect(ix, iy, iw, ih);
    ctx.fillStyle = "#101010";
    ctx.font = `${14 * dpr}px ${fontFamily}`;
    ctx.fillText("\u2022".repeat(Math.min(input.value.length, 24)), ix + 8 * dpr, iy + ih * 0.68);

    paintXpButton(ctx, xpWindowEl.querySelector(".xp-button"), dpr, fontFamily);
  });

  for (const overlay of document.querySelectorAll(".xp-modal")) {
    ctx.fillStyle = getComputedStyle(overlay).backgroundColor;
    ctx.fillRect(0, 0, width, height);
    const dialog = overlay.querySelector(".xp-window");
    if (!dialog) continue;
    paintXpWindow(ctx, dialog, dpr, "\u00d7", ({ fontFamily }) => {
      paintText(ctx, dialog.querySelector(".xp-line"), dpr);
      for (const btn of dialog.querySelectorAll(".xp-button")) {
        paintXpButton(ctx, btn, dpr, fontFamily);
      }
    });
  }

  return canvas;
}

const blendCtx = blendCanvas.getContext("2d");
const BLEND_DEBRIS_COLORS = ["#0a5cd6", "#4fa3ff", "#ece9d8", "#2db34a", "#ff2bd6", "#23e6ff"];

function drawBlendGlitch(intensity) {
  const w = blendCanvas.width;
  const h = blendCanvas.height;
  blendCtx.clearRect(0, 0, w, h);
  if (intensity <= 0) return;

  const bandCount = Math.floor(4 + intensity * 30);
  for (let i = 0; i < bandCount; i++) {
    const y = Math.random() * h;
    const bandH = 1 + Math.random() * 16 * intensity;
    const bw = 40 + Math.random() * w * 0.5;
    const x = Math.random() * w;
    blendCtx.globalAlpha = 0.1 + Math.random() * 0.35 * intensity;
    blendCtx.fillStyle = BLEND_DEBRIS_COLORS[(Math.random() * BLEND_DEBRIS_COLORS.length) | 0];
    blendCtx.fillRect(x - bw / 2, y, bw, bandH);
  }
  blendCtx.globalAlpha = 1;
}

function runRevealTransition(onReveal) {
  return new Promise((resolve) => {
    blendCanvas.width = innerWidth;
    blendCanvas.height = innerHeight;

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    rippleCanvas.width = Math.floor(innerWidth * dpr);
    rippleCanvas.height = Math.floor(innerHeight * dpr);

    const ripple = createRippleEffect(rippleCanvas, { resolution: 256, perturbance: 0.09, normalZ: 0.15 });
    if (ripple) {
      ripple.setBackground(paintGateReplica(rippleCanvas.width, rippleCanvas.height, dpr));
      xpWindowEl.style.visibility = "hidden";
      // Both are now part of the replica the shader is refracting; leaving the
      // real ones visible would float them, unrippled, above the animation.
      for (const m of document.querySelectorAll(".xp-modal")) m.style.visibility = "hidden";
      rippleCanvas.classList.add("active");
    }

    // Staggered drops, seeded as real wave-equation disturbances that spread
    // and interfere with each other — not independent decorative shapes.
    // Both size/strength AND cadence ramp up over the build: the first
    // couple are small, weak, and far apart in time; by the end they're
    // bigger, stronger, and landing in quick succession — a genuine build
    // from "barely disturbed" to "properly dynamic", not uniform from frame one.
    const DROP_COUNT = 14;
    const drops = ripple
      ? Array.from({ length: DROP_COUNT }, (_, i) => {
          const progress = i / (DROP_COUNT - 1);
          return {
            x: Math.random(),
            y: Math.random(),
            radius: 0.03 + progress * 0.07 + Math.random() * 0.02,
            strength: 0.6 + progress * 3.2 + Math.random() * 0.6,
            at: Math.pow(progress, 1.5) * BUILD_MS * 0.88,
            done: false,
          };
        })
      : [];

    const blendStart = BUILD_MS + HOLD_MS;
    const revealAt = blendStart + BLEND_MS * REVEAL_FRACTION;
    const totalMs = Math.max(blendStart + BLEND_MS, revealAt + GATE_FADE_MS);

    const start = performance.now();
    let revealed = false;
    let frozen = false;

    function frame(now) {
      const elapsed = now - start;

      if (ripple && elapsed < blendStart) {
        for (const d of drops) {
          if (!d.done && elapsed >= d.at) {
            d.done = true;
            ripple.addDrop(d.x, d.y, d.radius, d.strength);
          }
        }
        ripple.update(2);
        ripple.render();
      } else if (ripple && !frozen) {
        // Digital-malfunction freeze: stop simulating/rendering entirely, so
        // whatever wave state was on screen just holds — a literal frozen
        // frame — right as the glitch burst below starts taking over.
        frozen = true;
        rippleCanvas.classList.add("frozen");
      }

      if (elapsed >= blendStart) {
        const blendProgress = Math.min((elapsed - blendStart) / BLEND_MS, 1);
        drawBlendGlitch(Math.sin(blendProgress * Math.PI));

        if (!revealed && elapsed >= revealAt) {
          revealed = true;
          onReveal();
        }
      }

      if (elapsed < totalMs) {
        requestAnimationFrame(frame);
      } else {
        blendCtx.clearRect(0, 0, blendCanvas.width, blendCanvas.height);
        resolve();
      }
    }
    requestAnimationFrame(frame);
  });
}

// ---------- content rendering ----------

function makeSection(act) {
  const el = document.createElement("section");
  el.className = "section";
  el.dataset.act = String(act);
  return el;
}

function makeHeading(text) {
  const h = document.createElement("h2");
  h.className = "section-heading";
  h.textContent = text;
  return h;
}

// ---------- encrypted media ----------
// Photos and voice notes are separate AES-GCM blobs under media/, sealed with
// the same key that opened the text payload. They are fetched and decrypted only
// when they scroll into view, so unlocking the page doesn't pull down everything
// at once — and the key has to survive the unlock for any of it to work.

let contentKey = null;

const NEON = (() => {
  const css = getComputedStyle(document.documentElement);
  const read = (name, fallback) => css.getPropertyValue(name).trim() || fallback;
  return { magenta: read("--neon-magenta", "#ff2bd6"), cyan: read("--neon-cyan", "#23e6ff") };
})();

const mediaCache = new Map();
const lazyLoaders = new WeakMap();

const mediaObserver = new IntersectionObserver(
  (entries, obs) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      obs.unobserve(e.target);
      const load = lazyLoaders.get(e.target);
      lazyLoaders.delete(e.target);
      if (load) load();
    }
  },
  { rootMargin: "400px 0px" },
);

function lazily(el, load) {
  lazyLoaders.set(el, load);
  mediaObserver.observe(el);
  return el;
}

function mediaURL(entry) {
  if (mediaCache.has(entry.id)) return mediaCache.get(entry.id);
  const pending = (async () => {
    const res = await fetch(`media/${entry.id}.enc`);
    if (!res.ok) throw new Error(`media/${entry.id}.enc: HTTP ${res.status}`);
    const plain = await openBytes(contentKey, await res.arrayBuffer());
    return URL.createObjectURL(new Blob([plain], { type: entry.mime }));
  })();
  mediaCache.set(entry.id, pending);
  return pending;
}

function formatClock(seconds) {
  const s = Math.max(0, Math.round(seconds || 0));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function makeFrame(entry, caption, inner, solo) {
  const fig = document.createElement("figure");
  fig.className = solo ? "photo-frame photo-solo" : "photo-frame";
  if (solo && entry.w && entry.h) {
    // Bound by viewport height as well as width, using the real aspect ratio, so
    // a portrait photo fills its screen without becoming a column taller than it.
    fig.style.maxWidth = `min(46rem, 92vw, calc(74vh * ${(entry.w / entry.h).toFixed(4)}))`;
  }
  const shot = document.createElement("div");
  shot.className = "photo-shot";
  if (entry.w && entry.h) shot.style.aspectRatio = `${entry.w} / ${entry.h}`;
  shot.appendChild(inner);
  fig.appendChild(shot);
  if (caption) {
    const cap = document.createElement("figcaption");
    cap.className = "photo-caption";
    setProse(cap, caption);
    fig.appendChild(cap);
  }
  return fig;
}

function makeImage(entry, caption, solo) {
  const img = document.createElement("img");
  img.alt = caption || "";
  img.decoding = "async";
  const fig = makeFrame(entry, caption, img, solo);
  return lazily(fig, async () => {
    try {
      img.src = await mediaURL(entry);
      fig.classList.add("loaded");
    } catch {
      fig.classList.add("failed");
    }
  });
}

function makeVideo(entry, caption, solo) {
  const video = document.createElement("video");
  video.playsInline = true;
  video.preload = "none";
  if (entry.loop) {
    // GIF-derived: behaves like the GIF it replaced, not like a video player.
    video.loop = true;
    video.muted = true;
    video.autoplay = true;
  } else {
    video.controls = true;
  }
  const fig = makeFrame(entry, caption, video, solo);
  return lazily(fig, async () => {
    try {
      video.src = await mediaURL(entry);
      fig.classList.add("loaded");
      if (entry.loop) video.play().catch(() => {});
    } catch {
      fig.classList.add("failed");
    }
  });
}

// Voice notes get a drawn waveform rather than <audio controls>, which would
// drop a grey browser widget into the middle of the collage. The envelope is
// precomputed at build time (entry.peaks), so nothing is decoded here.
function makeVoiceNote(entry, author) {
  const wrap = document.createElement("div");
  wrap.className = "voice-note";

  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "voice-play";
  btn.setAttribute("aria-label", author ? `Play voice note from ${author}` : "Play voice note");

  // The canvas is absolutely positioned inside this slot rather than being a
  // flex item itself. A <canvas> has an intrinsic size equal to its width/height
  // attributes, so as long as its used width can be influenced by that intrinsic
  // size, draw() writing clientWidth into canvas.width feeds straight back into
  // layout and the element grows a step every frame. Taking it out of flow with
  // inset:0 severs that path completely — its box comes from the slot, full stop.
  const slot = document.createElement("div");
  slot.className = "voice-wave-slot";
  const canvas = document.createElement("canvas");
  canvas.className = "voice-wave";
  canvas.setAttribute("aria-hidden", "true");
  slot.appendChild(canvas);

  const clock = document.createElement("span");
  clock.className = "voice-time";
  clock.textContent = formatClock(entry.duration);

  wrap.append(btn, slot, clock);

  const peaks = entry.peaks?.length ? entry.peaks : new Array(64).fill(0.35);
  const audio = new Audio();
  audio.preload = "none";
  let progress = 0;
  let armed = false;

  function draw() {
    // Clamped as a belt-and-braces guard: an oversized backing store doesn't
    // just look wrong, it makes the canvas fail to render entirely.
    const w = Math.min(canvas.clientWidth, 4096);
    const h = Math.min(canvas.clientHeight, 512);
    if (w <= 0 || h <= 0) return;
    const dpr = window.devicePixelRatio || 1;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    }
    const ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const gap = 2;
    const barW = Math.max(1, (w - gap * (peaks.length - 1)) / peaks.length);
    for (let i = 0; i < peaks.length; i++) {
      const barH = Math.max(2, peaks[i] * (h - 2));
      const played = (i + 0.5) / peaks.length <= progress;
      ctx.fillStyle = played ? NEON.magenta : "rgba(35, 230, 255, 0.35)";
      ctx.fillRect(i * (barW + gap), (h - barH) / 2, barW, barH);
    }
  }

  function total() {
    return Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : entry.duration || 0;
  }

  function tick() {
    const dur = total();
    progress = dur ? audio.currentTime / dur : 0;
    clock.textContent = formatClock(dur - audio.currentTime);
    draw();
    if (!audio.paused) requestAnimationFrame(tick);
  }

  btn.addEventListener("click", async () => {
    if (!armed) {
      btn.disabled = true;
      try {
        audio.src = await mediaURL(entry);
        armed = true;
      } catch {
        wrap.classList.add("failed");
        btn.disabled = false;
        return;
      }
      btn.disabled = false;
    }
    if (audio.paused) audio.play().catch(() => {});
    else audio.pause();
  });

  canvas.addEventListener("click", (event) => {
    const dur = total();
    if (!armed || !dur) return;
    const rect = canvas.getBoundingClientRect();
    audio.currentTime = Math.min(dur, Math.max(0, ((event.clientX - rect.left) / rect.width) * dur));
    tick();
  });

  audio.addEventListener("play", () => {
    wrap.classList.add("playing");
    btn.setAttribute("aria-label", author ? `Pause voice note from ${author}` : "Pause voice note");
    tick();
  });
  audio.addEventListener("pause", () => {
    wrap.classList.remove("playing");
    btn.setAttribute("aria-label", author ? `Play voice note from ${author}` : "Play voice note");
  });
  audio.addEventListener("ended", () => {
    progress = 0;
    clock.textContent = formatClock(total());
    draw();
  });

  // Observing the canvas rather than the window catches every relayout, and
  // costs nothing extra: draw() only touches the backing store, never layout.
  new ResizeObserver(draw).observe(slot);

  // Prefetch on scroll-in so pressing play is instant; a 48 kbps mono note is
  // small enough that this costs little even if it's never played.
  return lazily(wrap, () => {
    draw();
    mediaURL(entry).catch(() => wrap.classList.add("failed"));
  });
}

function makeMedia(entry, { caption = "", author = "", solo = false } = {}) {
  if (entry.kind === "audio") return makeVoiceNote(entry, author);
  if (entry.kind === "video") return makeVideo(entry, caption, solo);
  return makeImage(entry, caption, solo);
}

// A heading on its own, but only 42vh tall — it introduces the run of
// one-per-screen sections below it without costing a whole empty screen.
// Prose from content.json is never inserted as HTML — submitted text
// setting its own markup is exactly what must not be possible. Instead one narrow
// markdown-ish form is understood, [label](url), and the label still goes in
// via textContent. The URL is parsed and only http/https survives, so a
// javascript: or data: href can't be smuggled in; anything else falls back to
// rendering the label as plain text.
const LINK_RE = /\[([^\]]+)\]\(((?:[^()\s]|\([^()\s]*\))+)\)/g;

function safeHref(url) {
  try {
    const parsed = new URL(url, location.href);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.href : null;
  } catch {
    return null;
  }
}

function setProse(el, text) {
  el.textContent = "";
  if (typeof text !== "string") return el;
  let last = 0;
  for (const match of text.matchAll(LINK_RE)) {
    if (match.index > last) el.appendChild(document.createTextNode(text.slice(last, match.index)));
    const href = safeHref(match[2]);
    if (href) {
      const a = document.createElement("a");
      a.href = href;
      a.textContent = match[1];
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      el.appendChild(a);
    } else {
      el.appendChild(document.createTextNode(match[1]));
    }
    last = match.index + match[0].length;
  }
  if (last < text.length) el.appendChild(document.createTextNode(text.slice(last)));
  return el;
}

function makeLead(act, text) {
  const el = document.createElement("section");
  el.className = "section section-lead";
  el.dataset.act = String(act);
  const heading = makeHeading(text);
  // A full sentence needs to wrap and sit smaller than a two-word label would.
  if (text.length > 60) heading.classList.add("long");
  el.appendChild(heading);
  return el;
}

function makeMessageCard(m) {
  const card = document.createElement("div");
  card.className = "message-card";
  const author = document.createElement("span");
  author.className = "message-author";
  author.textContent = m.author;
  const body = document.createElement("p");
  body.className = "message-body";
  setProse(body, m.body);
  card.appendChild(author);
  card.appendChild(body);
  if (Array.isArray(m.media) && m.media.length) {
    const attachments = document.createElement("div");
    attachments.className = "message-media";
    for (const entry of m.media) {
      attachments.appendChild(makeMedia(entry, { author: m.author }));
    }
    card.appendChild(attachments);
  }
  return card;
}

function renderContent(data) {
  contentRoot.innerHTML = "";

  const hero = makeSection(1);
  const heroTitle = document.createElement("h1");
  heroTitle.className = data.title.length > 24 ? "hero-title long" : "hero-title";
  heroTitle.textContent = data.title;
  const heroSubtitle = document.createElement("p");
  heroSubtitle.className = "hero-subtitle";
  heroSubtitle.textContent = data.subtitle;
  hero.append(heroTitle, heroSubtitle);
  contentRoot.appendChild(hero);

  if (data.messagesLead) contentRoot.appendChild(makeLead(2, data.messagesLead));
  for (const m of data.messages) {
    const section = makeSection(2);
    section.appendChild(makeMessageCard(m));
    contentRoot.appendChild(section);
  }

  const gallery = data.gallery ?? [];
  if (gallery.length) {
    if (data.galleryLead) contentRoot.appendChild(makeLead(3, data.galleryLead));
    for (const g of gallery) {
      const section = makeSection(3);
      if (g.media) {
        section.appendChild(makeMedia(g.media, { caption: g.caption, solo: true }));
      } else {
        // Still a placeholder — nothing has been dropped in content/inbox/ for
        // this slot yet, so keep the dashed outline rather than a broken frame.
        const slot = document.createElement("div");
        slot.className = "gif-slot";
        slot.textContent = g.caption;
        section.appendChild(slot);
      }
      contentRoot.appendChild(section);
    }
  }

  const gift = makeSection(3);
  gift.appendChild(makeHeading(data.giftReveal.heading));
  const giftBody = document.createElement("p");
  giftBody.className = "gift-body";
  setProse(giftBody, data.giftReveal.body);
  gift.appendChild(giftBody);
  contentRoot.appendChild(gift);

  const closing = makeSection(4);
  const closingText = document.createElement("p");
  closingText.className = "closing-text";
  setProse(closingText, data.closing);
  closing.appendChild(closingText);

  // Sits below the closing line inside act 4, so by the time it scrolls up the
  // warp behind it is at 50-85% — the wall arrives into the streaks rather than
  // before them.
  const finale = data.finale ?? [];
  if (finale.length) {
    const wall = document.createElement("div");
    wall.className = "finale-wall";

    // Scattered across a viewport-sized band on a jittered grid. Pure random
    // placement clumps and leaves holes; a plain grid reads as a contact sheet.
    // The jitter is derived from the index, so the collage looks thrown together
    // by hand but comes out identical on every reload.
    const noise = (n) => {
      const x = Math.sin(n * 12.9898) * 43758.5453;
      return x - Math.floor(x);
    };
    const cols = Math.ceil(Math.sqrt(finale.length * 1.7));
    const rows = Math.ceil(finale.length / cols);

    finale.forEach((entry, i) => {
      const row = Math.floor(i / cols);
      const col = i % cols;
      // The last row usually holds fewer than `cols`; spreading it over its own
      // count keeps it from bunching to the left.
      const inRow = Math.min(cols, finale.length - row * cols);
      const item = makeMedia(entry, {});
      item.style.left = `${((col + 0.5) / inRow) * 100 + (noise(i * 2 + 1) - 0.5) * (58 / inRow)}%`;
      item.style.top = `${((row + 0.5) / rows) * 100 + (noise(i * 2 + 2) - 0.5) * (52 / rows)}%`;
      item.style.width = `clamp(5.5rem, ${(13 + noise(i + 7) * 6).toFixed(1)}vw, 13rem)`;
      item.style.setProperty("--tilt", `${((noise(i + 3) - 0.5) * 14).toFixed(1)}deg`);
      wall.appendChild(item);
    });
    closing.appendChild(wall);
  }

  contentRoot.appendChild(closing);
}

// ---------- XP dialogs ----------
// Reuses the gate's own .xp-* classes so a dialog is visually the same object as
// the login window, just smaller. Resolves to the id of the button that was
// clicked; Escape and the titlebar × both resolve to `dismiss`.

function showXpDialog({ title, body, buttons, dismiss, focus, error = false }) {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "xp-modal";

    const win = document.createElement("div");
    win.className = error ? "xp-window xp-dialog xp-dialog-error" : "xp-window xp-dialog";
    win.setAttribute("role", "dialog");
    win.setAttribute("aria-modal", "true");

    const scan = document.createElement("div");
    scan.className = "scanlines";
    scan.setAttribute("aria-hidden", "true");

    const bar = document.createElement("div");
    bar.className = "xp-titlebar";
    const icon = document.createElement("span");
    icon.className = "xp-title-icon";
    icon.setAttribute("aria-hidden", "true");
    const titleEl = document.createElement("span");
    titleEl.className = "xp-title";
    titleEl.textContent = title;
    const controls = document.createElement("div");
    controls.className = "xp-controls";
    const close = document.createElement("button");
    close.type = "button";
    close.className = "xp-btn xp-close";
    close.textContent = "\u00d7";
    close.setAttribute("aria-label", "Schlie\u00dfen");
    controls.appendChild(close);
    bar.append(icon, titleEl, controls);

    const bodyEl = document.createElement("div");
    bodyEl.className = "xp-body";
    const line = document.createElement("p");
    line.className = "xp-line";
    line.textContent = body;
    const actions = document.createElement("div");
    actions.className = "xp-actions";
    bodyEl.append(line, actions);

    let settled = false;
    function finish(id) {
      if (settled) return;
      settled = true;
      document.removeEventListener("keydown", onKey, true);
      overlay.style.pointerEvents = "none";
      resolve({ id, overlay });
    }
    function onKey(event) {
      if (event.key === "Escape") {
        event.preventDefault();
        finish(dismiss);
      }
    }

    let toFocus = null;
    for (const b of buttons) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "xp-button";
      btn.textContent = b.label;
      btn.addEventListener("click", () => finish(b.id));
      actions.appendChild(btn);
      if (b.id === focus) toFocus = btn;
    }
    close.addEventListener("click", () => finish(dismiss));

    win.append(scan, bar, bodyEl);
    overlay.appendChild(win);
    document.body.appendChild(overlay);
    document.addEventListener("keydown", onKey, true);
    (toFocus ?? actions.firstElementChild)?.focus();
  });
}

// Every word of copy lives in the encrypted payload, never in this file: main.js
// is served in the clear to anyone who loads the page, so anything written here
// would be readable without the passphrase. Agreeing to the rules is the wrong
// answer; refusing lets you in. No policy in the payload means no dialog.
async function runDoorPolicy(policy) {
  if (!policy) return true;

  const rules = await showXpDialog({
    title: policy.title,
    body: policy.body,
    buttons: [
      { id: "ok", label: policy.accept },
      { id: "no", label: policy.refuse },
    ],
    dismiss: "no",
    focus: "no",
  });
  if (rules.id !== "ok") {
    // Deliberately left in the DOM: runRevealTransition paints it into the
    // replica, so the waves break over the dialog the user is actually looking
    // at instead of snapping back to the bare login window first.
    return true;
  }
  rules.overlay.remove();

  const failure = await showXpDialog({
    title: policy.errorTitle,
    body: policy.errorBody,
    buttons: [{ id: "ok", label: "OK" }],
    dismiss: "ok",
    focus: "ok",
    error: true,
  });
  failure.overlay.remove();
  return false;
}

// ---------- wiring ----------

const bg = setupBgCanvas();

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  errorEl.textContent = "";
  errorEl.classList.remove("shake");

  const password = input.value;
  if (!password) return;

  let data;
  try {
    // The key is kept in module scope, not discarded: media/*.enc are sealed
    // with this same key and are opened lazily as they scroll into view.
    contentKey = await deriveKey(password, base64ToBytes(window.__PAYLOAD__.salt));
    data = await openJSON(contentKey, window.__PAYLOAD__.blob);
  } catch {
    contentKey = null;
    errorEl.textContent = "The password you typed is incorrect. Please try again.";
    errorEl.classList.add("shake");
    input.value = "";
    input.focus();
    return;
  }

  const submitBtn = form.querySelector("button");
  input.disabled = true;
  submitBtn.disabled = true;

  // The password was right, but there's still the house rules to get past.
  if (!(await runDoorPolicy(data.doorPolicy))) {
    contentKey = null;
    input.disabled = false;
    submitBtn.disabled = false;
    input.value = "";
    errorEl.textContent = "";
    input.focus();
    return;
  }

  await runRevealTransition(() => {
    renderContent(data);
    contentRoot.hidden = false;
    // Photos decoding and voice notes wrapping both change the page height,
    // which moves every act boundary — so re-measure on any reflow.
    new ResizeObserver(() => bg.measure()).observe(contentRoot);
    requestAnimationFrame(() => contentRoot.classList.add("visible"));
    gate.classList.add("hiding");
    document.body.classList.add("unlocked");
    bg.setMode("main");
    requestAnimationFrame(() => bg.measure());
  });

  gate.remove();
  for (const m of document.querySelectorAll(".xp-modal")) m.remove();
});
