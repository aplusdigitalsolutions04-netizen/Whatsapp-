import { useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs, MetaFunction } from "react-router";
import { redirect, Form, useActionData, useLoaderData } from "react-router";
import {
  ArrowRight, BellRing, Bot, Check, ClipboardList, Download, Languages, MessagesSquare, PackageSearch, ScanSearch, SearchCheck,
  ShieldCheck, Sparkles, Truck, WandSparkles, Zap, type LucideIcon,
} from "lucide-react";

import { login } from "../../shopify.server";
import { loginErrorMessage } from "./error.server";

import styles from "./styles.module.css";

export const meta: MetaFunction = () => [
  { title: "ShopPilot: WhatsApp bot, order updates and store tools for Shopify" },
  { name: "description", content: "JAZZ answers your customers on WhatsApp 24/7: order status, Delhivery tracking and product questions. Plus order sheet, product scrapper, image editor and SEO tools in one Shopify app." },
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

type Feature = { icon: LucideIcon; title: string; text: string; points: string[]; tone: string };

const FEATURES: Feature[] = [
  {
    icon: Bot, tone: "green", title: "JAZZ, your WhatsApp bot",
    text: "Answers customers in short numbered steps, in English, Hindi and Hinglish.",
    points: ["Order status with order number + registered phone check", "Delhivery tracking ID and a link that opens pre-filled", "Product search, price in ₹, combo contents"],
  },
  {
    icon: MessagesSquare, tone: "teal", title: "Live Inbox",
    text: "Take over any chat in one click when a customer needs a person.",
    points: ["Photos, files and quick replies", "JAZZ goes quiet while an agent talks", "Every message stays in one place"],
  },
  {
    icon: BellRing, tone: "amber", title: "Support alerts",
    text: "When a customer asks for the support team, you see it instantly.",
    points: ["Animated pop-up with sound", "Banner on the dashboard", "Customer is told help is coming"],
  },
  {
    icon: PackageSearch, tone: "sky", title: "Product enquiries",
    text: "See which products customers ask for that you do not sell yet.",
    points: ["Every enquiry saved with the customer", "Spot demand before competitors", "One list, easy to act on"],
  },
  {
    icon: ClipboardList, tone: "violet", title: "Order Update sheet",
    text: "Your orders and a Google Sheet stay in sync, by day, week, month and year.",
    points: ["Colour-coded by status", "Team fills dispatch, AWB and COD details", "Add manual orders too"],
  },
  {
    icon: ScanSearch, tone: "rose", title: "Product Scrapper",
    text: "Find new products from other sites and skip the ones you already sell.",
    points: ["CSV: name, description, link and SKU", "SKU as BRAND-MODEL, like HP-126snw", "ZIP with one image folder per SKU (1, 2, 3...)"],
  },
  {
    icon: WandSparkles, tone: "green", title: "Image Editor",
    text: "Clean up product photos in bulk and push them back to Shopify.",
    points: ["Background removal and resize", "Bulk jobs with progress", "Undo whenever you want"],
  },
  {
    icon: SearchCheck, tone: "teal", title: "SEO fixer",
    text: "Score every product, then fix titles, descriptions and image alt text in bulk.",
    points: ["Clear score per product", "Fix through a CSV, review before applying", "Undo any batch"],
  },
];

const STEPS = [
  { n: "1", title: "Install on your store", text: "Enter your Shopify store address and approve the app. No coding, no passwords to create." },
  { n: "2", title: "Link WhatsApp", text: "Scan one QR code. JAZZ starts answering the same minute." },
  { n: "3", title: "Relax, then step in", text: "JAZZ handles the routine questions. Your team gets an alert when a person is needed." },
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

function useReveal(root: RefObject<HTMLDivElement | null>) {
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
    return () => io.disconnect();
  }, [root]);
}

function Counter({ to, suffix = "" }: { to: number; suffix?: string }) {
  const [v, setV] = useState(to);
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    setV(0);
    const io = new IntersectionObserver(([e]) => {
      if (!e.isIntersecting) return;
      io.disconnect();
      const start = performance.now();
      const tick = (t: number) => {
        const p = Math.min(1, (t - start) / 1200);
        setV(Math.round(to * (1 - Math.pow(1 - p, 3))));
        if (p < 1) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    io.observe(el);
    return () => io.disconnect();
  }, [to]);
  return <span ref={ref}>{v}{suffix}</span>;
}

function LoginForm({ errors, id }: { errors?: { shop?: string }; id: string }) {
  return (
    <Form className={styles.form} method="post">
      <div className={styles.formRow}>
        <input id={id} className={styles.input} type="text" name="shop" placeholder="your-store.myshopify.com" aria-label="Shop domain" autoComplete="off" spellCheck={false} />
        <button className={styles.button} type="submit">
          Start with Shopify <ArrowRight size={16} />
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
  useReveal(root);
  const { shown, typing } = useDemo();

  return (
    <div className={styles.page} ref={root}>
      <div className={styles.bg} aria-hidden="true">
        <span className={`${styles.blob} ${styles.b1}`} />
        <span className={`${styles.blob} ${styles.b2}`} />
        <span className={`${styles.blob} ${styles.b3}`} />
        <span className={styles.grid} />
      </div>

      <header className={styles.nav}>
        <a className={styles.brand} href="#top" aria-label="ShopPilot home">
          <span className={styles.logo}>S</span>
          ShopPilot
        </a>
        <nav className={styles.navLinks} aria-label="Sections">
          <a href="#features">Features</a>
          <a href="#how">How it works</a>
          <a href="#faq">FAQ</a>
        </nav>
        <a className={styles.navCta} href="#start">Log in</a>
      </header>

      <main id="top">
        {/* ------------------------------------------------ hero */}
        <section className={styles.hero}>
          <div className={styles.heroText}>
            <span className={`${styles.pill} ${styles.rise}`}><Sparkles size={14} /> Built for Shopify stores in India</span>
            <h1 className={`${styles.title} ${styles.rise}`} style={{ animationDelay: "80ms" }}>
              Your store&apos;s <span className={styles.gradient}>co-pilot</span> on WhatsApp
            </h1>
            <p className={`${styles.lead} ${styles.rise}`} style={{ animationDelay: "160ms" }}>
              JAZZ answers order, tracking and product questions 24/7. Your team gets the Order Update sheet, Product Scrapper, Image Editor and SEO fixer in the same app.
            </p>
            <div id="start" className={`${styles.rise} ${styles.startBox}`} style={{ animationDelay: "240ms" }}>
              {showForm && <LoginForm errors={errors} id="shop-hero" />}
            </div>
            <ul className={`${styles.trust} ${styles.rise}`} style={{ animationDelay: "320ms" }}>
              <li><Check size={14} /> Works in English, Hindi and Hinglish</li>
              <li><Check size={14} /> Order details only after phone match</li>
              <li><Check size={14} /> Human takeover any time</li>
            </ul>
          </div>

          <div className={`${styles.phoneWrap} ${styles.rise}`} style={{ animationDelay: "200ms" }}>
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
                {typing && (
                  <div className={`${styles.bubble} ${styles.bot} ${styles.dots}`} aria-hidden="true"><i /><i /><i /></div>
                )}
              </div>
              <div className={styles.compose}>Type a message</div>
            </div>
            <div className={`${styles.floaty} ${styles.f1}`}><Truck size={16} /> Delhivery link, pre-filled</div>
            <div className={`${styles.floaty} ${styles.f2}`}><BellRing size={16} /> Support request alert</div>
            <div className={`${styles.floaty} ${styles.f3}`}><ShieldCheck size={16} /> Phone-verified orders</div>
          </div>
        </section>

        {/* ------------------------------------------------ numbers */}
        <div className={styles.marquee} aria-hidden="true">
          <div className={styles.track}>
            {[0, 1].map((k) => (
              <ul key={k}>
                {["Order status in seconds", "Delhivery links, pre-filled", "English · Hindi · Hinglish", "Live Inbox", "Support alerts", "Order Update sheet", "Product Scrapper", "Image Editor", "SEO fixer"].map((t) => (
                  <li key={t}><i />{t}</li>
                ))}
              </ul>
            ))}
          </div>
        </div>

        <section className={styles.stats} aria-label="At a glance">
          <div data-reveal className={styles.stat}><b>24/7</b><span>replies, even at 3 a.m.</span></div>
          <div data-reveal className={styles.stat}><b><Counter to={8} /></b><span>tools in one Shopify app</span></div>
          <div data-reveal className={styles.stat}><b><Counter to={3} /></b><span>languages out of the box</span></div>
          <div data-reveal className={styles.stat}><b><Counter to={1} /></b><span>QR scan to go live</span></div>
        </section>

        {/* ------------------------------------------------ features */}
        <section id="features" className={styles.section}>
          <div data-reveal className={styles.head}>
            <span className={styles.kicker}>Everything in one place</span>
            <h2>One app. Eight tools. Zero juggling.</h2>
            <p>Support, order tracking, catalogue work and SEO, built to save your team hours every day.</p>
          </div>
          <div className={styles.cards}>
            {FEATURES.map((f, i) => (
              <article key={f.title} data-reveal className={`${styles.card} ${styles[f.tone]}`} style={{ transitionDelay: `${(i % 4) * 70}ms` }}>
                <span className={styles.icon}><f.icon size={20} /></span>
                <h3>{f.title}</h3>
                <p>{f.text}</p>
                <ul>
                  {f.points.map((p) => <li key={p}><Check size={13} />{p}</li>)}
                </ul>
              </article>
            ))}
          </div>
        </section>

        {/* ------------------------------------------------ order flow */}
        <section className={styles.section}>
          <div className={styles.split}>
            <div data-reveal className={styles.splitText}>
              <span className={styles.kicker}>Order tracking that closes the loop</span>
              <h2>&quot;Where is my order?&quot; answered in seconds</h2>
              <p>The customer sends the order number. JAZZ checks it against the registered phone, then replies with the status, courier, tracking ID and a link that opens Delhivery with the ID already typed in.</p>
              <ul className={styles.ticks}>
                <li><Check size={16} /> Prices always in ₹</li>
                <li><Check size={16} /> Short numbered replies, no walls of text</li>
                <li><Check size={16} /> Works with #W0000, W0000 or a registered phone number</li>
              </ul>
            </div>
            <div data-reveal className={styles.flow} aria-hidden="true">
              {["Customer sends #W0000", "JAZZ verifies the phone", "Order + Delhivery link sent"].map((t, i) => (
                <div key={t} className={styles.flowStep} style={{ animationDelay: `${i * 1.1}s` }}>
                  <span>{i + 1}</span>{t}
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* ------------------------------------------------ scrapper */}
        <section className={styles.section}>
          <div className={`${styles.split} ${styles.reverse}`}>
            <div data-reveal className={styles.files} aria-hidden="true">
              <div className={styles.file}><Download size={15} /> products.csv</div>
              <div className={styles.csv}>
                <div><b>SKU</b><b>Product Name</b></div>
                <div><span>HP-126snw</span><span>HP Laser MFP 126snw</span></div>
                <div><span>DELL-3520</span><span>Dell Inspiron 3520</span></div>
                <div><span>SONY-WH1000XM5</span><span>Sony WH-1000XM5</span></div>
              </div>
              <div className={styles.file}><Download size={15} /> images.zip</div>
              <div className={styles.tree}>
                <span>HP-126snw/</span><span className={styles.indent}>1.jpg  2.jpg  3.jpg</span>
                <span>DELL-3520/</span><span className={styles.indent}>1.jpg  2.jpg</span>
              </div>
            </div>
            <div data-reveal className={styles.splitText}>
              <span className={styles.kicker}>Product Scrapper</span>
              <h2>Add new products without the copy-paste</h2>
              <p>Search other sites, skip what is already in your store, and download a ready sheet: product name, description, link and a clean SKU in the BRAND-MODEL format. Images come as a ZIP with one folder per SKU, numbered 1, 2, 3.</p>
              <ul className={styles.ticks}>
                <li><Check size={16} /> Already-in-store products are skipped</li>
                <li><Check size={16} /> SKU matches the image folder name</li>
                <li><Check size={16} /> Works with Shopify stores, Amazon, Flipkart and more</li>
              </ul>
            </div>
          </div>
        </section>

        {/* ------------------------------------------------ how it works */}
        <section id="how" className={styles.section}>
          <div data-reveal className={styles.head}>
            <span className={styles.kicker}>Live in minutes</span>
            <h2>How it works</h2>
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

        {/* ------------------------------------------------ why */}
        <section className={styles.section}>
          <div className={styles.why}>
            {[
              { i: Zap, t: "Fast to set up", d: "One QR scan and the bot is working." },
              { i: ShieldCheck, t: "Privacy first", d: "Orders are shown only to the verified customer." },
              { i: Languages, t: "Speaks your customers' language", d: "English, Hindi, Hinglish and translation for the rest." },
            ].map((w, i) => (
              <div key={w.t} data-reveal className={styles.whyItem} style={{ transitionDelay: `${i * 80}ms` }}>
                <w.i size={22} />
                <div><b>{w.t}</b><span>{w.d}</span></div>
              </div>
            ))}
          </div>
        </section>

        {/* ------------------------------------------------ faq */}
        <section id="faq" className={styles.section}>
          <div data-reveal className={styles.head}>
            <span className={styles.kicker}>Good to know</span>
            <h2>Questions, answered</h2>
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
        <section className={styles.cta} data-reveal>
          <h2>Let JAZZ take the first reply</h2>
          <p>Connect your store and see it answer a real order question.</p>
          {showForm && <LoginForm errors={errors} id="shop-cta" />}
        </section>
      </main>

      <footer className={styles.footer}>
        <span className={styles.brand}><span className={styles.logo}>S</span> ShopPilot</span>
        <span>WhatsApp bot, order updates and store tools for your Shopify store.</span>
      </footer>
    </div>
  );
}
