import { useCallback, useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import type { ActionFunctionArgs, LinksFunction, LoaderFunctionArgs, MetaFunction } from "react-router";
import { redirect, Form, useActionData, useLoaderData } from "react-router";
import {
  ArrowRight, ArrowUpRight, BellRing, Check, ChevronLeft, ChevronRight, Headset, Languages, ShieldCheck, Truck, Zap,
} from "lucide-react";

import { login } from "../../shopify.server";
import { loginErrorMessage } from "./error.server";

import styles from "./styles.module.css";

export const meta: MetaFunction = () => [
  { title: "ShopPilot: WhatsApp bot, order updates and store tools for Shopify" },
  { name: "description", content: "JAZZ answers your customers on WhatsApp 24/7: order status, Delhivery tracking and product questions. Plus order sheet, product scrapper, image editor and SEO tools in one Shopify app." },
];

// Display face for the headings (falls back to Georgia when offline).
export const links: LinksFunction = () => [
  { rel: "preconnect", href: "https://fonts.googleapis.com" },
  { rel: "preconnect", href: "https://fonts.gstatic.com", crossOrigin: "anonymous" },
  { rel: "stylesheet", href: "https://fonts.googleapis.com/css2?family=Cormorant+Garamond:wght@300;400;500;600&display=swap" },
];

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

const IMG = "/landing";

const STRIP = [
  { icon: Zap, title: "INSTANT REPLIES", text: "Answers in seconds, 24/7" },
  { icon: ShieldCheck, title: "VERIFIED ORDERS", text: "Order number + phone match" },
  { icon: Truck, title: "DELHIVERY TRACKING", text: "Link opens with the ID filled in" },
  { icon: Headset, title: "HUMAN TAKEOVER", text: "Step in with one click" },
];

const CARDS = [
  { title: "WHATSAPP BOT", text: "JAZZ, always on.", img: "phone-night" },
  { title: "ORDER TRACKING", text: "Status, courier, link.", img: "boxes" },
  { title: "ORDER SHEET", text: "Your team, in sync.", img: "desk-lamp" },
  { title: "STORE TOOLS", text: "Scrape, edit, optimise.", img: "shoes" },
];

type Slide = { n: string; title: string; text: string; specs: [string, string][]; img: string; cta: string };
const SLIDES: Slide[] = [
  {
    n: "JAZZ", title: "JAZZ, YOUR WHATSAPP ASSISTANT",
    text: "Answers order, tracking and product questions in short numbered steps, then hands over to your team the moment a person is needed.",
    specs: [["Languages", "English, Hindi, Hinglish"], ["Replies", "Instant, 24/7"], ["Handover", "One click"]],
    img: "boxes-plant", cta: "See order tracking",
  },
  {
    n: "SCRAPPER", title: "PRODUCT SCRAPPER",
    text: "Find new products on other sites, skip what you already sell, and download a sheet with name, description, link and a BRAND-MODEL SKU, plus images grouped by SKU.",
    specs: [["CSV", "Name, description, link, SKU"], ["Images", "ZIP, one folder per SKU"], ["Naming", "1, 2, 3 ..."]],
    img: "shelf", cta: "Try the scrapper",
  },
  {
    n: "ORDER SHEET", title: "ORDER UPDATE SHEET",
    text: "Orders and a Google Sheet stay in sync by day, week, month and year, colour-coded by status, with room for dispatch, AWB and COD details.",
    specs: [["Sync", "Google Sheets"], ["Periods", "Day to year"], ["Manual rows", "Supported"]],
    img: "desk-lamp", cta: "Open the sheet",
  },
  {
    n: "SEO", title: "SEO FIXER AND IMAGE EDITOR",
    text: "Score every product, fix titles, descriptions and alt text in bulk, and clean up product photos with background removal. Review first, undo any time.",
    specs: [["Score", "Per product"], ["Fix", "Bulk, via CSV"], ["Undo", "Any batch"]],
    img: "monitor", cta: "Improve my store",
  },
];

const TOOLS = [
  { label: "ORDER SHEET", img: "desk-lamp", pos: "50% 40%" },
  { label: "PRODUCT SCRAPPER", img: "shoes", pos: "50% 30%" },
  { label: "IMAGE EDITOR", img: "parcel-label", pos: "50% 55%" },
  { label: "SEO FIXER", img: "monitor", pos: "55% 45%" },
  { label: "AUTO REPLIES", img: "phone-night", pos: "50% 55%" },
];

const STEPS = [
  { n: "01", title: "Install on your store", text: "Enter your Shopify store address and approve the app. No coding, no passwords to create." },
  { n: "02", title: "Link WhatsApp", text: "Scan one QR code. JAZZ starts answering the same minute." },
  { n: "03", title: "Relax, then step in", text: "JAZZ handles the routine questions. Your team gets an alert when a person is needed." },
];

const FAQ: { q: string; a: string }[] = [
  { q: "Will JAZZ reply to my friends and family?", a: "No. Numbers saved in your phone are ignored. A saved contact can still talk to JAZZ by starting the message with !, # or $ (for example #W0000)." },
  { q: "Is my customers' order data safe?", a: "Order details are shared only when the customer's order number and registered phone number match. Nothing else is revealed." },
  { q: "Which languages does JAZZ speak?", a: "English, Hindi and Hinglish out of the box. Messages in other languages are translated, answered, and translated back." },
  { q: "How does Delhivery tracking work?", a: "JAZZ sends the courier, the tracking ID and a Delhivery link. The link opens Delhivery with the tracking ID already filled in." },
  { q: "Can a person take over a chat?", a: "Yes. Open the Live Inbox, reply as an agent, and JAZZ stays quiet until you hand the chat back." },
];

const DEMO: { who: "me" | "bot"; lines: ReactNode }[] = [
  { who: "me", lines: "Hi" },
  {
    who: "bot",
    lines: (
      <>
        Hi, I&apos;m JAZZ! 👋 Welcome to WERY.
        <br />
        How can I help you today?
        <br />
        <br />
        1. Find a Product
        <br />
        2. Check Order Status
        <br />
        3. Track My Shipment
      </>
    ),
  },
  { who: "me", lines: "#W0000" },
  {
    who: "bot",
    lines: (
      <>
        Your order details: 📦
        <br />
        1. Order Number: #W0000
        <br />
        2. Fulfillment: Fulfilled
        <br />
        3. Total: ₹1,499
        <br />
        <br />
        Tracking 🚚
        <br />
        1. Courier: Delhivery
        <br />
        2. Tracking ID: DL123456789
        <br />
        3. Link: <u>delhivery.com/track-v2/package/DL123456789</u>
      </>
    ),
  },
];

/** Plays the chat: customer message, typing dots, JAZZ answer, then starts over. */
function useDemo() {
  const [shown, setShown] = useState(DEMO.length);
  const [typing, setTyping] = useState(false);
  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    let dead = false;
    const timers: number[] = [];
    const at = (ms: number, fn: () => void) => timers.push(window.setTimeout(() => !dead && fn(), ms));
    const play = () => {
      setShown(0);
      setTyping(false);
      at(700, () => setShown(1));
      at(1300, () => setTyping(true));
      at(2700, () => { setTyping(false); setShown(2); });
      at(5200, () => setShown(3));
      at(5800, () => setTyping(true));
      at(7400, () => { setTyping(false); setShown(4); });
      at(13500, play);
    };
    play();
    return () => {
      dead = true;
      timers.forEach(clearTimeout);
    };
  }, []);
  return { shown, typing };
}

/** Fades sections in on scroll and moves the hero photo slightly slower than the page (parallax). */
function usePageMotion(root: RefObject<HTMLDivElement | null>) {
  useEffect(() => {
    const el = root.current;
    if (!el) return;
    const items = Array.from(el.querySelectorAll<HTMLElement>("[data-reveal]"));
    const show = (n: Element) => n.classList.add(styles.in);
    const vh = window.innerHeight;
    items.forEach((n) => n.getBoundingClientRect().top < vh * 0.95 && show(n));
    el.classList.add(styles.ready);
    const io = new IntersectionObserver((entries) => entries.forEach((e) => { if (e.isIntersecting) { show(e.target); io.unobserve(e.target); } }), { threshold: 0.12 });
    items.forEach((n) => !n.classList.contains(styles.in) && io.observe(n));

    let raf = 0;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const onScroll = () => {
      if (reduce || raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        el.style.setProperty("--py", `${Math.min(window.scrollY, 900) * 0.25}px`);
        el.dataset.stuck = window.scrollY > 40 ? "1" : "0";
      });
    };
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      io.disconnect();
      window.removeEventListener("scroll", onScroll);
      cancelAnimationFrame(raf);
    };
  }, [root]);
}

function LoginForm({ errors, id }: { errors?: { shop?: string }; id: string }) {
  return (
    <Form className={styles.form} method="post">
      <div className={styles.formRow}>
        <input id={id} className={styles.input} type="text" name="shop" placeholder="your-store.myshopify.com" aria-label="Shop domain" autoComplete="off" spellCheck={false} />
        <button className={styles.button} type="submit">
          START WITH SHOPIFY <ArrowRight size={15} />
        </button>
      </div>
      <span className={styles.hint} role={errors?.shop ? "alert" : undefined} data-error={errors?.shop ? "1" : undefined}>
        {errors?.shop ?? "Enter your store address, for example my-shop.myshopify.com"}
      </span>
    </Form>
  );
}

export default function App() {
  const { showForm } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const errors = actionData?.errors;
  const root = useRef<HTMLDivElement>(null);
  usePageMotion(root);
  const { shown, typing } = useDemo();

  const [slide, setSlide] = useState(0);
  const [hover, setHover] = useState(false);
  const go = useCallback((d: number) => setSlide((s) => (s + d + SLIDES.length) % SLIDES.length), []);
  useEffect(() => {
    if (hover || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const t = window.setInterval(() => go(1), 6500);
    return () => clearInterval(t);
  }, [hover, go, slide]);

  return (
    <div className={styles.page} ref={root}>
      <header className={styles.nav}>
        <a className={styles.brand} href="#top" aria-label="ShopPilot home">
          <span className={styles.wordmark}>SHOPPILOT</span>
          <small>WHATSAPP · ORDERS · STORE TOOLS</small>
        </a>
        <nav className={styles.navLinks} aria-label="Sections">
          <a href="#features">FEATURES</a>
          <a href="#spotlight">SPOTLIGHT</a>
          <a href="#tools">TOOLS</a>
          <a href="#how">HOW IT WORKS</a>
          <a href="#faq">FAQ</a>
        </nav>
        <a className={styles.navCta} href="#start">GET STARTED</a>
      </header>

      <main id="top">
        {/* ------------------------------------------------ hero */}
        <section className={styles.hero}>
          <div className={styles.heroBg} aria-hidden="true" style={{ backgroundImage: `url(${IMG}/hero.jpg)` }} />
          <div className={styles.heroShade} aria-hidden="true" />
          <div className={styles.heroInner}>
            <div className={styles.heroText}>
              <span className={`${styles.kicker} ${styles.rise}`}>SHOPPILOT / WHATSAPP + STORE TOOLS</span>
              <h1 className={`${styles.title} ${styles.rise}`} style={{ animationDelay: "90ms" }}>
                YOUR STORE,<br />ALWAYS <em>ANSWERING.</em>
              </h1>
              <p className={`${styles.lead} ${styles.rise}`} style={{ animationDelay: "180ms" }}>
                JAZZ replies to order, tracking and product questions on WhatsApp, day and night, while your team gets the tools to run the store.
              </p>
              <div id="start" className={`${styles.startBox} ${styles.rise}`} style={{ animationDelay: "270ms" }}>
                {showForm && <LoginForm errors={errors} id="shop-hero" />}
              </div>
              <a className={`${styles.scroll} ${styles.rise}`} style={{ animationDelay: "380ms" }} href="#features">
                SCROLL DOWN<i />
              </a>
            </div>

            <div className={`${styles.phoneWrap} ${styles.rise}`} style={{ animationDelay: "220ms" }}>
              <div className={styles.phone} role="img" aria-label="Demo chat: a customer tracks order W0000 and JAZZ replies with the Delhivery tracking link">
                <div className={styles.phoneTop}>
                  <span className={styles.avatar}>J</span>
                  <div>
                    <b>JAZZ</b>
                    <small><i className={styles.online} /> online</small>
                  </div>
                </div>
                <div className={styles.chat}>
                  {DEMO.slice(0, shown).map((m, i) => (
                    <div key={i} className={`${styles.bubble} ${m.who === "me" ? styles.me : styles.bot}`}>{m.lines}</div>
                  ))}
                  {typing && <div className={`${styles.bubble} ${styles.bot} ${styles.dots}`} aria-hidden="true"><i /><i /><i /></div>}
                </div>
                <div className={styles.compose}>Type a message</div>
              </div>
              <div className={`${styles.floaty} ${styles.f1}`}><Truck size={15} /> Delhivery link, pre-filled</div>
              <div className={`${styles.floaty} ${styles.f2}`}><BellRing size={15} /> Support request alert</div>
            </div>
          </div>
        </section>

        {/* ------------------------------------------------ feature strip */}
        <section className={styles.strip} aria-label="Highlights">
          {STRIP.map((s, i) => (
            <div key={s.title} data-reveal className={styles.stripItem} style={{ transitionDelay: `${i * 80}ms` }}>
              <s.icon size={22} strokeWidth={1.4} />
              <b>{s.title}</b>
              <span>{s.text}</span>
            </div>
          ))}
        </section>

        {/* ------------------------------------------------ designed for modern selling */}
        <section id="features" className={styles.collections}>
          <div data-reveal className={styles.collHead}>
            <span className={styles.kicker}>THE APP</span>
            <h2>DESIGNED FOR<br />MODERN SELLING.</h2>
            <a href="#tools" className={styles.viewAll}>VIEW ALL TOOLS <ArrowRight size={13} /></a>
          </div>
          <div className={styles.collGrid}>
            {CARDS.map((c, i) => (
              <a key={c.title} href="#spotlight" data-reveal className={styles.coll} style={{ transitionDelay: `${i * 90}ms` }}>
                <img src={`${IMG}/${c.img}.jpg`} alt="" loading="lazy" />
                <span className={styles.collText}>
                  <b>{c.title}</b>
                  <small>{c.text}</small>
                </span>
                <ArrowUpRight className={styles.collArrow} size={18} />
              </a>
            ))}
          </div>
        </section>

        {/* ------------------------------------------------ spotlight carousel */}
        <section id="spotlight" className={styles.spot} onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}>
          <div className={styles.slides}>
            {SLIDES.map((s, i) => (
              <article key={s.n} className={`${styles.slide} ${i === slide ? styles.active : ""}`} aria-hidden={i !== slide}>
                <div className={styles.slideImg} style={{ backgroundImage: `url(${IMG}/${s.img}.jpg)` }} />
                <div className={styles.slideText}>
                  <span className={styles.count}>0{i + 1} / 0{SLIDES.length}</span>
                  <h2>{s.title}</h2>
                  <p>{s.text}</p>
                  <dl className={styles.specs}>
                    {s.specs.map(([k, v]) => (
                      <div key={k}><dt>{k}</dt><dd>{v}</dd></div>
                    ))}
                  </dl>
                  <div className={styles.slideActions}>
                    <a className={styles.ghost} href="#start" tabIndex={i === slide ? 0 : -1}>{s.cta.toUpperCase()}</a>
                    <span className={styles.arrows}>
                      <button type="button" onClick={() => go(-1)} aria-label="Previous"><ChevronLeft size={16} /></button>
                      <button type="button" onClick={() => go(1)} aria-label="Next"><ChevronRight size={16} /></button>
                    </span>
                  </div>
                </div>
              </article>
            ))}
          </div>
          <div className={styles.dotsNav} role="tablist" aria-label="Spotlight">
            {SLIDES.map((s, i) => (
              <button key={s.n} type="button" role="tab" aria-selected={i === slide} className={i === slide ? styles.on : ""} onClick={() => setSlide(i)}>{s.n}</button>
            ))}
          </div>
        </section>

        {/* ------------------------------------------------ tools / materials row */}
        <section id="tools" className={styles.tools}>
          <div data-reveal className={styles.toolsHead}>
            <h2>EVERYTHING<br />INCLUDED.</h2>
            <p>Eight tools, one app. Support, tracking, catalogue work and SEO, built to save your team hours every day.</p>
            <a className={styles.ghost} href="#start">EXPLORE THE APP</a>
          </div>
          <div className={styles.toolsRow}>
            {TOOLS.map((t, i) => (
              <div key={t.label} data-reveal className={styles.tool} style={{ transitionDelay: `${i * 80}ms` }}>
                <img src={`${IMG}/${t.img}.jpg`} alt="" loading="lazy" style={{ objectPosition: t.pos }} />
                <span>{t.label}</span>
              </div>
            ))}
          </div>
        </section>

        {/* ------------------------------------------------ order flow */}
        <section className={styles.split}>
          <div data-reveal className={styles.splitText}>
            <span className={styles.kicker}>ORDER TRACKING THAT CLOSES THE LOOP</span>
            <h2>&ldquo;WHERE IS MY ORDER?&rdquo;<br />ANSWERED IN SECONDS.</h2>
            <p>The customer sends the order number. JAZZ checks it against the registered phone, then replies with the status, courier, tracking ID and a link that opens Delhivery with the ID already typed in.</p>
            <ul className={styles.ticks}>
              <li><Check size={15} /> Prices always in ₹</li>
              <li><Check size={15} /> Short numbered replies, no walls of text</li>
              <li><Check size={15} /> Works with #W0000, W0000 or a registered phone number</li>
              <li><Languages size={15} /> English, Hindi and Hinglish</li>
            </ul>
          </div>
          <div data-reveal className={styles.flow} aria-hidden="true">
            {["Customer sends #W0000", "JAZZ verifies the phone", "Order + Delhivery link sent"].map((t, i) => (
              <div key={t} className={styles.flowStep} style={{ animationDelay: `${i * 1.1}s` }}>
                <span>{i + 1}</span>{t}
              </div>
            ))}
          </div>
        </section>

        {/* ------------------------------------------------ steps */}
        <section id="how" className={styles.how}>
          <div data-reveal className={styles.centerHead}>
            <span className={styles.kicker}>LIVE IN MINUTES</span>
            <h2>HOW IT WORKS</h2>
          </div>
          <ol className={styles.steps}>
            {STEPS.map((s, i) => (
              <li key={s.n} data-reveal style={{ transitionDelay: `${i * 100}ms` }}>
                <span className={styles.stepNo}>{s.n}</span>
                <h3>{s.title}</h3>
                <p>{s.text}</p>
              </li>
            ))}
          </ol>
        </section>

        {/* ------------------------------------------------ faq */}
        <section id="faq" className={styles.how}>
          <div data-reveal className={styles.centerHead}>
            <span className={styles.kicker}>GOOD TO KNOW</span>
            <h2>QUESTIONS, ANSWERED</h2>
          </div>
          <div className={styles.faq}>
            {FAQ.map((f, i) => (
              <details key={f.q} data-reveal style={{ transitionDelay: `${i * 60}ms` }}>
                <summary>{f.q}</summary>
                <p>{f.a}</p>
              </details>
            ))}
          </div>
        </section>

        {/* ------------------------------------------------ cta */}
        <section className={styles.cta} data-reveal style={{ backgroundImage: `url(${IMG}/boxes-plant.jpg)` }}>
          <div className={styles.ctaShade} />
          <div className={styles.ctaInner}>
            <span className={styles.kicker}>READY WHEN YOU ARE</span>
            <h2>LET JAZZ TAKE<br />THE FIRST REPLY.</h2>
            <p>Connect your store and see it answer a real order question.</p>
            {showForm && <LoginForm errors={errors} id="shop-cta" />}
          </div>
        </section>
      </main>

      <footer className={styles.footer}>
        <span className={styles.wordmark}>SHOPPILOT</span>
        <span>WhatsApp bot, order updates and store tools for your Shopify store.</span>
        <span className={styles.credit}>Photos: Pexels</span>
      </footer>
    </div>
  );
}
