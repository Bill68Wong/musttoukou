"use client";
/**
 * 防滚动误触（src/lib/use-press-guard.ts，v1.1.8）
 *
 * 场景：预测卡片是**整张可点的 `div[role=button]`**（高 200~280px），而列表要滚动。
 * 手指在卡上按下 → 滑动 → 抬起 —— 浏览器**仍会派发 `click`**
 * ⇒ 用户只想滚动列表，却把卡片点开了（开发者模式下这一下还会建计时会话）。
 *
 * 判据（两条任一命中即判为「滚动/长按」而非「点击」）：
 *   · 指针位移 > `movePx`（默认 8px）
 *   · 按住时长 > `holdMs`（默认 700ms）—— 长按通常是犹豫或选文字，不该触发跳转
 *
 * 用法：
 * ```tsx
 * const press = usePressGuard();
 * <div onPointerDown={press.onPointerDown} onPointerMove={press.onPointerMove}
 *      onClick={() => { if (press.isGuarded()) return; go(); }} />
 * ```
 * ⚠️ `isGuarded()` 是**一次性**的（读完即清），避免影响后续点击。
 * ⚠️ 键盘触发（Enter/Space）没有 pointerdown → `isGuarded()` 返回 false，正常放行。
 */
import { useRef } from "react";

export const PRESS_MOVE_PX = 8;
export const PRESS_HOLD_MS = 700;

export interface PressGuard {
  onPointerDown: (e: React.PointerEvent) => void;
  onPointerMove: (e: React.PointerEvent) => void;
  /** 在 onClick 开头调用：true = 忽略本次点击（它其实是一次滚动/长按） */
  isGuarded: () => boolean;
}

export function usePressGuard(movePx = PRESS_MOVE_PX, holdMs = PRESS_HOLD_MS): PressGuard {
  const st = useRef<{ x: number; y: number; t: number; moved: boolean } | null>(null);

  return {
    onPointerDown: (e) => {
      st.current = { x: e.clientX, y: e.clientY, t: Date.now(), moved: false };
    },
    onPointerMove: (e) => {
      const s = st.current;
      if (!s || s.moved) return;
      if (Math.hypot(e.clientX - s.x, e.clientY - s.y) > movePx) s.moved = true;
    },
    isGuarded: () => {
      const s = st.current;
      st.current = null; // 一次性
      if (!s) return false;
      return s.moved || Date.now() - s.t > holdMs;
    },
  };
}
