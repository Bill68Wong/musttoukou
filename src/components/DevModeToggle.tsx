"use client";

/**
 * 开发者模式开关（src/components/DevModeToggle.tsx，v1.0.0 / v1.1.11 改语义）
 *
 * ── ★ v1.1.11：开关**始终可见**，但**开启它需要口令**（用户 2026-09-17 口径）
 *
 * 用户原话：「我的意思是开启开发者模式才需要密钥」。
 * 此前 v1.1.10 的做法是「未登录就**不渲染**这个开关」—— 那是错的，有两个后果：
 *   ① 开关是通往登录页的**唯一可见入口**，藏了它 = 谁也进不去（连主人自己都没法开）
 *   ② 口令未配置时服务端判定「未登录」→ 开关对**所有人**消失（包括主人）
 *
 * 现在的语义：
 *   · 开关**一直显示**（公众看得到，但它只是一句「需口令」的提示）
 *   · 未登录时点击 → 跳 `/login?from=<当前页>`；登录后自动回到原页，开关即可用
 *   · 已登录时点击 → 正常开/关（**关闭永远不需要口令**，避免把自己锁住）
 *
 * 状态与 `src/lib/dev-mode.ts` 同一份（localStorage + 事件订阅），
 * 在首页与 `/recommend` 页脚各有一个开关，任一处切换另一处立即同步。
 *
 * ⚠️ 真正的保护是 `middleware.ts` 的口令门（受保护区 401/跳登录），
 *    本开关只决定「UI 里显示哪些开发者入口」，不是安全边界。
 */
import { usePathname } from "next/navigation";
import Link from "next/link";
import { useDevMode, writeDevMode } from "@/lib/dev-mode";

export default function DevModeToggle({
  compact = false,
  authed = false,
}: {
  compact?: boolean;
  /** ★ v1.1.11：是否已过口令门（由服务端读 cookie 传入）。false = 点开关会先去登录 */
  authed?: boolean;
}) {
  const on = useDevMode();
  const pathname = usePathname();

  // 未登录：开关是个「去登录」的入口（保留开关外观，让人知道有这东西）
  // ★ `dev=1` → 登录成功后由 <LoginForm> 顺手把开发者模式打开（省一次点击）
  if (!authed) {
    return (
      <Link
        href={`/login?from=${encodeURIComponent(pathname)}&dev=1`}
        className="btn btn--text btn--sm"
        title="开发者模式需要口令"
        style={compact ? undefined : { display: "inline-flex", alignItems: "center", gap: 6 }}
      >
        <span
          aria-hidden
          style={{
            display: "inline-block",
            width: 8,
            height: 8,
            borderRadius: 999,
            background: "var(--outline)",
          }}
        />
        开发者模式：需口令 🔒
      </Link>
    );
  }

  return (
    <button
      className="btn btn--text btn--sm"
      onClick={() => writeDevMode(!on)}
      aria-pressed={on}
      title={on ? "点击关闭：路线卡将只展示信息" : "点击开启：路线卡可直接开始计时（采集实测样本）"}
      style={compact ? undefined : { display: "inline-flex", alignItems: "center", gap: 6 }}
    >
      <span
        aria-hidden
        style={{
          display: "inline-block",
          width: 8,
          height: 8,
          borderRadius: 999,
          background: on ? "var(--ok)" : "var(--outline)",
        }}
      />
      开发者模式：{on ? "已开启" : "已关闭"}
    </button>
  );
}
