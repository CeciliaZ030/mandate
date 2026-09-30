// pm2 start ecosystem.config.cjs && pm2 save
const path = require("path");
module.exports = {
  apps: [
    {
      name: "mandate-agent",
      cwd: __dirname,
      script: path.join(__dirname, "src/index.js"),
      interpreter: "node",
      autorestart: true,
      max_restarts: 20,
      restart_delay: 15000,
      time: true,
    },
  ],
};
