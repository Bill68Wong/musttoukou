"use client";
/**
 * 线路名标签组（v0.19.1）：主题色底 + 白字标签
 * 多线路时按谷歌地图样式——色块之间用「右上到左下」的斜切留白分隔（不用「/」字符）。
 *
 * ⚠️ v1.1.7：曾评估过「按亮度自适应黑/白字」（氹仔線白字实测仅 1.79:1），
 *    但用户 2026-09-16 复看真实对照图后**明确决定不改** —— 保留 v0.20.0 定的
 *    「所有主题色标签统一白字」。故此处维持写死白字，勿再引入 inkOn。
 */
import { lineNameOf, sortRouteOptions } from "@/lib/route-label";

export default function RouteStack({
  codes,
  colorOf,
  colors,
  size = "md",
  className = "",
}: {
  codes: (string | null | undefined)[];
  /**
   * 线路码 → 主题色（缺省用主色）。
   * ⚠️ **只允许在 Client Component 之间传**（函数不可跨 RSC 边界序列化）。
   */
  colorOf?: (code: string) => string | null | undefined;
  /**
   * ★ 可序列化的「线路码 → 色」表。
   * **Server Component 必须用本 prop**（不能传 `colorOf` 函数，否则 RSC 序列化报错 ✗）。
   * 二者同时给时**以 `colorOf` 优先**（客户端内部函数更精确）。
   */
  colors?: Record<string, string> | null;
  size?: "sm" | "md";
  className?: string;
}) {
  const list = sortRouteOptions((codes ?? []).filter(Boolean) as string[]);
  if (!list.length) return null;
  const resolve = colorOf ?? (colors ? (c: string) => colors[c] : undefined);
  return (
    <span className={`route-stack${size === "sm" ? " route-stack--sm" : ""} ${className}`}>
      {list.map((c) => (
        <span
          key={c}
          className="route-stack__seg"
          style={{ background: resolve?.(c) || "var(--primary)" }}
          title={lineNameOf(c)}
        >
          {lineNameOf(c)}
        </span>
      ))}
    </span>
  );
}
