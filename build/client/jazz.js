/*! JAZZ chat icon for the store website (wery.in).
 * Add ONE line before </body> in the theme (theme.liquid):
 *   <script src="https://YOUR-APP-DOMAIN/jazz.js" defer></script>
 * The icon sits at the bottom right (it does not cover the header's cart / wishlist). Optional settings on the script tag:
 *   data-bottom="90"  data-right="20"   pixels from the bottom / right edge (e.g. to clear a sticky "Add to cart" bar)
 *   data-position="top"  data-top="90"   put the icon at the top right instead, 90 px from the top
 * The icon only appears while "Show the JAZZ chat icon on the website" is ON in ShopPilot > Bot Settings.
 * Plain JavaScript, no libraries; it lives in a Shadow DOM, so the store's own CSS cannot change it and it cannot change the store.
 */
(function () {
  "use strict";
  if (window.__jazzChat) return;
  window.__jazzChat = true;

  var script = document.currentScript || document.querySelector('script[src*="jazz.js"]');
  var ORIGIN;
  try {
    ORIGIN = new URL(script.src).origin;
  } catch (e) {
    return;
  }
  var API = ORIGIN + "/api/chat";
  var SID_KEY = "jazz-sid";
  var NS = "http://www.w3.org/2000/svg";

  function sid() {
    try {
      var s = localStorage.getItem(SID_KEY);
      if (s && /^[A-Za-z0-9_-]{16,64}$/.test(s)) return s;
    } catch (e) { /* storage blocked: use a fresh id */ }
    var a = new Uint8Array(18);
    (window.crypto || window.msCrypto).getRandomValues(a);
    var n = Array.prototype.map.call(a, function (b) { return b.toString(36).padStart(2, "0"); }).join("").slice(0, 32);
    while (n.length < 24) n += "x";
    try { localStorage.setItem(SID_KEY, n); } catch (e) { /* storage blocked */ }
    return n;
  }

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  function svg(html, size) {
    var s = document.createElementNS(NS, "svg");
    s.setAttribute("viewBox", "0 0 40 40");
    s.setAttribute("width", size);
    s.setAttribute("height", size);
    s.setAttribute("aria-hidden", "true");
    s.innerHTML = html;
    return s;
  }
  var FACE =
    '<rect x="4" y="9" width="32" height="26" rx="10" fill="#fffaf0"/><rect x="8" y="13" width="24" height="16" rx="7" fill="#1a120c"/>' +
    '<circle class="jw-eye" cx="16" cy="21" r="2.8" fill="#ffd89a"/><circle class="jw-eye" cx="24" cy="21" r="2.8" fill="#ffd89a"/>' +
    '<path d="M17 26.2q3 2.2 6 0" fill="none" stroke="#ffd89a" stroke-width="1.6" stroke-linecap="round"/>' +
    '<rect x="19" y="2.5" width="2" height="7" rx="1" fill="#fffaf0"/><circle cx="20" cy="3.2" r="2.4" fill="#ffe3b0"/>';
  function icon(path, size) {
    var s = document.createElementNS(NS, "svg");
    s.setAttribute("viewBox", "0 0 24 24");
    s.setAttribute("width", size);
    s.setAttribute("height", size);
    s.setAttribute("fill", "none");
    s.setAttribute("stroke", "currentColor");
    s.setAttribute("stroke-width", "1.9");
    s.setAttribute("stroke-linecap", "round");
    s.setAttribute("stroke-linejoin", "round");
    s.innerHTML = '<path d="' + path + '"/>';
    return s;
  }

  function linked(parent, text) {
    text.split(/(https?:\/\/[^\s]+)/g).forEach(function (part) {
      if (/^https?:\/\//.test(part)) {
        var a = el("a", null, part);
        a.href = part;
        a.target = "_blank";
        a.rel = "noopener noreferrer";
        parent.appendChild(a);
      } else if (part) parent.appendChild(document.createTextNode(part));
    });
  }

  function start(cfg) {
    if (!cfg || !cfg.enabled) return;
    var wa = String(cfg.whatsapp || "919211890093").replace(/\D/g, "");

    var host = el("div");
    host.id = "jazz-chat-root";
    // Store themes often hide empty divs (div:empty { display: none }) or restyle every div. Inline !important beats any stylesheet rule,
    // so the host always renders; the icon itself is position: fixed inside it and does not depend on the host's size.
    host.style.cssText = "display:block!important;visibility:visible!important;position:static!important;width:0!important;height:0!important;margin:0!important;padding:0!important;border:0!important;overflow:visible!important;opacity:1!important;transform:none!important;filter:none!important;";
    var root = host.attachShadow({ mode: "open" });
    var css = document.createElement("link");
    css.rel = "stylesheet";
    css.href = ORIGIN + "/jazz-widget.css";
    root.appendChild(css);

    var wrap = el("div", "jw");
    var top = parseInt(script.getAttribute("data-top"), 10);
    var right = parseInt(script.getAttribute("data-right"), 10);
    var bottom = parseInt(script.getAttribute("data-bottom"), 10);
    if (script.getAttribute("data-position") === "top") wrap.classList.add("top");
    if (bottom >= 0) wrap.style.setProperty("--jw-bottom", bottom + "px");
    if (top >= 0) wrap.style.setProperty("--jw-top", top + "px");
    if (right >= 0) wrap.style.setProperty("--jw-right", right + "px");
    var fab = el("button", "jw-fab");
    fab.type = "button";
    fab.title = "Ask JAZZ";
    fab.setAttribute("aria-label", "Ask JAZZ, the assistant");
    fab.setAttribute("aria-expanded", "false");
    fab.appendChild(svg(FACE, 36));
    fab.appendChild(el("span", "jw-ring"));
    fab.appendChild(el("span", "jw-live"));
    fab.appendChild(el("span", "jw-tip", "Ask JAZZ"));
    wrap.appendChild(fab);
    root.appendChild(wrap);

    var panel = null;
    var seen = {};
    var last = null;
    var timer = null;
    var busy = false;
    var log, form, input, chips, errBox;

    function head(backable) {
      var h = el("header", "jw-head");
      if (backable) {
        var back = el("button", "jw-icon", "‹");
        back.type = "button";
        back.setAttribute("aria-label", "Back");
        back.onclick = function () { show("home"); };
        h.appendChild(back);
      }
      var av = el("span", "jw-avatar");
      av.appendChild(svg(FACE, 24));
      h.appendChild(av);
      var t = el("span", "jw-title");
      t.appendChild(el("b", null, "JAZZ"));
      var sm = el("small");
      sm.appendChild(el("i", "jw-dot"));
      sm.appendChild(document.createTextNode(" Assistant · Chat bot"));
      t.appendChild(sm);
      h.appendChild(t);
      var x = el("button", "jw-icon", "×");
      x.type = "button";
      x.setAttribute("aria-label", "Close");
      x.onclick = close;
      h.appendChild(x);
      return h;
    }

    function home() {
      var b = el("div", "jw-body");
      var p1 = el("p", "jw-hi");
      p1.appendChild(document.createTextNode("Hi! I’m "));
      p1.appendChild(el("b", null, "JAZZ"));
      p1.appendChild(document.createTextNode(", the assistant (chat bot) of WERY. 👋"));
      var p2 = el("p");
      p2.appendChild(document.createTextNode("I can help you "));
      p2.appendChild(el("b", null, "track your order"));
      p2.appendChild(document.createTextNode(", check its status and answer your questions about our products."));
      var pills = el("div", "jw-pills");
      ["Order status", "Tracking", "Products", "Hindi & English"].forEach(function (t) { pills.appendChild(el("span", null, t)); });
      var a = el("a", "jw-btn jw-wa");
      a.href = "https://wa.me/" + wa + "?text=" + encodeURIComponent("Hi JAZZ");
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      a.appendChild(icon("M21 12a8.5 8.5 0 0 1-12.4 7.5L3 21l1.6-5.4A8.5 8.5 0 1 1 21 12Z", 18));
      a.appendChild(document.createTextNode("Chat on WhatsApp"));
      var c = el("button", "jw-btn jw-chat");
      c.type = "button";
      c.appendChild(icon("M4 5h16v11H9l-5 4V5Z", 18));
      c.appendChild(document.createTextNode("Chat here"));
      c.onclick = function () { show("chat"); };
      [p1, p2, pills, a, c, el("p", "jw-foot", "JAZZ is an automated assistant. A person can join the chat if needed.")].forEach(function (n) { b.appendChild(n); });
      return b;
    }

    function addMsg(m) {
      if (seen[m.id]) return;
      seen[m.id] = 1;
      var row = el("div", "jw-msg " + m.from);
      if (m.from === "agent") row.appendChild(el("small", null, "Team"));
      var bub = el("div");
      linked(bub, m.text);
      row.appendChild(bub);
      log.appendChild(row);
    }
    function typing(on) {
      var t = log.querySelector(".jw-wait");
      if (on && !t) {
        var row = el("div", "jw-msg jazz jw-wait");
        var d = el("div", "jw-typing");
        d.innerHTML = "<i></i><i></i><i></i>";
        row.appendChild(d);
        log.appendChild(row);
      } else if (!on && t) t.remove();
    }
    function scroll() { log.scrollTop = log.scrollHeight; }

    function poll() {
      var url = API + "?sid=" + encodeURIComponent(sid()) + (last ? "&after=" + encodeURIComponent(last) : "");
      return fetch(url, { cache: "no-store" })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (j) {
          if (!j || !j.messages || !j.messages.length) return;
          var greet = log.querySelector(".jw-greet");
          if (greet) greet.remove();
          if (chips) chips.remove(), (chips = null);
          j.messages.forEach(addMsg);
          last = j.messages[j.messages.length - 1].at;
          log.querySelectorAll(".jw-pending").forEach(function (n) { n.remove(); });
          if (j.messages.some(function (m) { return m.from !== "me"; })) typing(false);
          scroll();
        })
        .catch(function () {});
    }

    function send(value) {
      var t = String(value || "").trim();
      if (!t || busy) return;
      busy = true;
      errBox.textContent = "";
      errBox.hidden = true;
      input.value = "";
      var greet = log.querySelector(".jw-greet");
      if (greet) greet.remove();
      if (chips) chips.remove(), (chips = null);
      var mine = el("div", "jw-msg me jw-pending");
      mine.appendChild(el("div", null, t));
      log.appendChild(mine);
      typing(true);
      scroll();
      fetch(API, { method: "POST", headers: { "Content-Type": "text/plain;charset=UTF-8" }, body: JSON.stringify({ sid: sid(), text: t }) })
        .then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { return { ok: r.ok && j.ok !== false, j: j }; }); })
        .then(function (r) {
          if (!r.ok) {
            mine.remove();
            typing(false);
            errBox.textContent = r.j.error || "Could not send. Please try again.";
            errBox.hidden = false;
            return;
          }
          return poll();
        })
        .catch(function () {
          mine.remove();
          typing(false);
          errBox.textContent = "No connection. Please try again.";
          errBox.hidden = false;
        })
        .then(function () { busy = false; typing(false); });
    }

    function chat() {
      var v = el("div", "jw-chatview");
      log = el("div", "jw-log");
      log.setAttribute("role", "log");
      log.setAttribute("aria-live", "polite");
      var g = el("div", "jw-msg jazz jw-greet");
      g.appendChild(el("div", null, "Hi, I’m JAZZ! 👋 How can I help you today?"));
      log.appendChild(g);
      v.appendChild(log);
      chips = el("div", "jw-chips");
      ["Track my order", "Find a product", "Talk to a person"].forEach(function (c) {
        var b = el("button", null, c);
        b.type = "button";
        b.onclick = function () { send(c); };
        chips.appendChild(b);
      });
      v.appendChild(chips);
      errBox = el("p", "jw-error");
      errBox.setAttribute("role", "alert");
      errBox.hidden = true;
      v.appendChild(errBox);
      form = el("form", "jw-form");
      input = el("input");
      input.placeholder = "Type your message…";
      input.maxLength = 500;
      input.autocomplete = "off";
      input.setAttribute("aria-label", "Message to JAZZ");
      var go = el("button", null, "➤");
      go.type = "submit";
      go.setAttribute("aria-label", "Send");
      form.appendChild(input);
      form.appendChild(go);
      form.onsubmit = function (e) { e.preventDefault(); send(input.value); };
      v.appendChild(form);
      return v;
    }

    function show(which) {
      if (timer) clearInterval(timer), (timer = null);
      if (panel) panel.remove();
      seen = {};
      last = null;
      panel = el("div", "jw-panel");
      panel.setAttribute("role", "dialog");
      panel.setAttribute("aria-label", "JAZZ assistant");
      panel.appendChild(head(which === "chat"));
      panel.appendChild(which === "chat" ? chat() : home());
      wrap.appendChild(panel);
      if (which === "chat") {
        poll();
        timer = setInterval(poll, 3000);
        setTimeout(function () { input.focus(); }, 50);
      }
    }
    var hello = null;
    function dropHello() { if (hello) hello.remove(), (hello = null); }
    function sayHello() {
      try { if (sessionStorage.getItem("jazz-hello")) return; sessionStorage.setItem("jazz-hello", "1"); } catch (e) { /* storage blocked: show it once per page */ }
      hello = el("div", "jw-hello");
      hello.appendChild(el("b", null, "Hi, I’m JAZZ 👋"));
      hello.appendChild(el("span", null, "Need help with your order? Ask me."));
      var x = el("button", "jw-x", "×");
      x.type = "button";
      x.setAttribute("aria-label", "Dismiss");
      x.onclick = function (e) { e.stopPropagation(); dropHello(); };
      hello.appendChild(x);
      hello.onclick = function () { dropHello(); fab.click(); };
      wrap.appendChild(hello);
      setTimeout(dropHello, 9000);
    }
    setTimeout(function () { if (!panel) sayHello(); }, 3500);
    function close() {
      if (timer) clearInterval(timer), (timer = null);
      if (panel) panel.remove(), (panel = null);
      fab.classList.remove("on");
      fab.setAttribute("aria-expanded", "false");
    }
    fab.onclick = function () {
      dropHello();
      if (panel) return close();
      fab.classList.add("on");
      fab.setAttribute("aria-expanded", "true");
      show("home");
    };
    document.addEventListener("keydown", function (e) { if (e.key === "Escape" && panel) close(); });

    document.body.appendChild(host);
  }

  function boot() {
    fetch(API + "?config=1", { cache: "no-store" })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(start)
      .catch(function () {}); // never break the store page
  }
  if (document.body) boot();
  else document.addEventListener("DOMContentLoaded", boot);
})();
