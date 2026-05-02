/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  env: {
    NEXT_PUBLIC_API_URL: process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000/api/v1',
  },
  images: {
    domains: [],
  },

  // ─── Dev-server hardening (Windows + WSL) ──────────────────────────────
  // Webpack's PackFileCacheStrategy writes .next/cache/webpack/*.pack.gz
  // and renames the temp file into place at the end of every build.  On
  // Windows this rename intermittently fails with EPERM/ENOENT (the OS
  // briefly holds the file open or another worker is mid-read), which
  // corrupts the cache and stalls Fast Refresh.  Symptoms we hit during
  // this project: pages stuck on "Loading…" splash, /  taking 30+ s,
  // /_error compiling instead of the requested route.
  //
  // Switch to in-memory cache in dev — slightly slower cold start
  // (~1-2 s) in exchange for zero cache-corruption stalls and zero
  // Windows file-lock surprises.  Production builds keep the default
  // filesystem cache (fast incremental rebuilds in CI).
  webpack: (config, { dev }) => {
    if (dev) {
      config.cache = { type: 'memory' };
    }
    return config;
  },
};

module.exports = nextConfig;
