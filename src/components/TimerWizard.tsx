"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { buildSteps, currentStepIndex, type PlanLegLite } from "@/lib/timer-flow";
import LiveEta from "./LiveEta";

interface SessionData {
  session: {
    id: number;
    summary: string;
    ended_at: string | null;
    missed_count: number;
    crowd_level: number | null;
    total_minutes: number | null;
    dsat_dir: string | null;
  };
  legs: PlanLegLite[];
  events: { id: number; seq: number; event_type: string; station_code: string | null; recorded_at: string }[];
  snapshots: { id: number; value_kind: string; value: number; recorded_at: string }[];
  stationNames: Record<string, string>;
  routeStopsByRoute: Record<string, { seq: number; code: string; name: string }[]>;
}

const QUICK_VALUES = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];

const EVENT_LABELS: Record<string, string> = {
  depart: "出发",
  wait_start: "到站等车",
  missed: "没挤上",
  board: "上车",
  station_arrive: "途经站",
  alight: "下车",
  border_start: "开始通关",
  border_end: "通关完成",
  arrive: "到达",
};

export default function TimerWizard({ sessionId }: { sessionId: number }) {
  const router = useRouter();
  const [data, setData] = useState<SessionData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [posting, setPosting] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/timer/${sessionId}`, { cache: "no-store" });
      if (!res.ok) throw new Error(((await res.json()) as { error?: string }).error ?? "加载失败");
      setData((await res.json()) as SessionData);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [sessionId]);

  useEffect(() => {
    load();
  }, [load]);

  // 已结束 → 跳结束页
  useEffect(() => {
    if (data?.session.ended_at) router.replace(`/finish/${sessionId}`);
  }, [data, router, sessionId]);

  async function postEvent(type: string, extra?: Record<string, unknown>) {
    setPosting(true);
    try {
      const res = await fetch(`/api/timer/${sessionId}/events`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type, ...extra }),
      });
      if (!res.ok) {
        const body = (await res.json()) as { error?: string };
        throw new Error(body.error ?? "打点失败");
      }
      // wait_start 时顺手触发车辆抓取（不阻塞）
      if (type === "wait_start") {
        void fetch("/api/dsat/grab", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionId }),
        }).catch(() => {});
      }
      await load();
    } catch (e) {
      alert((e as Error).message);
    } finally {
      setPosting(false);
    }
  }

  if (error) {
    return (
      <main className="page">
        <p style={{ color: "var(--danger)", marginBottom: 16 }}>加载失败：{error}</p>
        <button onClick={() => router.push("/")}>返回首页</button>
      </main>
    );
  }
  if (!data) {
    return (
      <main className="page">
        <p style={{ color: "var(--muted)" }}>加载中…</p>
      </main>
    );
  }

  const steps = buildSteps(data.legs);
  const idx = currentStepIndex(steps, data.events);
  const step = steps[idx];
  const finished = idx >= steps.length || !!data.session.ended_at;
  const stationName = (code?: string | null) =>
    code ? (data.stationNames[code] ?? code) : "";

  // 等车阶段（已到站、待上车）
  const waiting = step?.eventType === "board";
  // 出门/走路阶段（出发前 或 已出门未到站）：可记车距初估
  const departing =
    step?.eventType === "depart" || step?.eventType === "wait_start";
  const showQuick =
    (waiting || departing) && step.quickKind !== undefined;
  // 乘车阶段（已上车、待下车）
  const riding = step?.eventType === "alight";

  // ===== 乘车进度推算（下一站 / 剩余站数）=====
  // 站区码兼容匹配：T560 匹配 T560、T560/4；T560/2 也匹配 T560（取首个命中）
  const findStopIdx = (
    stops: { seq: number; code: string; name: string }[],
    target: string | null | undefined,
  ) => {
    if (!target) return -1;
    let i = stops.findIndex((s) => s.code === target);
    if (i < 0) i = stops.findIndex((s) => s.code.startsWith(target + "/"));
    if (i < 0) i = stops.findIndex((s) => target.startsWith(s.code + "/"));
    return i;
  };

  type RideInfo = {
    routeCode: string;
    nextName: string;
    nextCode: string | null;
    remaining: number | null;
    upcoming: { name: string; isDest: boolean }[];
  };
  let rideInfo: RideInfo | null = null;
  if (riding && step.routeOptions) {
    const routeCode = step.routeOptions.find((r) => (data.routeStopsByRoute[r]?.length ?? 0) > 0);
    const stops = routeCode ? data.routeStopsByRoute[routeCode] : undefined;
    if (routeCode && stops && stops.length > 0) {
      const boardIdx = findStopIdx(stops, step.fromStationCode);
      const destIdx = findStopIdx(stops, step.stationCode);
      // 本程已记的途经站数：最后一次 board 之后的 station_arrive 数量
      const lastBoardSeq = [...data.events].reverse().find((e) => e.event_type === "board")?.seq ?? -1;
      const passed = data.events.filter(
        (e) => e.event_type === "station_arrive" && (e.seq ?? 0) > lastBoardSeq,
      ).length;
      if (boardIdx >= 0 && destIdx >= 0) {
        const n = stops.length;
        const cur = (boardIdx + passed) % n; // 当前逻辑位置（循环线自动 wrap）
        const nextIdx = (cur + 1) % n;
        const remaining = (destIdx - cur + n) % n;
        // 接下来最多 4 站（含目标站高亮）
        const upcomingCount = Math.min(remaining > 0 ? remaining : 4, 4);
        const upcoming: { name: string; isDest: boolean }[] = [];
        for (let k = 1; k <= upcomingCount; k++) {
          const s = stops[(cur + k) % n];
          upcoming.push({ name: s.name, isDest: (cur + k) % n === destIdx });
        }
        rideInfo = {
          routeCode,
          nextName: stops[nextIdx].name,
          nextCode: stops[nextIdx].code,
          remaining,
          upcoming,
        };
      }
    }
  }

  const recentEvents = [...data.events].reverse().slice(0, 4);

  return (
    <main className="page">
      <header style={{ marginBottom: 12 }}>
        <p style={{ fontSize: 14, color: "var(--muted)" }}>{data.session.summary}</p>
        <p style={{ fontSize: 13, color: "var(--muted)" }}>
          第 {Math.min(idx + 1, steps.length)} / {steps.length} 步
          {data.session.missed_count > 0 && (
            <span style={{ color: "var(--danger)" }}> · 没挤上 ×{data.session.missed_count}</span>
          )}
        </p>
      </header>

      {finished ? (
        <p style={{ color: "var(--muted)", margin: "auto 0" }}>已完成，正在进入结束页…</p>
      ) : (
        <div style={{ marginTop: "auto", marginBottom: "auto" }}>
          {/* 实时车距：出门/等车阶段（巴士段才显示，轻轨无实时数据） */}
          {(departing || waiting) &&
            step.quickKind === "stops" &&
            (step.routeOptions?.length ?? 0) > 0 &&
            step.stationCode && (
              <LiveEta
                station={step.stationCode}
                routes={step.routeOptions!}
                dir={data.session.dsat_dir ?? "0"}
              />
            )}

          {/* 车距快捷条：出门/走路阶段记初估，等车阶段记实测 */}
          {showQuick && (
            <div style={{ marginBottom: 16 }}>
              <p style={{ fontSize: 14, color: "var(--muted)", marginBottom: 8 }}>
                {departing
                  ? step.quickKind === "minutes"
                    ? "出门看一眼：轻轨还有几分钟？"
                    : "出门看一眼：车还有几站？"
                  : step.quickKind === "minutes"
                    ? "轻轨还有几分钟？"
                    : "车还有几站？"}
              </p>
              <div style={{ display: "flex", gap: 5, flexWrap: "wrap" }}>
                {QUICK_VALUES.map((v) => (
                  <button
                    key={v}
                    onClick={() => postEvent("wait_snapshot", { value: v, value_kind: step.quickKind })}
                    disabled={posting}
                    style={{
                      width: "auto",
                      flex: "1 1 calc(25% - 5px)",
                      maxWidth: 72,
                      padding: "12px 0",
                      background: "var(--card)",
                      fontSize: 17,
                    }}
                  >
                    {v}
                  </button>
                ))}
              </div>
              {data.snapshots.length > 0 && (
                <p style={{ fontSize: 13, color: "var(--muted)", marginTop: 6 }}>
                  已记 {data.snapshots.length} 次，最近：
                  {data.snapshots[data.snapshots.length - 1].value}
                  {step.quickKind === "minutes" ? " 分钟" : " 站"}
                </p>
              )}
            </div>
          )}

          {/* 主按钮 */}
          {step.sub && <p style={{ fontSize: 15, marginBottom: 10 }}>{step.sub}</p>}
          <button
            onClick={() => postEvent(step.eventType, { station_code: step.stationCode ?? null })}
            disabled={posting}
            style={{ fontSize: 22, padding: "22px 20px" }}
          >
            {posting ? "记录中…" : step.label}
          </button>

          {/* 等车阶段：没挤上 */}
          {waiting && (
            <button
              onClick={() => postEvent("missed")}
              disabled={posting}
              style={{ background: "transparent", color: "var(--danger)", marginTop: 10, fontSize: 15 }}
            >
              没挤上车（继续等下一趟）
            </button>
          )}

          {/* 乘车阶段：下一站提示 + 途经站打点 */}
          {riding && (
            <div style={{ marginBottom: 14 }}>
              {rideInfo ? (
                <>
                  <p style={{ fontSize: 13, color: "var(--muted)", marginBottom: 4 }}>
                    乘车中 · {rideInfo.routeCode} 路
                    {rideInfo.remaining !== null &&
                      (rideInfo.remaining > 0
                        ? ` · 还剩 ${rideInfo.remaining} 站下车`
                        : " · 本站下车")}
                  </p>
                  <p style={{ fontSize: 24, fontWeight: 700, marginBottom: 10 }}>
                    下一站：{rideInfo.nextName}
                  </p>
                  {rideInfo.upcoming.length > 1 && (
                    <p style={{ fontSize: 13, color: "var(--muted)", marginBottom: 10, lineHeight: 1.8 }}>
                      之后：
                      {rideInfo.upcoming.slice(1).map((u, i) => (
                        <span key={i} style={u.isDest ? { color: "var(--accent)" } : undefined}>
                          {u.name}
                          {i < rideInfo.upcoming.length - 2 ? " → " : ""}
                        </span>
                      ))}
                    </p>
                  )}
                </>
              ) : (
                <p style={{ fontSize: 14, color: "var(--muted)", marginBottom: 10 }}>
                  {step.sub}
                </p>
              )}
              <button
                onClick={() =>
                  postEvent("station_arrive", {
                    station_code: rideInfo?.nextCode ?? step.stationCode ?? null,
                  })
                }
                disabled={posting}
                style={{ background: "var(--card)", color: "var(--muted)", marginTop: 4, fontSize: 15 }}
              >
                ✓ 到站了，记一站
              </button>
            </div>
          )}
        </div>
      )}

      {/* 最近事件，校验有没有按错 */}
      <footer style={{ marginTop: "auto" }}>
        {recentEvents.map((e) => (
          <p key={e.id} style={{ fontSize: 13, color: "var(--muted)", lineHeight: 1.7 }}>
            {new Date(e.recorded_at).toLocaleTimeString("zh-CN", { timeZone: "Asia/Macau" })}{" "}
            {EVENT_LABELS[e.event_type] ?? e.event_type}
            {e.station_code ? `（${stationName(e.station_code)}）` : ""}
          </p>
        ))}
      </footer>
    </main>
  );
}
