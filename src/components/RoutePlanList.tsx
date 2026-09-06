"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { PlanRow } from "@/lib/home-plans-shared";

/** 测试模式 localStorage 键（首页开关与路线选择页共用） */
export const TEST_MODE_KEY = "mtk_test_mode";

/* ---------- v0.8.0 主题色工具：卡片背景 = 线路原色（实色），文字按亮度自动对比 ---------- */
function rgbOf(hex: string): { r: number; g: number; b: number } | null {
  const h = hex.replace("#", "");
  const full =
    h.length === 3
      ? h
          .split("")
          .map((c) => c + c)
          .join("")
      : h;
  const n = parseInt(full, 16);
  if (Number.isNaN(n)) return null;
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}
function luma(hex: string): number {
  const c = rgbOf(hex);
  if (!c) return 128;
  return (c.r * 299 + c.g * 587 + c.b * 114) / 1000;
}
function shade(hex: string, factor: number): string {
  const c = rgbOf(hex);
  if (!c) return hex;
  const f = (v: number) => Math.max(0, Math.min(255, Math.round(v * factor)));
  return `rgb(${f(c.r)},${f(c.g)},${f(c.b)})`;
}
function inkOf(colors: (string | null)[]): { color: string; shadow: string } {
  const segs = colors.filter((c): c is string => !!c);
  if (segs.length === 0) return { color: "", shadow: "" };
  const lightest = Math.max(...segs.map(luma));
  return lightest > 155
    ? { color: "#101418", shadow: "0 1px 1px rgba(255,255,255,.22)" }
    : { color: "#ffffff", shadow: "0 1px 2px rgba(0,0,0,.32)" };
}
function solidGradient(colors: (string | null)[]): string {
  const segs = colors.filter((c): c is string => !!c);
  if (segs.length === 0) return "";
  if (segs.length === 1) {
    return `linear-gradient(135deg, ${segs[0]} 0%, ${shade(segs[0], 0.9)} 100%)`;
  }
  const w = 100 / segs.length;
  const stops = segs
    .map((c, i) => `${c} ${(i * w).toFixed(2)}% ${((i + 1) * w).toFixed(2)}%`)
    .join(", ");
  return `linear-gradient(to right, ${stops})`;
}

/** 读测试模式偏好（浏览器端；服务端渲染首帧返回 false 无碍） */
export function readTestMode(): boolean {
  if (typeof window === "undefined") return false;
  return window.localStorage.getItem(TEST_MODE_KEY) === "1";
}

/**
 * 方案卡列表（首页方向卡点入 /routes 后展示，v0.13.x 从 HomeClient 拆出共用）
 * 每张卡 = 一条具体乘车方案；点击直接启动计时（is_test 跟随首页测试模式开关）。
 */
export default function RoutePlanList({
  plans,
  onStart,
}: {
  plans: PlanRow[];
  /** 可选：启动回调（缺省走 /api/timer POST + 跳转） */
  onStart?: (planId: number) => void;
}) {
  const router = useRouter();
  const [starting, setStarting] = useState<number | null>(null);

  async function start(planId: number) {
    setStarting(planId);
    if (onStart) {
      onStart(planId);
      return;
    }
    try {
      const res = await fetch("/api/timer", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ planId, is_test: readTestMode() }),
      });
      if (!res.ok) throw new Error(((await res.json()) as { error?: string }).error ?? "启动失败");
      const body = (await res.json()) as { sessionId?: number };
      if (!body.sessionId) throw new Error("启动失败：未返回会话");
      router.push(`/timer/${body.sessionId}`);
    } catch (e) {
      alert((e as Error).message);
      setStarting(null);
    }
  }

  if (plans.length === 0) {
    return (
      <p className="t-body t-muted t-center" style={{ marginTop: 8 }}>
        这个方向还没有可选的路线
      </p>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      {plans.map((p, pi) => {
        const isStarting = starting === p.id;
        const hasColor = p.colors?.some(Boolean) ?? false;
        const veil = hasColor ? solidGradient(p.colors!) : "";
        const ink = hasColor ? inkOf(p.colors!) : { color: "", shadow: "" };
        return (
          <button
            key={p.id}
            className="press-card plan-card anim-fade-up"
            onClick={() => start(p.id)}
            disabled={starting !== null}
            aria-busy={isStarting}
            style={{ animationDelay: `${pi * 30}ms` }}
          >
            {veil && <span aria-hidden className="pc-veil" style={{ background: veil }} />}
            <span
              className="pc-inner"
              style={{
                opacity: isStarting ? 0.75 : 1,
                color: ink.color,
                textShadow: ink.shadow,
              }}
            >
              <span style={{ flex: 1, minWidth: 0 }}>
                {isStarting ? "启动中…" : p.summary}
              </span>
              <span
                className="pc-count"
                style={{ fontSize: 13, flexShrink: 0, fontWeight: 600 }}
              >
                {isStarting ? "" : `${p.samples} 份`}
              </span>
            </span>
          </button>
        );
      })}
    </div>
  );
}
