FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json* ./
COPY prisma ./prisma

# Install ALL deps first: vite / react-router dev are needed for the build.
RUN npm ci && npm cache clean --force

COPY . .
RUN npx prisma generate && npm run build && npm prune --omit=dev && npx prisma generate

# Everything that must survive a restart lives in /data.
# Mount a persistent volume at /data on your host (docker-compose.yml mounts the app_data volume on your Hostinger VPS).
ENV NODE_ENV=production \
    PORT=3000 \
    DATABASE_URL=file:/data/shoppilot.sqlite \
    WHATSAPP_AUTH_DIR=/data/wa-auth \
    WHATSAPP_MEDIA_DIR=/data/wa-media \
    FINDER_MEDIA_DIR=/data/finder-media \
    IMAGE_EDITOR_DIR=/data/image-editor

EXPOSE 3000
VOLUME ["/data"]

CMD ["npm", "run", "docker-start"]
