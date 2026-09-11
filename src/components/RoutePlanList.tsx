"use client";

import RouteStack from "./RouteStack";
import { useState } from "react";
import { useRouter } from "next/navigation";
import type { PlanRow } from "@/lib/home-plans-shared";

/**
 * 方案卡列表（首页方向卡点入 /routes 后展示，v0.13.x 从 HomeClient 拆出共用）
 * 每张卡 = 一条具体乘车方案；点击直接启动计时。
 */
export default function RoutePlanList({
  plans,
  onStart,
  routeColors,
}: {
  plans: PlanRow[];
  /** 可选：启动回调（缺省走 /api/timer POST + 跳转） */
  onStart?: (planId: number) => void;
  /** v0.20.0：全量线路色表（code → color），线路标签取色用 */
  routeColors?: Record<string, string>;
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
        body: JSON.stringify({ planId }),
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
        // v0.20.5（用户）：大卡片取消主题色背景与闪烁——底色与线路标签撞色、显脏；
        // 颜色只保留在线路标签上（主题色底 + 白字）
        return (
          <button
            key={p.id}
            className="press-card plan-card anim-fade-up"
            onClick={() => start(p.id)}
            disabled={starting !== null}
            aria-busy={isStarting}
            style={{ animationDelay: `${pi * 30}ms` }}
          >
            <span className="pc-inner" style={{ opacity: isStarting ? 0.75 : 1 }}>
              <span style={{ flex: 1, minWidth: 0 }}>
                {isStarting ? (
                  "启动中…"
                ) : p.board_name ? (
                  <>
                    <span aria-hidden>
                      {((p.leg_routes?.[0]?.[0] ?? p.route_codes?.[0] ?? "").startsWith("LRT-")
                        ? "🚈"
                        : "🚌")}
                    </span>{" "}
                    {/* v0.20.5：只写上车站（各线下车站不同，写下车站会误导） */}
                    <span>{p.board_name}</span>{" "}
                    {/* 换乘：每程一组线路标签，用「→」连接（轻轨 石排灣線→氹仔線 同理） */}
                    {(p.leg_routes?.length ? p.leg_routes : [p.route_codes ?? []]).map(
                      (codes, i) => (
                        <span
                          key={i}
                          style={{ display: "inline-flex", alignItems: "center", gap: 6 }}
                        >
                          {i > 0 && <span style={{ opacity: 0.6 }}>→</span>}
                          <RouteStack
                            codes={codes}
                            colorOf={(c) => routeColors?.[c]}
                            size="sm"
                          />
                        </span>
                      ),
                    )}
                  </>
                ) : (
                  p.summary
                )}
              </span>

            </span>
          </button>
        );
      })}
    </div>
  );
}
