import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // DSAT 接口仅由服务端调用，无需跨域配置
  experimental: {},
  async rewrites() {
    return [
      // ★ v1.3.0 高德 JS API 安全代理（设计 §2.D）
      //   公开 URL 保持设计要求的 `/_AMapService/*`；但 **Next App Router 把「下划线开头」
      //   的文件夹视为私有文件夹、不参与路由** ⇒ 无法直接在 `src/app/_AMapService/` 放 route。
      //   ⇒ 处理器实际放在 `/api/amap-service`，这里把它「暴露」为 `/_AMapService`。
      //   浏览器设 `_AMapSecurityConfig.serviceHost = location.origin + '/_AMapService'`，
      //   高德 JS 的所有服务请求即打到本代理（密钥/安全码只在服务端拼接，不下发浏览器）。
      { source: "/_AMapService/:path*", destination: "/api/amap-service/:path*" },
    ];
  },
};

export default nextConfig;
