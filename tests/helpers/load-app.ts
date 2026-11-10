// Loads app modules (which use extension-less imports and Vite-style resolution) inside a throw-away Vite SSR server,
// so the chatbot flow can be tested end to end without a browser, Shopify or WhatsApp.
import { createServer, type ViteDevServer } from "vite";
import { fileURLToPath } from "node:url";

process.env.SHOPIFY_API_KEY ||= "test-key";
process.env.SHOPIFY_API_SECRET ||= "test-secret";
process.env.SHOPIFY_APP_URL ||= "https://test.example.com";
process.env.SCOPES ||= "read_orders,read_customers,read_products";

let server: Promise<ViteDevServer> | null = null;

export async function loadApp<T = Record<string, any>>(file: string): Promise<T> { // eslint-disable-line @typescript-eslint/no-explicit-any
  server ??= createServer({
    configFile: false,
    root: fileURLToPath(new URL("../../", import.meta.url)),
    appType: "custom",
    logLevel: "error",
    server: { middlewareMode: true, hmr: false, ws: false },
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  return (await (await server).ssrLoadModule(file)) as T;
}

export async function closeApp() {
  if (server) await (await server).close();
  server = null;
}
