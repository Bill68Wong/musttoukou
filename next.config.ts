import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // DSAT 接口仅由服务端调用，无需跨域配置
  experimental: {},
};

export default nextConfig;
