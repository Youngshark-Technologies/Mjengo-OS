import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
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
