# Deploying WERY AIO on Hostinger

## Which Hostinger plan?
This app needs a **permanently running Node process** (WhatsApp/Baileys keeps a live socket, the image editor
runs background workers with sharp + background removal, Product Scrapper uses long jobs, data is SQLite on disk).
Use a **Hostinger VPS** (KVM 2 or bigger, 2 vCPU / 8 GB recommended; Ubuntu 22.04/24.04).
Shared/"Web Hosting" Node.js plans kill long-running processes and are not suitable.

## 1. Domain + DNS
Point an A record (e.g. `app.yourdomain.com`) to the VPS IP in hPanel > Domains > DNS.

## 2. Prepare the VPS
Pick the **Ubuntu 24.04 with Docker** template when creating the Hostinger VPS (or run `curl -fsSL https://get.docker.com | sh`).
Docker runs everything, including HTTPS; nothing else needs installing.

## 3. Upload the project
```bash
git clone <your-repo-url> /opt/wery-aio && cd /opt/wery-aio
# or upload the folder via SFTP (skip node_modules, build, .env, *.sqlite)
cp .env.example .env && nano .env
```
Fill `DOMAIN` (e.g. `app.yourdomain.com`), `SHOPIFY_API_KEY`, `SHOPIFY_API_SECRET`, and `SECRETS_KEY` (`openssl rand -hex 32`).
Docker sets the app URL, database and WhatsApp folders itself.

## 4-5. Start everything
```bash
docker compose up -d --build
docker compose logs -f
```
This starts the app (migrations run automatically) and Caddy (free HTTPS certificate for `DOMAIN`).
Open ports 80 and 443 in the Hostinger VPS firewall. Data lives in the `app_data` volume - back it up with
`docker run --rm -v wery-aio_app_data:/data -v $PWD:/b busybox tar czf /b/backup.tgz /data`.

## 6. Tell Shopify the new URL
Edit `shopify.app.toml`: replace `https://example.com` in `application_url` and `redirect_urls`
(`https://app.yourdomain.com` and `https://app.yourdomain.com/api/auth`), then on your PC run:
```bash
npm run deploy
```
(or set the URLs in Partner Dashboard > App setup). Webhooks re-register to the new host automatically.

## Updating later
```bash
cd /opt/wery-aio && git pull && docker compose up -d --build
```

## Alternative: no Docker (PM2)
Needs Node 22: `curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && apt install -y nodejs openssl`
```bash
npm ci --include=dev && npx prisma generate && npm run build
npm i -g pm2 && pm2 start ecosystem.config.cjs && pm2 save && pm2 startup
```
Set `DATABASE_URL` to an absolute path outside the repo (add it to .env) and keep `.wa-auth` / `.wa-media` persistent.

## Notes
- Run ONE instance only (SQLite + a single WhatsApp session).
- Product Scrapper uses `playwright-core`; if a mode needs a real browser, install Chromium on the VPS.
- Never commit `.env`; `.wa-auth` is a live WhatsApp login - keep it private.

## Hostinger Cloud Startup / managed Node.js (no Docker, no root)
Cloud Startup is managed hosting, not a VPS: no Docker, no Caddy (Hostinger provides HTTPS).
Dashboard, Orders, Google Sheet and SEO should work. WhatsApp (Baileys) needs an always-on process and may
disconnect when the host restarts or idles it, and the image editor / background removal can hit memory limits.
For stable WhatsApp + image editor, use a VPS instead.

1. Push the code to GitHub. In hPanel: Websites > Add website > Node.js Apps, connect the repo.
2. Node version 22 or newer (the project needs >=22.12).
3. Build command: `npm ci --include=dev && npx prisma generate && npm run build`
4. Entry file: `server.js` (in the repo root; it runs migrations, then starts the app). If there is a start command field, use `npm run docker-start`. Do NOT set the entry file to `build/server/index.js` and do not use an output directory.
5. Environment variables (see `.env.example`): `SHOPIFY_API_KEY`, `SHOPIFY_API_SECRET`, `SCOPES`,
   `SHOPIFY_APP_URL` (your https domain), `SECRETS_KEY`, `NODE_ENV=production`, plus data paths OUTSIDE the app folder
   so redeploys do not wipe them:
   `DATABASE_URL=file:/home/<user>/wery-data/shoppilot.sqlite`,
   `WHATSAPP_AUTH_DIR=/home/<user>/wery-data/wa-auth`, `WHATSAPP_MEDIA_DIR=/home/<user>/wery-data/wa-media`,
   `FINDER_MEDIA_DIR=/home/<user>/wery-data/finder-media`, `IMAGE_EDITOR_DIR=/home/<user>/wery-data/image-editor`.
6. Update `shopify.app.toml` (`application_url`, `redirect_urls`) to your domain and run `npm run deploy`.

## Any Node.js host (generic)
Requirements: Node >= 22.12, persistent disk, one always-on process. Set the env vars from `.env.example`, then:
```bash
npm ci && npm run build && npm run docker-start   # = prisma generate + migrate deploy + start
```
The server listens on `$PORT` (default 3000). Put HTTPS in front and use that URL as `SHOPIFY_APP_URL`.

