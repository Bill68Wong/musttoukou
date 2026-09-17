/**
 * 服务端鉴权判定（src/lib/auth-server.ts，v1.1.10）
 *
 * ⚠️ server-only（用 `next/headers`）—— client 组件禁止 import。
 *
 * 用途：把「是否已过口令门」传给**公开页面**（首页 / 推荐 / 详情），
 * 让开发者入口（开发者开关、數據頁入口、開始計時按钮）**只对已登录者渲染**。
 *
 * 为什么需要它：开发者模式本身只是浏览器里的 `localStorage` 开关，
 * **任何人都能点开** —— 单纯藏按钮不算保护（真正的保护是 `middleware.ts` 的 401）。
 * 但藏起来能让公众看不到一堆点进去就撞口令墙的死链，同时满足用户
 * 「开发者模式只有我能开」的诉求。
 *
 * 判定口径与 `middleware.ts` 保持一致：cookie 值 === ACCESS_PASSWORD。
 * 未配置口令时：开发环境视为已登录（本地调试方便），生产环境视为未登录（fail-closed）。
 */
import { cookies } from "next/headers";

export async function isAuthed(): Promise<boolean> {
  const pw = process.env.ACCESS_PASSWORD;
  if (!pw) return process.env.NODE_ENV !== "production";
  try {
    const c = await cookies();
    return c.get("mx_auth")?.value === pw;
  } catch {
    // 静态渲染等场景下 cookies() 可能抛 → 按未登录处理（安全方向）
    return false;
  }
}
