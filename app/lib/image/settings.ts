// Image Editor settings: defaults, presets, validation and the worker advice. Pure (no I/O), shared by the UI, the server and tests.

export type ImageOptions = {
  removeBg: boolean;
  /** "fast" uses the small model, "quality" the medium one (slower, cleaner edges) */
  bgQuality: "fast" | "quality";
  width: number;
  height: number;
  /** contain: subject sits inside the canvas | photo: every output keeps its own photo's proportions */
  fit: "contain" | "photo";
  /** empty space around the subject, % of the canvas */
  padding: number;
  trim: boolean;
  background: "color" | "transparent" | "gradient" | "blur";
  color: string;
  shadow: "none" | "soft" | "floor";
  shadowStrength: number;
  enhance: boolean;
  format: "jpg" | "png" | "webp";
  quality: number;
  /** 0 = off; otherwise lower the quality step by step until the file is at most this big */
  maxKB: number;
  suffix: string;
  keepFolders: boolean;
};

export const DEFAULT_OPTIONS: ImageOptions = {
  // Off by default: the AI cut-out is optional and needs a lot of memory. The person switches it on when they want it.
  removeBg: false,
  bgQuality: "quality",
  width: 1600,
  height: 1600,
  fit: "contain",
  padding: 8,
  trim: true,
  background: "color",
  color: "#ffffff",
  shadow: "none",
  shadowStrength: 40,
  enhance: false,
  format: "jpg",
  quality: 90,
  maxKB: 0,
  suffix: "",
  keepFolders: true,
};

export const LIMITS = { maxFiles: 500, maxFileBytes: 25 * 1024 * 1024, maxPixels: 100_000_000, maxSide: 4000, maxWorkers: 16 } as const;

export type Preset = { id: string; label: string; hint: string; options: Partial<ImageOptions> };

export const PRESETS: Preset[] = [
  { id: "shopify", label: "Shopify product", hint: "Square 2048, white background", options: { width: 2048, height: 2048, removeBg: false, background: "color", color: "#ffffff", shadow: "none", padding: 8, format: "jpg", quality: 90 } },
  { id: "marketplace", label: "Marketplace (Amazon / Flipkart)", hint: "Square 1600, pure white, no shadow", options: { width: 1600, height: 1600, removeBg: false, background: "color", color: "#ffffff", shadow: "none", padding: 6, format: "jpg", quality: 90, maxKB: 0 } },
  { id: "instagram", label: "Instagram 4:5", hint: "1080 x 1350, soft studio background", options: { width: 1080, height: 1350, removeBg: false, background: "gradient", shadow: "none", padding: 10, format: "jpg", quality: 88 } },
  { id: "cutout", label: "Transparent cut-out", hint: "PNG with no background, tightly cropped", options: { width: 2000, height: 2000, removeBg: true, background: "transparent", shadow: "none", padding: 4, format: "png" } },
  { id: "compress", label: "Resize and compress only", hint: "Keeps the photo as it is, makes it light for the web", options: { width: 1600, height: 1600, removeBg: false, fit: "photo", background: "color", color: "#ffffff", shadow: "none", padding: 0, trim: false, format: "webp", quality: 82, maxKB: 300 } },
];

const clampInt = (v: unknown, lo: number, hi: number, d: number) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d;
};
const pick = <T extends string>(v: unknown, allowed: readonly T[], d: T): T => (allowed.includes(v as T) ? (v as T) : d);
const bool = (v: unknown, d: boolean) => (typeof v === "boolean" ? v : v === "true" || v === "on" ? true : v === "false" ? false : d);

/** Turns any untrusted input (form, JSON) into safe options: unknown keys dropped, numbers clamped, enums whitelisted. */
export function normalizeOptions(input: unknown): ImageOptions {
  const o = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const d = DEFAULT_OPTIONS;
  const color = typeof o.color === "string" && /^#[0-9a-fA-F]{6}$/.test(o.color) ? o.color.toLowerCase() : d.color;
  return {
    removeBg: bool(o.removeBg, d.removeBg),
    bgQuality: pick(o.bgQuality, ["fast", "quality"], d.bgQuality),
    width: clampInt(o.width, 64, LIMITS.maxSide, d.width),
    height: clampInt(o.height, 64, LIMITS.maxSide, d.height),
    fit: pick(o.fit, ["contain", "photo"], d.fit),
    padding: clampInt(o.padding, 0, 40, d.padding),
    trim: bool(o.trim, d.trim),
    background: pick(o.background, ["color", "transparent", "gradient", "blur"], d.background),
    color,
    shadow: pick(o.shadow, ["none", "soft", "floor"], d.shadow),
    shadowStrength: clampInt(o.shadowStrength, 0, 100, d.shadowStrength),
    enhance: bool(o.enhance, d.enhance),
    format: pick(o.format, ["jpg", "png", "webp"], d.format),
    quality: clampInt(o.quality, 40, 100, d.quality),
    maxKB: clampInt(o.maxKB, 0, 20_000, d.maxKB),
    suffix: String(o.suffix ?? "").replace(/[^\w.-]/g, "").slice(0, 20),
    keepFolders: bool(o.keepFolders, d.keepFolders),
  };
}

/** A transparent background needs a format that can hold it. */
export function effectiveFormat(o: ImageOptions): ImageOptions["format"] {
  return o.background === "transparent" && o.format === "jpg" ? "png" : o.format;
}

export type WorkerAdvice = { recommended: number; max: number; note: string };

/**
 * How many workers to suggest. Measured on a 12-core PC: background removal (AI model) already keeps every core busy,
 * so extra workers do not make it faster, they only use more memory. Plain resize/convert jobs scale with workers.
 */
export function workerAdvice(cores: number, freeGB: number, removeBg: boolean): WorkerAdvice {
  const max = LIMITS.maxWorkers;
  if (removeBg) {
    const byRam = Math.max(1, Math.floor(freeGB / 1.2));
    return {
      recommended: Math.max(1, Math.min(2, byRam, cores >= 16 ? 2 : 1)),
      max,
      note: "Background removal already uses all your CPU cores, so more workers will not speed it up and each one needs about 0.6 GB of memory. Use 1 to 2.",
    };
  }
  const recommended = Math.max(1, Math.min(8, Math.floor(cores / 2)));
  return { recommended, max, note: "Resizing and converting scale with workers. About half of your CPU cores is a good start; push higher while watching the speed." };
}
