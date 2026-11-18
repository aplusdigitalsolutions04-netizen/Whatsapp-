import { useEffect, useState, type ReactNode } from "react";
import { Link, NavLink, useLocation } from "react-router";
import { SupportAlert } from "./SupportAlert";
import type { Waiting } from "../lib/waiting.server";
import { ChevronsLeft, ChevronsRight, ClipboardList, ScanSearch, WandSparkles, LayoutDashboard, Menu, MessagesSquare, PackageSearch, Plug, ScrollText, SearchCheck, Smartphone, Sparkles, X, Zap, type LucideIcon } from "lucide-react";

type Item = { to: string; label: string; icon: LucideIcon; end?: boolean; badge?: number; also?: string };
type Group = { title: string; items: Item[] };

export type ShellData = { shop: string; handoffs: number; errors: number; waiting: Waiting[] };

function groups(d: ShellData): Group[] {
  return [
    {
      title: "Bot",
      items: [
        { to: "/app", label: "Dashboard", icon: LayoutDashboard, end: true },
        { to: "/app/conversations", label: "Live Inbox", icon: MessagesSquare, badge: d.handoffs },
        { to: "/app/enquiries", label: "Product Enquiries", icon: PackageSearch },
        { to: "/app/order-sheet", label: "Order Update", icon: ClipboardList },
        { to: "/app/product-scrapper", label: "Product Scrapper", icon: ScanSearch },
        { to: "/app/image-editor", label: "Image Editor", icon: WandSparkles, also: "/app/image-" },
        { to: "/app/seo", label: "SEO", icon: SearchCheck },
        { to: "/app/quick-replies", label: "Auto Replies", icon: Zap },
        { to: "/app/settings", label: "Bot Settings", icon: Sparkles },
      ],
    },
    {
      title: "Connection",
      items: [
        { to: "/app/whatsapp-web", label: "WhatsApp Connection", icon: Smartphone },
        { to: "/app/integrations", label: "Integrations", icon: Plug },
        { to: "/app/logs", label: "Activity Logs", icon: ScrollText, badge: d.errors },
      ],
    },
  ];
}

const CRUMBS: Record<string, string> = {
  conversations: "Live Inbox", enquiries: "Product Enquiries", "order-sheet": "Order Update", "product-scrapper": "Product Scrapper", "image-editor": "Image Editor", "image-products": "Image Editor", "image-bulk": "Image Editor", seo: "SEO", "quick-replies": "Auto Replies", orders: "Orders", products: "Products", settings: "Bot Settings",
  "whatsapp-web": "WhatsApp Connection", integrations: "Integrations", logs: "Activity Logs",
};

const initials = (shop: string) => shop.replace(/\.myshopify\.com$/, "").slice(0, 2).toUpperCase();

export function Shell({ data, children }: { data: ShellData; children: ReactNode }) {
  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const { pathname } = useLocation();

  useEffect(() => {
    try {
      setCollapsed(localStorage.getItem("orderly.sidebar") === "1");
    } catch {
      /* storage blocked: keep the default */
    }
  }, []);
  useEffect(() => {
    setMobileOpen(false);
  }, [pathname]);

  const toggle = () => {
    setCollapsed((c) => {
      try {
        localStorage.setItem("orderly.sidebar", c ? "0" : "1");
      } catch {
        /* ignore */
      }
      return !c;
    });
  };

  const page = CRUMBS[pathname.split("/")[2] ?? ""];
  const name = data.shop.replace(/\.myshopify\.com$/, "");

  return (
    <div className={`orderly shell${collapsed ? " is-collapsed" : ""}${mobileOpen ? " is-open" : ""}`}>
      <aside className="sb" aria-label="Main navigation">
        <div className="sb-brand">
          <span className="sb-logo">S</span>
          <span className="sb-name">ShopPilot</span>
          <button className="sb-collapse" onClick={toggle} aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}>
            {collapsed ? <ChevronsRight size={16} /> : <ChevronsLeft size={16} />}
          </button>
        </div>
        <nav className="sb-nav">
          {groups(data).map((g) => (
            <div className="sb-group" key={g.title}>
              <div className="sb-title">{g.title}</div>
              {g.items.map((it) => {
                const Icon = it.icon;
                return (
                  <NavLink key={it.to} to={it.to} end={it.end} className={({ isActive }) => `sb-link${isActive || (it.also && pathname.startsWith(it.also)) ? " active" : ""}`} data-tip={it.label}>
                    <Icon size={16} />
                    <span className="sb-label">{it.label}</span>
                    {!!it.badge && <span className="sb-badge">{it.badge > 99 ? "99+" : it.badge}</span>}
                  </NavLink>
                );
              })}
            </div>
          ))}
        </nav>
        <div className="sb-user">
          <span className="sb-avatar">{initials(data.shop)}</span>
          <span className="sb-user-text">
            <b>{name}</b>
            <small>Store admin</small>
          </span>
        </div>
      </aside>
      {mobileOpen && <button className="sb-scrim" aria-label="Close menu" onClick={() => setMobileOpen(false)} />}

      <div className="main">
        <header className="tb">
          <button className="tb-icon tb-burger" onClick={() => setMobileOpen((o) => !o)} aria-label="Toggle menu">
            {mobileOpen ? <X size={18} /> : <Menu size={18} />}
          </button>
          <nav className="tb-crumbs" aria-label="Breadcrumb">
            <Link to="/app">ShopPilot</Link>
            {page && (
              <>
                <span>/</span>
                <b>{page}</b>
              </>
            )}
            {!page && (
              <>
                <span>/</span>
                <b>Dashboard</b>
              </>
            )}
          </nav>
        </header>
        <SupportAlert initial={data.waiting} />
        <main className="content">{children}</main>
      </div>
    </div>
  );
}
