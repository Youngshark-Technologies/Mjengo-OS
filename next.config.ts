import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  // MJG-027 — hosted split deployment:
  // When BACKEND_URL is set (frontend deploy on Vercel), all /api traffic is
  // proxied to the backend service (Render). The browser only ever talks to the
  // frontend origin, so the same-origin session-cookie model is preserved and
  // no CORS is needed. Leave BACKEND_URL unset when the API runs in the same
  // process (local dev, Docker, Render itself) — this function is then a no-op.
  async rewrites() {
    const backend = process.env.BACKEND_URL?.replace(/\/+$/, "");
    if (!backend) return [];
    return [{ source: "/api/:path*", destination: `${backend}/api/:path*` }];
  },
  // MJG-024 — production hardening:
  // - Type errors must fail the production build (was: silently ignored).
  // - Strict mode surfaces React correctness issues in development.
  // - Baseline security headers on every response; TLS/HSTS and CSP are
  //   terminated/added at the edge platform (see docs/DEPLOYMENT.md).
  typescript: {
    ignoreBuildErrors: false,
  },
  reactStrictMode: true,
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "SAMEORIGIN" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          {
            key: "Permissions-Policy",
            value: "camera=(), microphone=(), geolocation=()",
          },
        ],
      },
    ];
  },
};

export default nextConfig;
