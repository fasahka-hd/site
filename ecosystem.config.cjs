// pm2 ecosystem config (CommonJS — поэтому расширение .cjs)
// Положи в корень папки site на VPS и запусти: pm2 start ecosystem.config.cjs
module.exports = {
  apps: [
    {
      name: "arizona-panel",
      // обычный запуск (1 процесс):
      script: "server.js",
      // если хочешь использовать несколько ядер VPS — замени на:
      // script: "cluster.js",
      cwd: __dirname,
      instances: 1,
      autorestart: true,          // перезапуск при падении
      max_memory_restart: "512M", // перезапуск при утечке памяти
      watch: false,
      env: {
        NODE_ENV: "production"
      }
    }
  ]
};
