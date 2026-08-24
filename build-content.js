#!/usr/bin/env node
// Builds the two things the browser actually loads:
//
//   content.enc.js   the text payload — {salt, blob}, a few KB, loaded eagerly
//   media/<id>.enc   one encrypted blob per photo / voice note / clip
//
// Everything it reads lives under content/, which is gitignored: content.json
// for the text, content/inbox/<sender>/ for the raw files exactly as they were
// received. Nothing under content/ is ever published; only the encrypted output is.
//
//   node build-content.js                      build (prompts for the passphrase)
//   node build-content.js --scan               list inbox files not yet referenced
//   node build-content.js --rotate-password    re-encrypt everything under a new passphrase
//
// Requires ffmpeg + ffprobe on PATH (brew install ffmpeg / apt install ffmpeg),
// and heif-convert (libheif-examples) for iPhone .HEIC photos.

import { readFile, writeFile, mkdir, readdir, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  deriveKey, sealBytes, openBytes, sealJSON, openJSON,
  base64ToBytes, bytesToBase64, SALT_BYTES,
} from "./crypto.js";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const CONTENT_DIR = path.join(ROOT, "content");
const CONTENT_JSON = path.join(CONTENT_DIR, "content.json");
const INBOX = path.join(CONTENT_DIR, "inbox");
const CACHE = path.join(ROOT, ".cache");
const MEDIA_OUT = path.join(ROOT, "media");
const ENC_JS = path.join(ROOT, "content.enc.js");

const WARN_SINGLE_BYTES = 5 * 1024 * 1024;
const WARN_TOTAL_BYTES = 40 * 1024 * 1024;

const IMAGE_EXT = new Set([".jpg", ".jpeg", ".png", ".webp", ".bmp", ".tif", ".tiff"]);
const HEIC_EXT = new Set([".heic", ".heif"]);
const AUDIO_EXT = new Set([".m4a", ".mp3", ".wav", ".ogg", ".oga", ".opus", ".aac", ".flac", ".amr", ".caf", ".wma"]);
const VIDEO_EXT = new Set([".mp4", ".mov", ".webm", ".m4v", ".avi", ".mkv"]);

// --- small helpers -----------------------------------------------------------

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");
const fmtBytes = (n) =>
  n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(0)} KB` : `${(n / 1048576).toFixed(2)} MB`;

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { maxBuffer: 1 << 30, ...opts });
  if (r.error) throw new Error(`${cmd} not found on PATH — see the header of build-content.js`);
  if (r.status !== 0) {
    const tail = String(r.stderr || "").trim().split("\n").slice(-6).join("\n");
    throw new Error(`${cmd} failed (exit ${r.status})\n${tail}`);
  }
  return r;
}

const ffprobe = (args) => String(run("ffprobe", ["-v", "error", ...args]).stdout).trim();

function probeDimensions(file) {
  const out = ffprobe(["-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0:s=x", file]);
  const [w, h] = out.split("x").map(Number);
  return { w: w || null, h: h || null };
}

function probeDuration(file) {
  const d = Number(ffprobe(["-show_entries", "format=duration", "-of", "csv=p=0", file]));
  return Number.isFinite(d) ? Math.round(d * 10) / 10 : null;
}

function isAnimated(file) {
  const out = ffprobe([
    "-select_streams", "v:0", "-count_frames",
    "-show_entries", "stream=nb_read_frames", "-of", "csv=p=0", file,
  ]);
  return Number(out) > 1;
}

// 64 max-amplitude buckets, computed here so the browser never has to decode
// audio just to draw a waveform.
function audioPeaks(file, buckets = 64) {
  const pcm = run("ffmpeg", ["-v", "error", "-i", file, "-ac", "1", "-ar", "8000", "-f", "s16le", "-"]).stdout;
  const samples = Math.floor(pcm.length / 2);
  if (samples === 0) return new Array(buckets).fill(0);
  const per = Math.max(1, Math.floor(samples / buckets));
  const peaks = [];
  for (let b = 0; b < buckets; b++) {
    let max = 0;
    for (let i = b * per; i < Math.min((b + 1) * per, samples); i++) {
      const v = Math.abs(pcm.readInt16LE(i * 2));
      if (v > max) max = v;
    }
    peaks.push(max / 32768);
  }
  // Normalize against the loudest bucket so a quietly-recorded voice note still
  // draws a full-height waveform.
  const loudest = Math.max(...peaks, 0.0001);
  return peaks.map((p) => Math.round((p / loudest) * 100) / 100);
}

// --- normalization -----------------------------------------------------------
// Every derivative is written with `-map_metadata -1`, which is what strips the
// EXIF/GPS block phone photos carry. That is not cosmetic: without it the
// encrypted payload would still hold the exact coordinates a photo was taken at.

function classify(file) {
  const ext = path.extname(file).toLowerCase();
  if (HEIC_EXT.has(ext) || IMAGE_EXT.has(ext)) return "image";
  if (ext === ".gif") return isAnimated(file) ? "video" : "image";
  if (AUDIO_EXT.has(ext)) return "audio";
  if (VIDEO_EXT.has(ext)) return "video";
  return null;
}

function normalize(src, kind, cacheBase) {
  const ext = path.extname(src).toLowerCase();

  if (kind === "image") {
    let input = src;
    if (HEIC_EXT.has(ext)) {
      // ffmpeg's HEIF support is patchy; heif-convert is not.
      input = `${cacheBase}.src.png`;
      run("heif-convert", [src, input]);
    }
    const out = `${cacheBase}.webp`;
    run("ffmpeg", [
      "-y", "-v", "error", "-i", input, "-map_metadata", "-1", "-frames:v", "1",
      "-vf", "scale='if(gt(iw,ih),min(1600,iw),-2)':'if(gt(iw,ih),-2,min(1600,ih))':flags=lanczos",
      "-c:v", "libwebp", "-quality", "80", out,
    ]);
    return { file: out, mime: "image/webp", ...probeDimensions(out) };
  }

  if (kind === "audio") {
    const out = `${cacheBase}.m4a`;
    // AAC-LC mono @48k: ~360 KB/minute and plays natively everywhere, including
    // iOS Safari. Opus is ~30% smaller but Safari support is inconsistent, and
    // this is a link people will open on their phones.
    run("ffmpeg", [
      "-y", "-v", "error", "-i", src, "-map_metadata", "-1", "-vn",
      "-ac", "1", "-c:a", "aac", "-b:a", "48k", "-movflags", "+faststart", out,
    ]);
    return { file: out, mime: "audio/mp4", duration: probeDuration(out), peaks: audioPeaks(out) };
  }

  const out = `${cacheBase}.mp4`;
  run("ffmpeg", [
    "-y", "-v", "error", "-i", src, "-map_metadata", "-1",
    "-vf", "scale='if(gt(iw,1280),1280,iw)':-2,scale=trunc(iw/2)*2:trunc(ih/2)*2",
    "-c:v", "libx264", "-crf", "26", "-preset", "medium", "-pix_fmt", "yuv420p",
    "-movflags", "+faststart",
    ...(ext === ".gif" ? ["-an"] : ["-c:a", "aac", "-b:a", "64k", "-ac", "1"]),
    out,
  ]);
  return {
    file: out,
    mime: "video/mp4",
    duration: probeDuration(out),
    loop: ext === ".gif",
    ...probeDimensions(out),
  };
}

// --- inbox discovery ---------------------------------------------------------

async function walk(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(full)));
    else out.push(full);
  }
  return out;
}

async function indexInbox() {
  if (!existsSync(INBOX)) return new Map();
  const byName = new Map();
  for (const f of await walk(INBOX)) {
    const name = path.basename(f);
    if (byName.has(name)) {
      throw new Error(
        `Two files in content/inbox/ share the basename "${name}":\n` +
        `  ${path.relative(ROOT, byName.get(name))}\n  ${path.relative(ROOT, f)}\n` +
        `content.json refers to media by basename, so one of these must be renamed.`,
      );
    }
    byName.set(name, f);
  }
  return byName;
}

// JSON strings can't span lines, so long texts may be authored as an array of
// paragraphs instead of one string full of \n escapes. Both forms end up as the
// same newline-separated string in the payload.
function flattenProse(data) {
  const join = (v) => (Array.isArray(v) ? v.join("\n\n") : v);
  if (data.giftReveal?.body) data.giftReveal.body = join(data.giftReveal.body);
  if (data.closing) data.closing = join(data.closing);
  for (const m of data.messages ?? []) if (m.body) m.body = join(m.body);
  for (const g of data.gallery ?? []) if (g.caption) g.caption = join(g.caption);
}

// Collects every media reference in content.json along with a setter, so the
// manifest entries can be substituted back into the same positions.
function collectRefs(data) {
  const refs = [];
  for (const m of data.messages ?? []) {
    if (!Array.isArray(m.media)) continue;
    m.media.forEach((name, i) => refs.push({ name, set: (v) => { m.media[i] = v; } }));
  }
  for (const g of data.gallery ?? []) {
    if (!g.file) continue;
    refs.push({ name: g.file, set: (v) => { delete g.file; g.media = v; } });
  }
  // The finale is a plain list of filenames — no captions, it's a wall of GIFs.
  (data.finale ?? []).forEach((name, i) => {
    refs.push({ name, set: (v) => { data.finale[i] = v; } });
  });
  return refs;
}

// --- passphrase --------------------------------------------------------------

const KEY_ENTER = ["\r", "\n"];
const KEY_EOT = "\u0004";        // ctrl-D
const KEY_INT = "\u0003";        // ctrl-C
const KEY_BACKSPACE = ["\u007f", "\b"];

function promptPassword(label) {
  return new Promise((resolve, reject) => {
    if (!process.stdin.isTTY) {
      reject(new Error(
        "No terminal available to prompt for the passphrase.\n" +
        "Set SITE_PASSWORD in the environment for non-interactive builds.",
      ));
      return;
    }
    process.stdout.write(label);
    const stdin = process.stdin;
    const wasRaw = stdin.isRaw;
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");

    let buf = "";
    const cleanup = () => {
      stdin.removeListener("data", onData);
      stdin.setRawMode(wasRaw);
      stdin.pause();
    };
    const onData = (chunk) => {
      // Iterate characters rather than treating the chunk as one keystroke:
      // a pasted passphrase arrives as a single multi-character chunk.
      for (const ch of chunk) {
        if (KEY_ENTER.includes(ch) || ch === KEY_EOT) {
          cleanup();
          process.stdout.write("\n");
          resolve(buf);
          return;
        }
        if (ch === KEY_INT) {
          cleanup();
          process.stdout.write("\n");
          process.exit(130);
        } else if (KEY_BACKSPACE.includes(ch)) {
          buf = buf.slice(0, -1);
        } else if (ch >= " ") {
          buf += ch;
        }
      }
    };
    stdin.on("data", onData);
  });
}

async function readExistingPayload() {
  if (!existsSync(ENC_JS)) return null;
  const src = await readFile(ENC_JS, "utf8");
  const match = src.match(/window\.__PAYLOAD__\s*=\s*(\{[\s\S]*\});?\s*$/);
  if (!match) return null;
  try {
    return JSON.parse(match[1]);
  } catch {
    return null;
  }
}

// --- main --------------------------------------------------------------------

async function main() {
  const argv = process.argv.slice(2);
  const scanOnly = argv.includes("--scan");
  const rotate = argv.includes("--rotate-password");

  if (!existsSync(CONTENT_JSON)) {
    throw new Error(`Missing ${path.relative(ROOT, CONTENT_JSON)} — that's where the texts live.`);
  }

  // The whole scheme collapses if the plaintext source is in the repo, so refuse
  // to build rather than quietly produce a site whose content is also public.
  const tracked = spawnSync("git", ["ls-files", "--error-unmatch", "content"], { cwd: ROOT, stdio: "ignore" });
  if (tracked.status === 0) {
    throw new Error(
      "content/ is tracked by git. It holds the plaintext texts, photos and voice\n" +
      "notes; committing it would publish everything the encryption is protecting.\n" +
      "Fix .gitignore and run: git rm -r --cached content",
    );
  }

  const data = JSON.parse(await readFile(CONTENT_JSON, "utf8"));
  flattenProse(data);
  const inbox = await indexInbox();
  const refs = collectRefs(data);
  const referenced = new Set(refs.map((r) => r.name));

  if (scanOnly) {
    const loose = [...inbox.keys()].filter((n) => !referenced.has(n)).sort();
    if (loose.length === 0) {
      console.log(`All ${inbox.size} file(s) in content/inbox/ are referenced in content.json.`);
      return;
    }
    console.log(`${loose.length} file(s) in content/inbox/ not yet referenced in content.json:\n`);
    for (const name of loose) {
      const kind = classify(inbox.get(name));
      const stub = kind === "audio"
        ? `  { "author": "NAME", "body": "", "media": [${JSON.stringify(name)}] },`
        : `  { "file": ${JSON.stringify(name)}, "caption": "" },`;
      console.log(`${stub}   // ${kind ?? "UNSUPPORTED TYPE"} — ${path.relative(ROOT, inbox.get(name))}`);
    }
    console.log(`\nAudio stubs go in "messages", the rest in "gallery".`);
    return;
  }

  const missing = [...referenced].filter((n) => !inbox.has(n));
  if (missing.length) {
    throw new Error(`content.json references files that aren't in content/inbox/:\n  ${missing.join("\n  ")}`);
  }

  // Reuse the existing salt so the derived key — and therefore every already
  // encrypted media blob — stays stable across builds. A fresh salt every run
  // would rewrite every file in media/ on every commit.
  const existing = rotate ? null : await readExistingPayload();
  const salt = existing?.salt
    ? base64ToBytes(existing.salt)
    : crypto.getRandomValues(new Uint8Array(SALT_BYTES));

  const password = process.env.SITE_PASSWORD || (await promptPassword("Passphrase: "));
  if (!password) throw new Error("Empty passphrase.");

  // A normal build verifies the passphrase against the existing payload below.
  // A rotation has nothing to verify against by definition, so it's the one case
  // where a typo would sail through and lock everyone out — confirm it instead.
  if (rotate && !process.env.SITE_PASSWORD) {
    if ((await promptPassword("Confirm new passphrase: ")) !== password) {
      throw new Error("The two entries didn't match. Nothing was changed.");
    }
  }
  const key = await deriveKey(password, salt);

  if (existing?.blob) {
    try {
      await openJSON(key, existing.blob);
    } catch {
      throw new Error(
        "That passphrase does not match the existing build.\n" +
        "If you mistyped it, just run again. If you really mean to change the\n" +
        "passphrase, run: node build-content.js --rotate-password",
      );
    }
  }

  await mkdir(CACHE, { recursive: true });
  await mkdir(MEDIA_OUT, { recursive: true });

  const rows = [];
  const usedIds = new Set();
  let rewritten = 0;

  for (const ref of refs) {
    const src = inbox.get(ref.name);
    const kind = classify(src);
    if (!kind) throw new Error(`Unsupported file type: ${path.relative(ROOT, src)}`);

    const srcBytes = await readFile(src);
    const cacheBase = path.join(CACHE, sha256(srcBytes).slice(0, 16));
    const metaPath = `${cacheBase}.meta.json`;

    let meta;
    if (existsSync(metaPath)) {
      meta = JSON.parse(await readFile(metaPath, "utf8"));
    } else {
      meta = normalize(src, kind, cacheBase);
      await writeFile(metaPath, JSON.stringify(meta), "utf8");
    }

    const derivative = await readFile(meta.file);
    // Salted, not a bare content hash. A bare sha256(plaintext) filename is a
    // confirmation oracle: anyone who already has a copy of a file — a public
    // GIF, a photo posted elsewhere — can recompute the name and prove it is on
    // the page without ever knowing the passphrase. The salt is public but
    // build-stable, so ids stay fixed across rebuilds and idempotence holds.
    const id = sha256(Buffer.concat([Buffer.from(salt), derivative])).slice(0, 32);
    const encPath = path.join(MEDIA_OUT, `${id}.enc`);
    usedIds.add(`${id}.enc`);

    // Idempotent: an existing blob that still decrypts to these exact bytes is
    // left alone, so unchanged media produce no git churn. Note this needs no
    // cached password material — the key itself is the check.
    let needsWrite = true;
    if (existsSync(encPath)) {
      try {
        const current = Buffer.from(await openBytes(key, await readFile(encPath)));
        needsWrite = !current.equals(derivative);
      } catch {
        needsWrite = true;
      }
    }
    if (needsWrite) {
      await writeFile(encPath, await sealBytes(key, derivative));
      rewritten++;
    }

    const { file, ...manifest } = meta;
    ref.set({ id, kind, ...manifest });
    rows.push({ name: ref.name, kind, bytes: derivative.length, src: srcBytes.length, rewritten: needsWrite });
  }

  // Drop blobs no longer referenced, so removing a photo from content.json
  // actually removes it from the published site.
  let pruned = 0;
  for (const f of await readdir(MEDIA_OUT)) {
    if (f.endsWith(".enc") && !usedIds.has(f)) {
      await unlink(path.join(MEDIA_OUT, f));
      pruned++;
    }
  }

  // Only rewrite the payload when the text actually changed. Every seal draws a
  // fresh IV, so re-encrypting identical content still produces a byte-different
  // file — without this check `content.enc.js` would show up as modified in git
  // after every single build, and "is my published payload current?" would stop
  // being answerable by looking at git status.
  let payloadChanged = true;
  if (existing?.blob) {
    try {
      payloadChanged = JSON.stringify(await openJSON(key, existing.blob)) !== JSON.stringify(data);
    } catch {
      payloadChanged = true;
    }
  }
  if (payloadChanged) {
    const payload = { salt: bytesToBase64(salt), blob: await sealJSON(key, data) };
    await writeFile(
      ENC_JS,
      `// AUTO-GENERATED by build-content.js — do not edit by hand.\n` +
      `window.__PAYLOAD__ = ${JSON.stringify(payload)};\n`,
      "utf8",
    );
  }

  // --- report ---
  const textBytes = (await readFile(ENC_JS)).length;
  const mediaBytes = rows.reduce((a, r) => a + r.bytes + 28, 0);
  console.log("");
  if (rows.length) {
    const w = Math.max(12, ...rows.map((r) => r.name.length));
    for (const r of rows) {
      console.log(
        `  ${r.name.padEnd(w)}  ${r.kind.padEnd(5)}  ${fmtBytes(r.src).padStart(9)} -> ` +
        `${fmtBytes(r.bytes).padStart(9)}${r.rewritten ? "  (encrypted)" : "  (unchanged)"}`,
      );
    }
    console.log("");
  }
  console.log(`  content.enc.js  ${fmtBytes(textBytes)}${payloadChanged ? " (rewritten)" : " (unchanged)"}   media/  ${rows.length} file(s), ${fmtBytes(mediaBytes)}`);
  console.log(`  ${rewritten} media encrypted this run, ${pruned} pruned.`);

  for (const r of rows) {
    if (r.bytes > WARN_SINGLE_BYTES) {
      console.warn(`  WARNING: ${r.name} is ${fmtBytes(r.bytes)} — consider trimming it.`);
    }
  }
  if (mediaBytes > WARN_TOTAL_BYTES) {
    console.warn(`  WARNING: total media ${fmtBytes(mediaBytes)} exceeds the ${fmtBytes(WARN_TOTAL_BYTES)} budget.`);
  }
  console.log("");
}

main().catch((err) => {
  console.error(`\n${err.message}\n`);
  process.exit(1);
});
