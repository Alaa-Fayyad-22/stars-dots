/** @type {import('next').NextConfig} */
const nextConfig = {
  poweredByHeader: false,
  async headers() {
    return [
      {
        // Belt and braces: every API response is also marked no-store by the
        // route itself (lib/http.js), so nothing game-related is ever cached
        // by the browser, Vercel or a CDN.
        source: "/api/:path*",
        headers: [{ key: "Cache-Control", value: "no-store, max-age=0" }],
      },
    ];
  },
};

module.exports = nextConfig;
