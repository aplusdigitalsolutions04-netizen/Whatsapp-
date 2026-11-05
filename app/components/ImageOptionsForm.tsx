import { useEffect, useState, type ReactNode } from "react";
import { Camera, Check, ChevronDown, Crop, Eraser, FileImage, Minimize2, Palette, Scissors, ShoppingBag, Sparkles, Store, X, type LucideIcon } from "lucide-react";
import { DEFAULT_OPTIONS, PRESETS, type ImageOptions } from "../lib/image/settings";

export function Compare({ before, after, onClose, title }: { before: string; after: string; onClose: () => void; title: string }) {
  const [pos, setPos] = useState(50);
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [onClose]);
  return (
    <div className="ie-modal" role="dialog" aria-modal="true" aria-label={`Compare ${title}`}>
      <button type="button" className="ie-backdrop" aria-label="Close preview" onClick={onClose} />
      <div className="ie-modal-box">
        <div className="ie-modal-head"><b>{title}</b><button className="ghost" onClick={onClose} aria-label="Close"><X size={14} /></button></div>
        <div className="ie-compare">
          {/* eslint-disable-next-line jsx-a11y/alt-text */}
          <img src={after} alt="After" />
          <div className="ie-compare-before" style={{ clipPath: `inset(0 ${100 - pos}% 0 0)` }}><img src={before} alt="Before" /></div>
          <div className="ie-compare-bar" style={{ left: `${pos}%` }} />
          <input type="range" min={0} max={100} value={pos} onChange={(e) => setPos(Number(e.target.value))} aria-label="Before and after" />
        </div>
        <div className="ie-compare-labels"><span>Before</span><span>After</span></div>
      </div>
    </div>
  );
}

const PRESET_ICONS: LucideIcon[] = [ShoppingBag, Store, Camera, Scissors, Minimize2];
const SWATCHES = ["#ffffff", "#f5efe6", "#e9e9e9", "#c9b8a3", "#111111"];

function Switch({ checked, onChange, label, hint, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; hint?: string; disabled?: boolean }) {
  return (
    <label className={`ox-switch${disabled ? " off" : ""}`}>
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <i aria-hidden="true" />
      <span><b>{label}</b>{hint && <small>{hint}</small>}</span>
    </label>
  );
}

function Seg<T extends string>({ value, options, onChange, label, disabled }: { value: T; options: { v: T; label: string }[]; onChange: (v: T) => void; label: string; disabled?: boolean }) {
  return (
    <div className="ox-seg" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button type="button" key={o.v} role="radio" aria-checked={value === o.v} className={value === o.v ? "on" : ""} disabled={disabled} onClick={() => onChange(o.v)}>{o.label}</button>
      ))}
    </div>
  );
}

/** A section that shows its name and current choice, and opens with a smooth animation when clicked. */
export function Panel({ icon: Icon, title, summary, children }: { icon: LucideIcon; title: string; summary: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <section className={`ox-panel${open ? " open" : ""}`}>
      <button type="button" className="ox-head" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <span className="ox-ico"><Icon size={16} /></span>
        <span className="ox-head-text"><b>{title}</b><small>{summary}</small></span>
        <ChevronDown size={16} className="ox-chev" />
      </button>
      <div className="ox-collapse" aria-hidden={!open}>
        <div className="ox-collapse-in"><div className="ox-body" {...({ inert: open ? undefined : "" } as Record<string, string | undefined>)}>{children}</div></div>
      </div>
    </section>
  );
}

const Slider = ({ label, value, min, max, unit = "", onChange, disabled }: { label: string; value: number; min: number; max: number; unit?: string; onChange: (n: number) => void; disabled?: boolean }) => (
  <div className={`ox-slider${disabled ? " off" : ""}`}>
    <div><span>{label}</span><b>{value}{unit}</b></div>
    <input type="range" min={min} max={max} value={value} disabled={disabled} onChange={(e) => onChange(Number(e.target.value))} aria-label={label} />
  </div>
);

/** Presets + every edit option, in plain language. Used by "Editor" and "Store products". `lockFormat` keeps a Shopify image's own file type. */
export function ImageOptionsForm({ opts, setOpts, preset, setPreset, lockFormat = false }: {
  opts: ImageOptions; setOpts: (f: (o: ImageOptions) => ImageOptions) => void; preset: string; setPreset: (id: string) => void; lockFormat?: boolean;
}) {
  const set = <K extends keyof ImageOptions>(k: K, v: ImageOptions[K]) => { setOpts((o) => ({ ...o, [k]: v })); setPreset("custom"); };
  const bgName = { color: "solid colour", gradient: "studio gradient", blur: "blurred photo", transparent: "transparent" }[opts.background];
  const summary = [
    opts.fit === "photo" ? `${opts.width}px long side` : `${opts.width} × ${opts.height} px`,
    lockFormat ? "same file type" : opts.background === "transparent" && opts.format === "jpg" ? "PNG" : opts.format.toUpperCase(),
    opts.removeBg ? `background removed, ${bgName}` : "photo kept as it is",
    opts.removeBg && opts.shadow !== "none" ? `${opts.shadow} shadow` : null,
    opts.maxKB > 0 ? `under ${opts.maxKB} KB` : null,
  ].filter(Boolean).join(" · ");
  const noColor = opts.background === "transparent" || opts.background === "blur";

  return (
    <div className="ox">
      <div className="ox-presets" role="radiogroup" aria-label="Start from a preset">
        {PRESETS.map((p, i) => {
          const Icon = PRESET_ICONS[i % PRESET_ICONS.length];
          return (
            <button key={p.id} type="button" role="radio" aria-checked={preset === p.id} className={`ox-preset${preset === p.id ? " on" : ""}`}
              onClick={() => { setOpts((o) => ({ ...DEFAULT_OPTIONS, suffix: o.suffix, keepFolders: o.keepFolders, ...p.options }) as ImageOptions); setPreset(p.id); }}>
              <span className="ox-ico"><Icon size={17} /></span>
              <b>{p.label}</b>
              <small>{p.hint}</small>
              {preset === p.id && <Check size={14} className="ox-tick" />}
            </button>
          );
        })}
      </div>
      <p className="ox-summary"><Sparkles size={14} /> <span>Result: {summary}</span>{preset === "custom" && <em>Custom</em>}</p>

      <div className="ox-grid">
        <Panel icon={Eraser} title="Background removal" summary={opts.removeBg ? `On · ${opts.bgQuality === "quality" ? "better edges" : "faster"}${opts.trim ? " · cropped" : ""}` : "Off · photo kept as it is"}>
          <Switch checked={opts.removeBg} onChange={(v) => set("removeBg", v)} label="Remove the background" hint="AI does this on your computer, nothing is sent anywhere." />
          <div className={`ox-sub${opts.removeBg ? "" : " off"}`}>
            <span className="ox-label">Cut-out quality</span>
            <Seg label="Cut-out quality" value={opts.bgQuality} disabled={!opts.removeBg} onChange={(v) => set("bgQuality", v)} options={[{ v: "quality", label: "Better edges" }, { v: "fast", label: "Faster" }]} />
            <Switch checked={opts.trim} disabled={!opts.removeBg} onChange={(v) => set("trim", v)} label="Crop empty space" hint="Fits the canvas tightly around the product." />
          </div>
          <Switch checked={opts.enhance} onChange={(v) => set("enhance", v)} label="Improve colours and sharpness" hint="A light automatic touch-up." />
        </Panel>

        <Panel icon={Crop} title="Size and shape" summary={`${opts.fit === "photo" ? `${opts.width}px long side` : `${opts.width} × ${opts.height} px`} · ${opts.padding}% space`}>
          <span className="ox-label">Shape</span>
          <Seg label="Shape" value={opts.fit} onChange={(v) => set("fit", v)} options={[{ v: "contain", label: "Fixed size" }, { v: "photo", label: "Keep photo shape" }]} />
          <span className="ox-label">{opts.fit === "photo" ? "Long side" : "Size"} in pixels</span>
          <div className="ox-chips">
            {[1000, 1600, 2048].map((n) => (
              <button type="button" key={n} className={opts.width === n && (opts.fit === "photo" || opts.height === n) ? "on" : ""} onClick={() => { set("width", n); if (opts.fit === "contain") set("height", n); }}>{n}</button>
            ))}
          </div>
          <div className="ox-two">
            <label><span>{opts.fit === "photo" ? "Long side" : "Width"}</span><input type="number" min={64} max={4000} value={opts.width} onChange={(e) => set("width", Number(e.target.value))} /></label>
            {opts.fit === "contain" && <label><span>Height</span><input type="number" min={64} max={4000} value={opts.height} onChange={(e) => set("height", Number(e.target.value))} /></label>}
          </div>
          <Slider label="Space around the product" value={opts.padding} min={0} max={30} unit="%" onChange={(n) => set("padding", n)} />
        </Panel>

        <Panel icon={Palette} title="Background and shadow" summary={`${bgName}${opts.shadow !== "none" ? ` · ${opts.shadow} shadow` : " · no shadow"}`}>
          <span className="ox-label">Background</span>
          <Seg label="Background" value={opts.background} onChange={(v) => set("background", v)} options={[{ v: "color", label: "Colour" }, { v: "gradient", label: "Studio" }, { v: "blur", label: "Blur" }, { v: "transparent", label: "None" }]} />
          <div className={`ox-colors${noColor ? " off" : ""}`} role="group" aria-label="Background colour">
            {SWATCHES.map((c) => (
              <button type="button" key={c} style={{ background: c }} className={opts.color === c ? "on" : ""} aria-label={c} disabled={noColor} onClick={() => set("color", c)} />
            ))}
            <label className="ox-custom" title="Pick any colour"><input type="color" value={opts.color} disabled={noColor} onChange={(e) => set("color", e.target.value)} aria-label="Custom colour" /><span style={{ background: opts.color }} /></label>
          </div>
          <span className="ox-label">Shadow</span>
          <Seg label="Shadow" value={opts.shadow} onChange={(v) => set("shadow", v)} options={[{ v: "none", label: "None" }, { v: "floor", label: "Floor" }, { v: "soft", label: "Soft" }]} />
          <Slider label="Shadow strength" value={opts.shadowStrength} min={0} max={100} unit="%" disabled={opts.shadow === "none"} onChange={(n) => set("shadowStrength", n)} />
          {opts.shadow !== "none" && !opts.removeBg && <p className="ox-note">A shadow needs the background removal to be on.</p>}
        </Panel>

        <Panel icon={FileImage} title="File" summary={`${lockFormat ? "Same file type" : opts.format.toUpperCase()} · quality ${opts.quality}${opts.maxKB > 0 ? ` · under ${opts.maxKB} KB` : ""}`}>
          {lockFormat ? (
            <p className="ox-note ok">Each photo keeps its own file type (JPG, PNG or WebP), so it can replace the image in Shopify.</p>
          ) : (
            <>
              <span className="ox-label">Format</span>
              <Seg label="Format" value={opts.format} onChange={(v) => set("format", v)} options={[{ v: "jpg", label: "JPG" }, { v: "webp", label: "WebP" }, { v: "png", label: "PNG" }]} />
              {opts.background === "transparent" && opts.format === "jpg" && <p className="ox-note">JPG cannot be transparent, PNG will be used.</p>}
            </>
          )}
          <Slider label="Quality" value={opts.quality} min={40} max={100} onChange={(n) => set("quality", n)} />
          <span className="ox-label">Largest file size</span>
          <div className="ox-chips">
            {[{ n: 0, t: "No limit" }, { n: 200, t: "200 KB" }, { n: 500, t: "500 KB" }, { n: 1000, t: "1 MB" }].map((c) => (
              <button type="button" key={c.n} className={opts.maxKB === c.n ? "on" : ""} onClick={() => set("maxKB", c.n)}>{c.t}</button>
            ))}
          </div>
          {!lockFormat && (
            <details className="ox-more">
              <summary>More options</summary>
              <label className="ox-field"><span>Add to file names</span><input value={opts.suffix} maxLength={20} placeholder="_web" onChange={(e) => set("suffix", e.target.value)} /></label>
              <Switch checked={opts.keepFolders} onChange={(v) => set("keepFolders", v)} label="Keep folders inside the ZIP" />
            </details>
          )}
        </Panel>
      </div>
    </div>
  );
}
