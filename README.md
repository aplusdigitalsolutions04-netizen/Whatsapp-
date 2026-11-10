# ShopPilot (Orderly)

A Shopify app for a WhatsApp-first store: a customer-service bot, live inbox, order sheet, product sourcing, image editor and SEO tools in one embedded admin app.

- **WhatsApp bot** answers order, tracking and product questions in short numbered points (English, Hindi, Hinglish) and hands over to a person on request. A pop-up alert and a dashboard banner tell you which customer to attend.
- **Order Update** keeps orders in sync with Shopify and a Google Sheet.
- **Product Scrapper, Image Editor, SEO** are store tools that work on your Shopify catalogue.

Built with React Router 7, Prisma (SQLite), Baileys (WhatsApp Web) and the Shopify app packages.

## Develop

```bash
npm install
shopify app dev      # Shopify CLI: tunnel, env vars and the dev store
```

## Check

```bash
npm run typecheck
npm run lint
npm test
npm run build
```

## Run in production

```bash
npm run build
npm start            # checks settings, prepares the database, starts the server
```

`npm start` fills sensible defaults, runs the database migrations and serves a clear status page (instead of a bare 503) if a required setting is missing. Settings are listed in `.env.example`; deployment notes for Hostinger are in [docs/HOSTINGER.md](docs/HOSTINGER.md). `GET /health` reports whether the app and its database are up.

## Layout

| Path | What |
| --- | --- |
| `app/routes.ts` | Every route, listed explicitly (a test fails if a route file is missing here) |
| `app/lib/bot.server.ts` | WhatsApp conversation logic |
| `app/lib/shopify-data.server.ts` | Shopify Admin GraphQL access (orders, products) |
| `scripts/start.mjs` | Production entry point, also used by `server.js` |
| `prisma/` | Schema and migrations |
| `tests/` | Node test runner suites |
