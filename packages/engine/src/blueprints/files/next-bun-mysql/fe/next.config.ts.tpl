import type { NextConfig } from "next";

/** The API's address. The browser calls /api/... here and Next passes it on, so cookies just work. */
const backend = (process.env.BACKEND_URL ?? "http://127.0.0.1:4000").replace(/\/+$/, "");

const config: NextConfig = {
  async rewrites() {
    return [{ source: "/api/:path*", destination: `${backend}/api/:path*` }];
  },
};

export default config;
