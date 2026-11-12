import { useEffect, useRef, useState, type CSSProperties } from "react";
import type { ActionFunctionArgs, LinksFunction, LoaderFunctionArgs, MetaFunction } from "react-router";
import { redirect, Form, useActionData, useLoaderData } from "react-router";

import { login } from "../../shopify.server";
import { loginErrorMessage } from "./error.server";
import { MASCOT_SVG } from "./mascot";

import pageStyles from "./jazz.css?url";

export const meta: MetaFunction = () => [
  { title: "ShopPilot: WhatsApp bot, order updates and store tools for Shopify" },
  { name: "description", content: "Hi, I'm JAZZ. I answer your customers' order, tracking and product questions on WhatsApp 24/7. Plus order sheet, product scrapper, image editor and SEO tools in one Shopify app." },
];

export const links: LinksFunction = () => [{ rel: "stylesheet", href: pageStyles }];

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);

  if (url.searchParams.get("shop")) {
    throw redirect(`/app?${url.searchParams.toString()}`);
  }

  return { showForm: Boolean(login) };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const errors = loginErrorMessage(await login(request));

  return { errors };
};

/* ------------------------------------------------------------------ data */

const SUPPORT_EMAIL = "support@wery.in";
const SUPPORT_PHONE = "+91 92118 90093";
const SUPPORT_TEL = "+919211890093";

const ICON: Record<string, string> = {
  chat: '<path d="M21 12a8.5 8.5 0 0 1-12.4 7.5L3 21l1.6-5.4A8.5 8.5 0 1 1 21 12Z"/>',
  bag: '<path d="M5 8h14l-1 12H6L5 8Z"/><path d="M9 8a3 3 0 0 1 6 0"/>',
  truck: '<path d="M3 6h11v10H3zM14 9h4l3 3v4h-7z"/><circle cx="7" cy="18" r="1.8"/><circle cx="17" cy="18" r="1.8"/>',
  sheet: '<rect x="4" y="3" width="16" height="18" rx="2"/><path d="M4 9h16M4 15h16M10 3v18"/>',
  bell: '<path d="M6 9a6 6 0 0 1 12 0c0 6 2 7 2 7H4s2-1 2-7ZM10 20a2 2 0 0 0 4 0"/>',
  box: '<path d="M21 8 12 3 3 8l9 5 9-5ZM3 8v8l9 5 9-5V8M12 13v8"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  lang: '<path d="M4 5h9M8.5 3v2M6 5c1 4 3 6 6 8M11 5c-1 4-3 6-6 8M13 20l4-10 4 10M14.5 17h5"/>',
  seo: '<path d="M3 17 9 11l4 4 8-9M15 6h6v6"/>',
  img: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="2"/><path d="m21 16-5-5-8 8"/>',
  scrape: '<path d="M4 7V5a1 1 0 0 1 1-1h2M17 4h2a1 1 0 0 1 1 1v2M20 17v2a1 1 0 0 1-1 1h-2M7 20H5a1 1 0 0 1-1-1v-2M8 12h8"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  grid: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
  shield: '<path d="M12 3 5 6v6c0 4.5 3 7.5 7 9 4-1.5 7-4.5 7-9V6l-7-3Z"/><path d="m9 12 2 2 4-4"/>',
  user: '<circle cx="12" cy="8" r="3.5"/><path d="M5 20c1-4 4-6 7-6s6 2 7 6"/>',
  mail: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 7 9 6 9-6"/>',
  phone: '<path d="M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2Z"/>',
  check: '<path d="m5 12 4.5 4.5L19 7"/>',
  out: '<path d="M7 17 17 7M8 7h9v9"/>',
  down: '<path d="M12 4v11m0 0-4-4m4 4 4-4M5 20h14"/>',
};

function Ico({ n, w = 1.8 }: { n: string; w?: number }) {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={w} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" dangerouslySetInnerHTML={{ __html: ICON[n] }} />;
}

// Bars are a visual style (how much JAZZ covers); the label on the right says what each one does.
const SKILLS: [string, string, string, number][] = [
  ["box", "Order status", "Instant", 98],
  ["truck", "Delhivery tracking", "Pre-filled link", 95],
  ["search", "Product search", "With photos", 92],
  ["lang", "Hindi & Hinglish", "Automatic", 90],
  ["bell", "Support alerts", "Live", 100],
  ["sheet", "Order sheet sync", "Google Sheets", 94],
  ["seo", "SEO fixer", "In bulk", 88],
  ["img", "Image editor", "In bulk", 86],
  ["scrape", "Product scrapper", "CSV + ZIP", 90],
];

const TOOLS: [string, string][] = [
  ["chat", "WhatsApp"], ["bag", "Shopify"], ["truck", "Delhivery"], ["sheet", "Google Sheets"],
];

const SAYS = ["Hi! 👋 I'm JAZZ.", "Order #W0000 is on the way 🚚", "Total ₹1,499 · Delhivery", "नमस्ते! मैं मदद करूँ?", "Need a person? I'll alert your team 🔔"];
const ROLES = ["answer orders on WhatsApp.", "track parcels for customers.", "speak Hindi, English & Hinglish.", "call you when it matters."];
const CODE = [
  '<span class="c">// customer</span>\n<span class="k">message</span>: <span class="s">"#W0000"</span>',
  '<span class="k">jazz</span>.verify(<span class="n">phone</span>)  <span class="s">✔ match</span>',
  '<span class="k">status</span>: <span class="s">"In transit"</span>',
  '<span class="k">courier</span>: <span class="s">"Delhivery"</span>',
  '<span class="k">track</span>: <span class="s">"DL123456789"</span>',
  '<span class="k">total</span>: <span class="n">₹1,499</span>',
];

const reduced = () => typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/* ------------------------------------------------------------------ small animated pieces */

function Typed() {
  const [text, setText] = useState(ROLES[0]);
  useEffect(() => {
    if (reduced()) return;
    let li = 0, ci = 0, del = false, t: number;
    const step = () => {
      const full = ROLES[li];
      setText(full.slice(0, ci));
      if (!del && ci < full.length) { ci++; t = window.setTimeout(step, 55); }
      else if (!del) { del = true; t = window.setTimeout(step, 1500); }
      else if (ci > 0) { ci--; t = window.setTimeout(step, 24); }
      else { del = false; li = (li + 1) % ROLES.length; t = window.setTimeout(step, 300); }
    };
    step();
    return () => clearTimeout(t);
  }, []);
  return <><span className="typed">{text}</span><span className="caret" /></>;
}

function Say() {
  const [i, setI] = useState(0);
  useEffect(() => {
    if (reduced()) return;
    const t = window.setInterval(() => setI((n) => (n + 1) % SAYS.length), 3200);
    return () => clearInterval(t);
  }, []);
  return <div className="say" key={i}>{SAYS[i]}</div>;
}

function CodeCard() {
  const [n, setN] = useState(CODE.length);
  useEffect(() => {
    if (reduced()) return;
    let k = 0;
    const t = window.setInterval(() => { k = (k + 1) % (CODE.length + 3); setN(Math.min(k, CODE.length)); }, 1100);
    return () => clearInterval(t);
  }, []);
  return (
    <div className="card-code" aria-hidden="true">
      <header><span>&lt;/&gt; live chat</span><i /></header>
      <pre dangerouslySetInnerHTML={{ __html: CODE.slice(0, n).join("\n") + (n < CODE.length ? '<span class="caret" style="height:1em;width:2px"></span>' : "") }} />
    </div>
  );
}

function DotNav() {
  const [on, setOn] = useState(0);
  useEffect(() => {
    if (reduced()) return;
    const t = window.setInterval(() => setOn((n) => (n + 1) % 3), 2600);
    return () => clearInterval(t);
  }, []);
  return <div className="dotnav" aria-hidden="true">{[0, 1, 2].map((i) => <i key={i} className={i === on ? "on" : ""} />)}</div>;
}

function LoginForm({ errors, id }: { errors?: { shop?: string }; id: string }) {
  return (
    <Form className="login" method="post">
      <div className="loginrow">
        <input id={id} type="text" name="shop" placeholder="your-store.myshopify.com" aria-label="Shop domain" autoComplete="off" spellCheck={false} />
        <button className="btn primary" type="submit">Install on Shopify <Ico n="out" w={2.2} /></button>
      </div>
      <span className="hint" role={errors?.shop ? "alert" : undefined} data-error={errors?.shop ? "1" : undefined}>
        {errors?.shop ?? "Enter your store address, for example my-shop.myshopify.com"}
      </span>
    </Form>
  );
}

/* ------------------------------------------------------------------ page */

export default function App() {
  const { showForm } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const errors = actionData?.errors;
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = root.current;
    if (!el) return;
    const reduce = reduced();

    /* scroll reveal, counters, skill bars */
    const countUp = (n: HTMLElement) => {
      const to = Number(n.dataset.count), t0 = performance.now();
      if (reduce) { n.textContent = String(to); return; }
      const tick = (t: number) => { const p = Math.min(1, (t - t0) / 1400); n.textContent = String(Math.round(to * (1 - Math.pow(1 - p, 3)))); if (p < 1) requestAnimationFrame(tick); };
      requestAnimationFrame(tick);
    };
    const reveal = (n: Element) => {
      n.classList.add("in");
      n.querySelectorAll<HTMLElement>("[data-count]").forEach(countUp);
      const bar = n.querySelector<HTMLElement>(".bar i");
      if (bar) bar.style.width = `${bar.dataset.w}%`;
    };
    el.querySelectorAll<HTMLElement>("[data-count]").forEach((n) => { if (!reduce) n.textContent = "0"; });
    const items = Array.from(el.querySelectorAll<HTMLElement>(".reveal"));
    const vh = window.innerHeight;
    el.classList.add("ready");
    items.forEach((n) => n.getBoundingClientRect().top < vh * 0.95 && reveal(n));
    const io = new IntersectionObserver((es) => es.forEach((e) => { if (e.isIntersecting) { reveal(e.target); io.unobserve(e.target); } }), { threshold: 0.15 });
    items.forEach((n) => !n.classList.contains("in") && io.observe(n));

    /* JAZZ's eyes follow the cursor; a happy hop on hover */
    const bot = el.querySelector<SVGSVGElement>("#bot");
    const eyes = el.querySelector<SVGGElement>("#eyes");
    const onMove = (e: PointerEvent) => {
      if (!bot || !eyes) return;
      const r = bot.getBoundingClientRect();
      const dx = Math.max(-1, Math.min(1, (e.clientX - (r.left + r.width / 2)) / 400));
      const dy = Math.max(-1, Math.min(1, (e.clientY - (r.top + r.height * 0.38)) / 400));
      eyes.style.transform = `translate(${dx * 8}px, ${dy * 6}px)`;
    };
    const onEnter = () => bot?.animate([{ transform: "scale(1)" }, { transform: "scale(1.05) rotate(-1.5deg)" }, { transform: "scale(1)" }], { duration: 500, easing: "ease-out" });
    if (!reduce) { window.addEventListener("pointermove", onMove); bot?.addEventListener("pointerenter", onEnter); }

    /* 3D tilt on the feature cards */
    const tilts: [HTMLElement, (e: PointerEvent) => void, () => void][] = [];
    if (!reduce) el.querySelectorAll<HTMLElement>(".pcard").forEach((c) => {
      const move = (e: PointerEvent) => {
        const r = c.getBoundingClientRect(), x = (e.clientX - r.left) / r.width - 0.5, y = (e.clientY - r.top) / r.height - 0.5;
        c.style.transform = `rotateY(${x * 9}deg) rotateX(${-y * 9}deg) translateY(-6px)`;
      };
      const leave = () => { c.style.transform = ""; };
      c.addEventListener("pointermove", move);
      c.addEventListener("pointerleave", leave);
      tilts.push([c, move, leave]);
    });

    /* highlight the menu link of the section on screen */
    const links = Array.from(el.querySelectorAll<HTMLAnchorElement>(".links a"));
    const secs = links.map((a) => el.querySelector(a.getAttribute("href") ?? ""));
    const onScroll = () => {
      let cur = 0;
      secs.forEach((s, i) => { if (s && s.getBoundingClientRect().top < window.innerHeight * 0.4) cur = i; });
      links.forEach((a, i) => a.classList.toggle("on", i === cur));
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    onScroll();

    return () => {
      io.disconnect();
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("scroll", onScroll);
      bot?.removeEventListener("pointerenter", onEnter);
      tilts.forEach(([c, m, l]) => { c.removeEventListener("pointermove", m); c.removeEventListener("pointerleave", l); });
    };
  }, []);

  return (
    <div className="jp" ref={root}>
      <div className="ambient" aria-hidden="true"><i /><i /><i /></div>

      {/* ------------------------------------------------ nav */}
      <nav className="top">
        <div className="wrap">
          <a className="logo" href="#home" aria-label="ShopPilot home">
            <svg viewBox="0 0 40 40" aria-hidden="true"><defs><linearGradient id="lg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#ead3ad" /><stop offset="1" stopColor="#b8935f" /></linearGradient></defs><rect x="4" y="8" width="32" height="26" rx="10" fill="url(#lg)" /><rect x="9" y="13" width="22" height="14" rx="6" fill="#1a120c" /><circle cx="16" cy="20" r="2.6" fill="#ffd89a" /><circle cx="24" cy="20" r="2.6" fill="#ffd89a" /><rect x="19" y="2" width="2" height="7" rx="1" fill="#d9b98a" /><circle cx="20" cy="3" r="2.4" fill="#ead3ad" /></svg>
            ShopPilot
          </a>
          <div className="links">
            <a href="#home" className="on">Home</a><a href="#about">About</a><a href="#skills">Skills</a><a href="#work">Features</a><a href="#contact">Contact</a>
          </div>
          <a className="btn primary" href="#start">Install App <Ico n="out" w={2.2} /></a>
        </div>
      </nav>

      {/* ------------------------------------------------ hero */}
      <header className="hero" id="home">
        <div className="wrap">
          <div>
            <span className="pill">I&apos;M A WHATSAPP ASSISTANT</span>
            <h1>Hi, I&apos;m <span className="name">JAZZ</span></h1>
            <h2>I <Typed /></h2>
            <p className="lead">I&apos;m the assistant inside ShopPilot. I answer your customers&apos; order, tracking and product questions on WhatsApp, day and night, and call you in when a person is needed.</p>
            <div className="cta" id="start">
              {showForm ? <LoginForm errors={errors} id="shop-hero" /> : <a className="btn primary" href="#work">See What I Do <Ico n="out" w={2.2} /></a>}
            </div>
            <div className="cta">
              <a className="btn ghost" href="#work">See What I Do <Ico n="out" w={2.2} /></a>
            </div>
            <div className="stack">
              <small>THINGS I WORK WITH</small>
              <div className="tools">
                {TOOLS.map(([i, label]) => <span className="tool" key={label}><Ico n={i} /><em>{label}</em></span>)}
                <span className="tool"><b>₹</b><em>Prices in rupees</em></span>
                <span className="tool"><b>अ</b><em>Hindi + Hinglish</em></span>
                <span className="tool"><Ico n="bell" /><em>Support alerts</em></span>
              </div>
            </div>
          </div>

          <div className="art">
            <div className="halo" />
            <div className="dots" />
            <svg className="doodle" viewBox="0 0 90 110" aria-hidden="true"><path d="M62 6C28 14 10 52 36 76c10 9 26 10 36-2M72 74l-4-16M72 74l-17-2" /></svg>
            <Say />
            <div className="botwrap" dangerouslySetInnerHTML={{ __html: MASCOT_SVG }} />
            <CodeCard />
          </div>
        </div>
      </header>

      {/* ------------------------------------------------ about */}
      <section className="about alt" id="about">
        <div className="wrap">
          <div className="reveal">
            <span className="tag">ABOUT ME</span>
            <h2>I&apos;m passionate about<br />answering your customers</h2>
            <p>I never sleep, I never get tired, and I always check the order number against the registered phone before I share anything. When a person is needed, I tell your team with an alert.</p>
            <a className="btn ghost" href="#skills">Learn More About Me <Ico n="user" w={2.2} /></a>
          </div>
          <div className="stats reveal">
            <div className="stat"><span className="ic"><Ico n="clock" /></span><div><b><span data-count="24">24</span>/7</b><span>Always on</span></div></div>
            <div className="stat"><span className="ic"><Ico n="lang" /></span><div><b data-count="3">3</b><span>Languages</span></div></div>
            <div className="stat"><span className="ic"><Ico n="grid" /></span><div><b><span data-count="8">8</span>+</b><span>Tools in one app</span></div></div>
            <div className="stat"><span className="ic"><Ico n="shield" /></span><div><b><span data-count="100">100</span>%</b><span>Phone-verified orders</span></div></div>
          </div>
        </div>
      </section>

      {/* ------------------------------------------------ skills */}
      <section className="skills" id="skills">
        <div className="wrap">
          <div className="head reveal"><span className="tag">MY SKILLS</span><h2>Things I Master</h2></div>
          <div className="sgrid">
            {SKILLS.map(([i, name, note, pct]) => (
              <div className="skill reveal" key={name}>
                <div className="row"><span className="ic"><Ico n={i} w={1.9} /></span><b>{name}</b><span className="note">{note}</span></div>
                <div className="bar"><i style={{ "--w": `${pct}%` } as CSSProperties} data-w={pct} /></div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ------------------------------------------------ features */}
      <section className="work alt" id="work">
        <div className="wrap">
          <div className="head reveal"><span className="tag">FEATURED TOOLS</span><h2>Some of My Recent Work</h2></div>
          <div className="cards">
            <article className="pcard reveal">
              <div className="shot"><span className="num">01</span>
                <div className="m-chat"><div className="me">#W0000</div><div className="jz">Order #W0000 · Fulfilled · ₹1,499</div><div className="jz">Delhivery · DL123456789</div><div className="jz" style={{ color: "#80664f" }}>delhivery.com/track-v2/…</div></div>
              </div>
              <div className="pbody"><h3>WhatsApp Order Bot</h3><p>Status, courier, tracking ID and a pre-filled Delhivery link in short numbered steps.</p><a href="#start">View Feature <Ico n="out" w={2.4} /></a></div>
            </article>
            <article className="pcard reveal" style={{ transitionDelay: ".1s" }}>
              <div className="shot"><span className="num">02</span>
                <div className="m-sheet">
                  <div className="r h"><span>ORDER</span><span>CUSTOMER</span><span>STATUS</span></div>
                  <div className="r"><span>#W0000</span><span>Asha K.</span><span><i className="chip g">Delivered</i></span></div>
                  <div className="r"><span>#W0001</span><span>Rohit S.</span><span><i className="chip b">In transit</i></span></div>
                  <div className="r"><span>#W0002</span><span>Meera P.</span><span><i className="chip y">Pending</i></span></div>
                  <div className="r"><span>#W0003</span><span>Dev T.</span><span><i className="chip g">Delivered</i></span></div>
                </div>
              </div>
              <div className="pbody"><h3>Order Update Sheet</h3><p>Orders and a Google Sheet stay in sync, colour-coded, with room for AWB and COD details.</p><a href="#start">View Feature <Ico n="out" w={2.4} /></a></div>
            </article>
            <article className="pcard reveal" style={{ transitionDelay: ".2s" }}>
              <div className="shot"><span className="num">03</span>
                <div className="m-seo">
                  <div className="ring"><svg viewBox="0 0 88 88"><defs><linearGradient id="rg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#ead3ad" /><stop offset="1" stopColor="#b8935f" /></linearGradient></defs><circle className="bg" cx="44" cy="44" r="36" /><circle className="fg" cx="44" cy="44" r="36" /></svg><b>86</b></div>
                  <div className="mini">
                    {[0.9, 0.7, 0.85, 0.55].map((w) => <div key={w}><i style={{ "--w": w } as CSSProperties} /></div>)}
                  </div>
                </div>
              </div>
              <div className="pbody"><h3>SEO Fixer</h3><p>Score every product, fix titles, descriptions and alt text in bulk, and undo any batch.</p><a href="#start">View Feature <Ico n="out" w={2.4} /></a></div>
            </article>
          </div>
          <DotNav />
        </div>
      </section>

      {/* ------------------------------------------------ contact */}
      <section className="contact" id="contact">
        <div className="wrap">
          <div className="box reveal">
            <span className="tag">LET&apos;S WORK TOGETHER</span>
            <h3>Have a store in mind?</h3>
            <p>I&apos;m always ready to take the first reply. Connect your Shopify store and let&apos;s get started.</p>
            {showForm ? <LoginForm errors={errors} id="shop-contact" /> : null}
          </div>
          <div className="box reveal" style={{ transitionDelay: ".1s" }}>
            <span className="tag">WHY STORES CHOOSE JAZZ</span>
            <h3>Replies that close the loop</h3>
            <ul className="ticks">
              <li><Ico n="check" w={2.6} /> Order details only after the phone number matches</li>
              <li><Ico n="check" w={2.6} /> Prices in ₹, short numbered answers</li>
              <li><Ico n="check" w={2.6} /> Delhivery link opens with the ID filled in</li>
              <li><Ico n="check" w={2.6} /> A person can take over any chat</li>
            </ul>
          </div>
          <div className="box follow reveal" style={{ transitionDelay: ".2s" }}>
            <span className="tag">CONTACT US</span>
            <h3>We&apos;re here to help</h3>
            <a className="reach" href={`mailto:${SUPPORT_EMAIL}`}>
              <span className="ic"><Ico n="mail" /></span>
              <span><small>Email</small><b>{SUPPORT_EMAIL}</b></span>
            </a>
            <a className="reach" href={`tel:${SUPPORT_TEL}`}>
              <span className="ic"><Ico n="phone" /></span>
              <span><small>Phone</small><b>{SUPPORT_PHONE}</b></span>
            </a>
          </div>
        </div>
      </section>

      <footer>
        <div className="wrap"><span>© 2026 ShopPilot. All rights reserved.</span><span>Made with <em>♥</em> by JAZZ</span></div>
      </footer>
    </div>
  );
}
