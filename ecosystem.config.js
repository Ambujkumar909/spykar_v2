// ─── PM2 process definitions for Spykar IQ (production) ───────────────────────
//
// Runs the backend API and the Next.js frontend as two managed, auto-restarting
// processes. From the repo root:
//
//   pm2 start ecosystem.config.js      # start both
//   pm2 restart ecosystem.config.js    # restart both
//   pm2 stop ecosystem.config.js       # stop both
//   pm2 logs spykar-api                # tail backend logs
//   pm2 save && pm2 startup            # persist + auto-start on reboot
//
// Prereqs: backend `.env` and frontend `.env.local` are filled in, the frontend
// has been built (`npm run build`), and PostgreSQL/Redis are running. See
// DEPLOYMENT.md for the full first-time setup.

module.exports = {
  apps: [
    {
      // ── Backend API (Express) ──────────────────────────────────────────────
      name: 'spykar-api',
      cwd: './spykar-backend',
      script: 'src/server.js',
      // 8 GB V8 heap — analytics + sync hold large result sets.
      node_args: '--max-old-space-size=8192',
      exec_mode: 'fork',
      instances: 1,
      autorestart: true,
      max_restarts: 10,
      // If the process balloons past 6 GB RSS something leaked — recycle it.
      max_memory_restart: '6G',
      // Reads spykar-backend/.env at boot (dotenv inside the app), but we also
      // force NODE_ENV here so prod behaviour (CORS allow-list, etc.) is on.
      env: {
        NODE_ENV: 'production',
      },
      out_file: './logs/pm2-api-out.log',
      error_file: './logs/pm2-api-error.log',
      time: true,
    },
    {
      // ── Frontend (Next.js production server) ───────────────────────────────
      // Run the `next` binary directly (cleaner under PM2 than `npm run start`).
      // Requires a prior `npm run build` in spykar-frontend.
      name: 'spykar-web',
      cwd: './spykar-frontend',
      script: './node_modules/next/dist/bin/next',
      args: 'start -p 3000',
      exec_mode: 'fork',
      instances: 1,
      autorestart: true,
      max_restarts: 10,
      env: {
        NODE_ENV: 'production',
      },
      out_file: './logs/pm2-web-out.log',
      error_file: './logs/pm2-web-error.log',
      time: true,
    },
  ],
};
