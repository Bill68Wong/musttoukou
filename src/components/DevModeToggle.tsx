"use client";

/**
 * 开发者模式开关（src/components/DevModeToggle.tsx，v1.0.0）
 *
 * 关闭（默认）：路线大卡只展示信息，点开是文字指引 —— 普通用户不会误入计时流程。
 * 开启：点大卡 = 直接按该条的线路/上下车站建计时会话 → 采实测样本（并解锁 `/routes`）。
 *
 * 状态与 `src/lib/dev-mode.ts` 同一份（localStorage + 事件订阅），
 * 在首页与 `/recommend` 页脚各有一个开关，任一处切换另一处立即同步。
 */
import { useDevMode, writeDevMode } from "@/lib/dev-mode";

export default function DevModeToggle({ compact = false }: { compact?: boolean }) {
  const on = useDevMode();
  return (
    <button
      className="btn btn--text btn--sm"
      onClick={() => writeDevMode(!on)}
      aria-pressed={on}
      title={
        on
          ? "點擊關閉：路線卡將只展示資訊"
          : "點擊開啟：路線卡可直接開始計時（採集實測樣本）"
      }
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
      開發者模式：{on ? "已開啟" : "已關閉"}
    </button>
  );
}
