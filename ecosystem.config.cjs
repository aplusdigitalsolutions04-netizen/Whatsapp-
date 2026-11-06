// PM2 config for running without Docker on a Hostinger VPS:  pm2 start ecosystem.config.cjs
module.exports = {
  apps: [
    {
      name: "wery-aio",
      script: "npm",
      args: "run docker-start",
      env: { NODE_ENV: "production", PORT: 3000 },
      max_memory_restart: "1500M",
      autorestart: true,
    },
  ],
};
