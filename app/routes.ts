import { index, route, type RouteConfig } from "@react-router/dev/routes";

// Routes are listed explicitly instead of using `flatRoutes()` from @react-router/fs-routes.
//
// flatRoutes() skips every file for which `Dirent.isFile()` is false. On Windows, files that live in a OneDrive
// folder (Desktop/Documents sync) and are "online-only" carry a cloud reparse point, and Node reports them as
// symbolic links. flatRoutes() silently dropped them, so the build and dev server started "fine" but the `app`
// layout (sidebar, styles, Shopify auth) and most pages were missing: unstyled dashboard, 404 on every other page.
//
// The URLs and route ids are exactly what the flat-file convention produced (routes/app.tsx -> id "routes/app").
// A new file in app/routes must be added here; tests/routes.test.ts fails if one is forgotten.
export default [
  index("routes/_index/route.tsx"),

  route("health", "routes/health.tsx"),

  // Shopify auth + webhooks
  route("auth/*", "routes/auth.$.tsx"),
  route("webhooks/app/scopes_update", "routes/webhooks.app.scopes_update.tsx"),
  route("webhooks/app/uninstalled", "routes/webhooks.app.uninstalled.tsx"),
  route("webhooks/orders/cancelled", "routes/webhooks.orders.cancelled.tsx"),
  route("webhooks/orders/create", "routes/webhooks.orders.create.tsx"),
  route("webhooks/orders/updated", "routes/webhooks.orders.updated.tsx"),
  route("webhooks/products/update", "routes/webhooks.products.update.tsx"),

  // Resource routes
  route("api/avatar/:id", "routes/api.avatar.$id.tsx"),
  route("api/finder/*", "routes/api.finder.$.tsx"),
  route("api/image-editor/*", "routes/api.image-editor.$.tsx"),
  route("api/media/:id", "routes/api.media.$id.tsx"),
  route("api/send", "routes/api.send.tsx"),
  route("api/seo/*", "routes/api.seo.$.tsx"),
  route("api/webhooks/whatsapp", "routes/api.webhooks.whatsapp.tsx"),

  // Embedded admin app: routes/app.tsx is the layout (Shopify AppProvider, sidebar shell, stylesheets)
  route("app", "routes/app.tsx", [
    index("routes/app._index.tsx"),
    route("conversations", "routes/app.conversations.tsx"),
    route("enquiries", "routes/app.enquiries.tsx"),
    route("image-bulk", "routes/app.image-bulk.tsx"),
    route("image-editor", "routes/app.image-editor.tsx"),
    route("image-products", "routes/app.image-products.tsx"),
    route("integrations", "routes/app.integrations.tsx"),
    route("logs", "routes/app.logs.tsx"),
    route("order-sheet", "routes/app.order-sheet.tsx"),
    route("orders", "routes/app.orders.tsx"),
    route("product-scrapper", "routes/app.product-scrapper.tsx"),
    route("products", "routes/app.products.tsx"),
    route("quick-replies", "routes/app.quick-replies.tsx"),
    route("seo", "routes/app.seo.tsx"),
    route("settings", "routes/app.settings.tsx"),
    route("waiting", "routes/app.waiting.tsx"),
    route("whatsapp-web", "routes/app.whatsapp-web.tsx"),
  ]),
] satisfies RouteConfig;
