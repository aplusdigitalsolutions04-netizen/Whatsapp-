// Image Editor pipeline for ONE photo. Plain ESM so a worker process can run it without the app's bundler, and tests can import it.
// Steps: read + validate -> (optional) AI background removal -> trim -> enhance -> place on canvas -> shadow -> encode -> thumbnails.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";

const MAX_PIXELS = 100_000_000;
let remover = null;
const getRemover = async () => (remover ??= (await import("@imgly/background-removal-node")).removeBackground);

const hex = (c) => {
  const n = parseInt(c.slice(1), 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
};
const mix = (a, b, t) => ({ r: Math.round(a.r + (b.r - a.r) * t), g: Math.round(a.g + (b.g - a.g) * t), b: Math.round(a.b + (b.b - a.b) * t) });
const css = (c) => `rgb(${c.r},${c.g},${c.b})`;

/** Smallest box that contains every pixel whose alpha is above the threshold (null when the image is fully transparent). */
async function alphaBounds(buf, threshold = 12) {
  const { data, info } = await sharp(buf).ensureAlpha().extractChannel("alpha").raw().toBuffer({ resolveWithObject: true });
  const { width: w, height: h } = info;
  let minX = w, minY = h, maxX = -1, maxY = -1;
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      if (data[row + x] > threshold) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  return maxX < 0 ? null : { left: minX, top: minY, width: maxX - minX + 1, height: maxY - minY + 1, w, h };
}

/** The AI must really have removed something: refuse to present an untouched photo as a cut-out. */
async function hasTransparency(buf) {
  const { data } = await sharp(buf).resize(160, 160, { fit: "inside" }).ensureAlpha().extractChannel("alpha").raw().toBuffer({ resolveWithObject: true });
  for (let i = 0; i < data.length; i++) if (data[i] < 250) return true;
  return false;
}

async function backgroundLayer(o, outW, outH, photoBuf) {
  if (o.background === "transparent") return sharp({ create: { width: outW, height: outH, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } });
  if (o.background === "gradient") {
    const base = hex(o.color);
    const center = mix(base, { r: 255, g: 255, b: 255 }, 0.55);
    const edge = mix(base, { r: 150, g: 140, b: 130 }, base.r + base.g + base.b > 700 ? 0.16 : 0.3);
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${outW}" height="${outH}"><defs><radialGradient id="g" cx="50%" cy="42%" r="78%"><stop offset="0" stop-color="${css(center)}"/><stop offset="1" stop-color="${css(edge)}"/></radialGradient></defs><rect width="100%" height="100%" fill="url(#g)"/></svg>`;
    return sharp(Buffer.from(svg));
  }
  if (o.background === "blur") {
    return sharp(await sharp(photoBuf).resize(outW, outH, { fit: "cover" }).blur(38).modulate({ brightness: 0.92 }).jpeg({ quality: 80 }).toBuffer());
  }
  const c = hex(o.color);
  return sharp({ create: { width: outW, height: outH, channels: 3, background: c } });
}

async function shadowLayer(subject, w, h, o) {
  const k = o.shadowStrength / 100;
  if (o.shadow === "floor") {
    const ew = Math.round(w * 0.86);
    const eh = Math.max(10, Math.round(h * 0.07));
    const pad = Math.round(eh * 2);
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${ew + pad * 2}" height="${eh + pad * 2}"><ellipse cx="${(ew + pad * 2) / 2}" cy="${(eh + pad * 2) / 2}" rx="${ew / 2}" ry="${eh / 2}" fill="rgba(0,0,0,${(0.55 * k).toFixed(3)})"/></svg>`;
    const buf = await sharp(Buffer.from(svg)).blur(Math.max(2, eh * 0.55)).png().toBuffer();
    return { buf, dx: Math.round((w - (ew + pad * 2)) / 2), dy: Math.round(h - eh - pad * 1.3) };
  }
  // soft: a blurred, tinted copy of the subject's own outline, dropped slightly below it
  const m = Math.max(12, Math.round(Math.min(w, h) * 0.06));
  const padded = await sharp(subject).ensureAlpha().extend({ top: m, bottom: m, left: m, right: m, background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toBuffer();
  const meta = await sharp(padded).metadata();
  const alpha = await sharp(padded).extractChannel("alpha").blur(Math.max(2, m * 0.45)).linear(0.55 * k, 0).raw().toBuffer();
  const buf = await sharp({ create: { width: meta.width, height: meta.height, channels: 3, background: { r: 0, g: 0, b: 0 } } })
    .joinChannel(alpha, { raw: { width: meta.width, height: meta.height, channels: 1 } })
    .png()
    .toBuffer();
  return { buf, dx: -m, dy: -m + Math.round(m * 0.45) };
}

async function encodeRaw(raw, info, o, ext) {
  const make = (q) => {
    const img = sharp(raw, { raw: { width: info.width, height: info.height, channels: info.channels } });
    if (ext === "jpg") return img.flatten({ background: o.color }).jpeg({ quality: q, mozjpeg: true }).toBuffer();
    if (ext === "webp") return img.webp({ quality: q, effort: 4 }).toBuffer();
    return img.png({ compressionLevel: 9, effort: 7 }).toBuffer();
  };
  let q = o.quality;
  let out = await make(q);
  let note = "";
  const limit = o.maxKB * 1024;
  if (limit > 0) {
    if (ext === "png") note = "PNG cannot be shrunk by quality. Choose WebP or JPG for a size limit.";
    else if (out.length > limit) {
      let lo = 35, hi = q;
      for (let i = 0; i < 6 && hi - lo > 1; i++) {
        const mid = Math.round((lo + hi) / 2);
        const t = await make(mid);
        if (t.length <= limit) { out = t; q = mid; lo = mid; } else hi = mid;
      }
      if (out.length > limit) {
        out = await make(lo);
        note = `Could not reach ${o.maxKB} KB (smallest was ${(out.length / 1024).toFixed(0)} KB).`;
      }
    }
  }
  return { out, quality: q, note };
}

/**
 * Processes one file. `task`: { inPath, outBase, thumbPath, origPath, options }. Returns { ext, width, height, inBytes, outBytes, note, ms }.
 * Throws an Error with a plain message when the photo cannot be processed (never returns a fake result).
 */
export async function processImage(task) {
  const t0 = Date.now();
  const o = task.options;
  const input = await readFile(task.inPath);
  let meta;
  try {
    meta = await sharp(input, { limitInputPixels: MAX_PIXELS }).metadata();
  } catch {
    throw new Error("This file is not a readable image (or it is larger than 100 megapixels).");
  }
  if (!["jpeg", "png", "webp"].includes(meta.format ?? "")) throw new Error("Unsupported image type. Use JPG, PNG or WebP.");
  const swap = (meta.orientation ?? 1) >= 5;
  const srcW = swap ? meta.height : meta.width;
  const srcH = swap ? meta.width : meta.height;
  // A photo that replaces a Shopify image must keep that image's type (task.forceExt); otherwise follow the options.
  const ext = task.forceExt || (o.background === "transparent" && o.format === "jpg" ? "png" : o.format);
  let note = "";

  // 1. working copy (EXIF-rotated, capped so the AI step stays fast)
  const target = Math.max(o.width, o.height);
  const work = Math.min(3000, Math.max(1200, Math.round(target * 1.25)));
  const workBuf = await sharp(input, { limitInputPixels: MAX_PIXELS })
    .rotate()
    .resize({ width: work, height: work, fit: "inside", withoutEnlargement: true })
    .png({ compressionLevel: 1 })
    .toBuffer();

  // 2. background removal (optional: when the AI package is not installed on this server the photo is still edited)
  let subject = workBuf;
  let removeBg = o.removeBg;
  let remove = null;
  if (removeBg) {
    try {
      remove = await getRemover();
    } catch {
      removeBg = false;
      note = "Background removal is not available on this server, so the photo was only resized and placed on the background.";
    }
  }
  if (removeBg) {
    const blob = await remove(new Blob([workBuf], { type: "image/png" }), { model: o.bgQuality === "quality" ? "medium" : "small", output: { format: "image/png" } });
    subject = Buffer.from(await blob.arrayBuffer());
    if (!(await hasTransparency(subject))) throw new Error("No background could be removed from this photo. Turn off Remove background for it.");
  }

  // 3. enhance + trim
  if (o.enhance) subject = await sharp(subject).normalise().modulate({ brightness: 1.03, saturation: 1.06 }).sharpen({ sigma: 0.6 }).png({ compressionLevel: 1 }).toBuffer();
  if (removeBg) {
    const b = await alphaBounds(subject);
    if (!b) throw new Error("Nothing was left after removing the background.");
    if (o.trim) subject = await sharp(subject).extract({ left: b.left, top: b.top, width: b.width, height: b.height }).png({ compressionLevel: 1 }).toBuffer();
  } else if (o.trim) {
    try {
      subject = await sharp(subject).trim({ threshold: 14 }).png({ compressionLevel: 1 }).toBuffer();
    } catch {
      /* a uniform photo cannot be trimmed: keep it whole */
    }
  }

  // 4. canvas and placement
  let outW = o.width;
  let outH = o.height;
  if (o.fit === "photo") {
    const k = target / Math.max(srcW, srcH);
    outW = Math.max(64, Math.round(srcW * k));
    outH = Math.max(64, Math.round(srcH * k));
  }
  const p = o.padding / 100;
  const boxW = Math.max(16, Math.round(outW * Math.max(0.2, 1 - 2 * p)));
  const boxH = Math.max(16, Math.round(outH * Math.max(0.2, 1 - 2 * p)));
  const placed = await sharp(subject).resize({ width: boxW, height: boxH, fit: "inside", kernel: "lanczos3" }).png().toBuffer({ resolveWithObject: true });
  const w = placed.info.width;
  const h = placed.info.height;
  const left = Math.round((outW - w) / 2);
  const top = Math.round((outH - h) / 2);

  const layers = [];
  if (o.shadow !== "none" && o.shadowStrength > 0) {
    if (!removeBg) note = note || "Shadow needs Remove background (there is no outline to shadow).";
    else {
      const s = await shadowLayer(placed.data, w, h, o);
      layers.push({ input: s.buf, left: Math.max(0, left + s.dx), top: Math.max(0, top + s.dy) });
    }
  }
  layers.push({ input: placed.data, left, top });

  const bg = await backgroundLayer(o, outW, outH, workBuf);
  const composed = await bg.composite(layers).ensureAlpha().raw().toBuffer({ resolveWithObject: true });

  // 5. encode (+ size limit), save, thumbnails
  const enc = await encodeRaw(composed.data, composed.info, o, ext);
  if (enc.note) note = note ? `${note} ${enc.note}` : enc.note;
  const outPath = `${task.outBase}.${ext}`;
  await mkdir(path.dirname(outPath), { recursive: true });
  await writeFile(outPath, enc.out);

  const thumb = await sharp(composed.data, { raw: composed.info }).resize(360, 360, { fit: "inside" }).webp({ quality: 78 }).toBuffer();
  await mkdir(path.dirname(task.thumbPath), { recursive: true });
  await writeFile(task.thumbPath, thumb);
  const orig = await sharp(workBuf).resize(360, 360, { fit: "inside" }).webp({ quality: 78 }).toBuffer();
  await mkdir(path.dirname(task.origPath), { recursive: true });
  await writeFile(task.origPath, orig);

  return { ext, width: outW, height: outH, inBytes: input.length, outBytes: enc.out.length, note, ms: Date.now() - t0 };
}
