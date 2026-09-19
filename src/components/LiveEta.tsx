"use client";

/**
 * 实时车距卡片（src/components/LiveEta.tsx）
 * 出门/等车阶段显示候选线路最近的車距本站还有几站。
 * 数据链路：/api/dsat/eta → DSAT routestation/bus（5s 服务端缓存，v0.8.1 10s → 5s）。
 *
 * v0.4.0 刷新规则（用户定稿，2026-09-03）：
 *  - ★ 无自动轮询（移除 60s setInterval）
 *  - 手动刷新：最小间隔 10s（本地守卫，不带 force，命中服务端缓存即可）
 *  - 打点（depart/wait_start 等系统时刻）后经 refreshKey 递增 → force=true 直查最新
 *    （v0.8.1 修复竞态：此前 GET 不带 force 会命中打点前旧缓存，与 auto-snapshot 的
 *      force 直查结果不一致导致界面横跳；现打点后两者同刻直查，口径一致）
 *  - 失败静默保留旧数据（不打断计时流程）
 *
 * v0.12.1（2026-09-05）刷新机制修正（用户定稿）：
 *  - 自动刷新仅限关键动作：进入路线页（挂载）/ 出发 / 人到站 / 上车 / 下车
 *    （TimerWizard 收紧 AUTO_REFRESH_TYPES，pause/继续/记站不再触发）
 *  - 10s 冷却对「任何刷新」生效：点击刷新或自动刷新后按钮进入不可点读秒（↻ 9s → 0）
 *  - 自动刷新无视冷却照发（force 直查）；手动点击被冷却禁用（自动刷新 5s 后手动点不动）
 *  - 原「手动刷新 ≥10s 间隔」小字提示删除，改为按钮内读秒
 *
 * v0.12.2（2026-09-05）卡片重构（用户定稿 7 条之二/三/四/五）：
 *  - 线路名并入标题行（「🚌 实时车距 · 26 路」）；卡片单线路（数据收集阶段）
 *  - 最近车站数大字突出显示；「再下一班车」（第二辆在途车）副行小字展示
 *  - 删除「另有 N 辆总站待发」展示（服务端已不再返回）
 *  - 脚注文案：数据来自澳门交通事务局，仅供参考（不再写「DSAT 仅供参考」）
 *
 * v0.8.2/0.8.3（2026-09-04）：同车只降不升平滑（src/lib/eta-smooth.ts，模块级记忆）。
 * v0.8.4 根因已修（eta.ts 站距口径 s0/s1 同值，不再有 2→3），平滑降级为纯防御层，
 * 仅兜底 DSAT 数据自身的偶发回跳（换车/换向/毛刺）。
 */

import RouteStack from "./RouteStack";
import { useCallback, useEffect, useRef, useState } from "react";
import { smoothStopsAway, getSmoothMem } from "@/lib/eta-smooth";

interface EtaNearest {
  plate: string | null;
  stopsAway: number; // 0 = 已到站
  atStation: string;
  atStationName: string;
  status: string | null; // '1' 停靠挂载站 / '0' 已离挂载站驶向下一站（v0.8.4 口径）
  speed: string | number | null;
}

interface EtaResult {
  route: string;
  ok: boolean;
  isLoop?: boolean;
  nearest?: EtaNearest;
  /** v0.12.2：再下一班在途车（第二近；副行小字展示，站数不突出） */
  second?: EtaNearest;
  busCount?: number;
  /** v0.13.x：等车站 = 本方向首站（总站/起点）——无车时显示「暂未发车」 */
  headTerminal?: boolean;
  error?: string;
}

interface EtaData {
  fetchedAt: string;
  results: EtaResult[];
}

/** 手动刷新最小间隔（毫秒） */
const MANUAL_MIN_MS = 10_000;

export default function LiveEta({
  station,
  routes,
  dir,
  dest,
  refreshKey = 0,
  routeColors,
  stationByRoute,
}: {
  station: string;
  routes: string[];
  dir: string;
  dest?: string | null;
  /** v0.20.1：全量线路色表（线路名标签取色） */
  routeColors?: Record<string, string>;
  /** v0.20.9：各线路各自的查询站台（合并卡：51→M9/4、59→M9/2 …） */
  stationByRoute?: Record<string, string>;
  /** 打点成功后父组件递增 → 立即刷新（系统时刻，不受 10s 手动下限约束） */
  refreshKey?: number;
}) {
  const [data, setData] = useState<EtaData | null>(null);
  const [loading, setLoading] = useState(false);
  /** v0.12.1：刷新冷却剩余秒数（0=可点）；任何刷新（挂载/自动/手动）都会重置 10s */
  const [cooldownSec, setCooldownSec] = useState(0);
  const reqId = useRef(0);
  const cooldownUntil = useRef(0);
  /**
   * 同车单调记忆（v0.8.2 修复 C 抖动 2→3→1）——必须模块级单例：
   * TimerWizard 步骤容器 <div key={idx}> 每次打点推进都会卸载重建 LiveEta，
   * useRef 会随之清零导致平滑失效；getSmoothMem() 跨 remount 存活。
   */
  const prevByBus = useRef(getSmoothMem());
  const routesKey = routes.join(",");

  // v0.12.1：冷却 10s（手动点击与自动刷新共用；自动 force 不受限，仅禁手动按钮）
  const startCooldown = useCallback(() => {
    cooldownUntil.current = Date.now() + MANUAL_MIN_MS;
    setCooldownSec(Math.ceil(MANUAL_MIN_MS / 1000));
  }, []);
  // 冷却期每秒读秒递减（结束归 0 恢复可点）
  useEffect(() => {
    if (cooldownSec <= 0) return;
    const id = setInterval(() => {
      const left = Math.ceil((cooldownUntil.current - Date.now()) / 1000);
      if (left <= 0) setCooldownSec(0);
      else setCooldownSec(left);
    }, 500);
    return () => clearInterval(id);
  }, [cooldownSec]);

  const fetchEta = useCallback(
    async (force = false) => {
      const id = ++reqId.current;
      setLoading(true);
      startCooldown(); // v0.12.1：任何刷新都启动/重置 10s 冷却（按钮进入读秒）
      try {
        // v0.20.9：各线站台不同时把 smap 带上（route:station）
        const smap = stationByRoute
          ? routes
              .filter((r) => stationByRoute![r] && stationByRoute![r] !== station)
              .map((r) => `${r}:${stationByRoute![r]}`)
              .join(",")
          : "";
        const qs = new URLSearchParams({
          station,
          routes: routesKey,
          dir,
          ...(dest ? { dest } : {}),
          ...(force ? { force: "1" } : {}),
          ...(smap ? { smap } : {}),
        });
        const res = await fetch(`/api/dsat/eta?${qs.toString()}`, { cache: "no-store" });
        if (!res.ok) return;
        const body = (await res.json()) as EtaData;
        if (id === reqId.current) {
          // v0.8.2：同车只降不升（记忆含等车站，跨步骤 remount 存活），消除 2→3→1 假倒退
          smoothStopsAway(prevByBus.current, body.results, station);
          setData(body);
        }
      } catch {
        // 静默失败，保留旧数据
      } finally {
        if (id === reqId.current) setLoading(false);
      }
    },
    // stationByRoute / routes 由 routesKey 派生（routesKey 已在依赖中）；直接把对象入依赖
    // 会因每渲染新建导致回调反复重建 → 挂载 effect 重复拉取 ETA。故此处有意省略。
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [station, routesKey, dir, dest, startCooldown],
  );

  // 挂载时取一次
  useEffect(() => {
    fetchEta();
  }, [fetchEta]);

  // 系统打点（refreshKey 递增）→ 事件驱动 force 直查最新；跳过首帧 0
  // v0.8.1：带 force=true，与 auto-snapshot 打点直查同刻一致，避免命中打点前旧缓存横跳
  const prevKey = useRef(refreshKey);
  useEffect(() => {
    if (refreshKey !== prevKey.current && refreshKey > 0) {
      prevKey.current = refreshKey;
      fetchEta(true);
    }
  }, [refreshKey, fetchEta]);

  // 手动刷新：冷却中按钮 disabled（读秒），此处仅兜底；点击后由 fetchEta 启动新 10s 冷却
  const manualRefresh = () => {
    if (Date.now() < cooldownUntil.current) return;
    fetchEta();
  };

  // v0.20.1：标题里的线路名改为彩色标签
  const titleRouteCodes =
    routes.length === 1
      ? routes
      : data?.results.length === 1 && data.results[0].ok
        ? [data.results[0].route]
        : [];

  const fmtTime = (iso: string) =>
    new Date(iso).toLocaleTimeString("zh-CN", {
      timeZone: "Asia/Macau",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });

  return (
    <div className="card anim-fade-up" style={{ padding: "12px 14px" }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: 8,
        }}
      >
        <p
          className="h-title"
          style={{
            minWidth: 0,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          🚌 实时车距
          {titleRouteCodes.length > 0 && (
            <>
              {" "}
              <RouteStack codes={titleRouteCodes} colorOf={(c) => routeColors?.[c]} size="sm" />
            </>
          )}
        </p>
        <button
          className="btn btn--text btn--sm"
          onClick={manualRefresh}
          disabled={loading || cooldownSec > 0}
          aria-label="刷新车距"
        >
          <span className={loading ? "anim-spin" : ""} style={{ display: "inline-block" }}>
            ↻
          </span>{" "}
          {/* v0.12.1：冷却期按钮不可点并读秒（点击刷新或自动刷新后都会进入 10s 冷却） */}
          {loading ? "刷新中…" : cooldownSec > 0 ? `${cooldownSec}s` : "刷新"}
        </button>
      </div>

      {!data ? (
        <p className="t-body t-muted">获取中…</p>
      ) : (
        data.results.map((r) => {
          if (!r.ok) {
            return (
              <p key={r.route} className="t-body t-muted" style={{ lineHeight: 1.7 }}>
                <RouteStack codes={[r.route]} colorOf={(c) => routeColors?.[c]} size="sm" />{" "}
                {r.error ?? "暂无数据"}
              </p>
            );
          }
          // v0.12.2：单线路卡片（线路名已并入标题）；多线路兜底时每线一个独立小节
          const blockHead =
            data.results.length > 1 ? (
              <p className="t-label t-strong" style={{ margin: "2px 0 0" }}>
                <RouteStack codes={[r.route]} colorOf={(c) => routeColors?.[c]} size="sm" />
              </p>
            ) : null;
          if (!r.nearest) {
            // v0.12.2：总站待发不再单列展示；仅区分「有在线车辆但都不在途」/「无线车辆」
            // v0.13.x：等车站=首站总站时，回站段/已开出的车一律不计（总站无待发车 = 暂未发车）
            return (
              <div key={r.route}>
                {blockHead}
                <p className="t-body t-muted" style={{ lineHeight: 1.7 }}>
                  {r.headTerminal
                    ? (r.busCount ?? 0) > 0
                      ? "暂未发车 · 总站暂无待发车"
                      : "暂未发车"
                    : (r.busCount ?? 0) > 0
                      ? "暂无车辆在途"
                      : "暂无在线车辆"}
                </p>
              </div>
            );
          }
          const n = r.nearest.stopsAway;
          // 报站档位（v0.8.4 口径修正，2026-09-04）：
          //   s1 挂用户站 → 0 = 已进站（车停靠中）
          //   s0 挂紧邻前站 → 1 = 即将进站（车已离前站驶来，还有 1 次停靠）
          //   s1 挂前一站 → 还有 1 站（车停着没动）；更远 → 还有 N 站
          const stage =
            n === 0
              ? { text: "已进站！", flash: true }
              : n === 1 && r.nearest.status === "0"
                ? { text: "即将进站", flash: true }
                : { text: `还有 ${n} 站`, flash: false };
          const bus = r.nearest;
          const second = r.second;
          return (
            <div key={r.route} style={{ marginTop: 2 }}>
              {blockHead}
              {/* 需求 3：站数突出显示（最近车大字） */}
              <p
                className={`t-accent eta-big${stage.flash ? " eta-big--flash" : ""}`}
                style={{ textAlign: "center", margin: "4px 0 0" }}
              >
                {stage.text}
              </p>
              <p
                className="t-label t-muted"
                style={{ textAlign: "center", lineHeight: 1.5, marginTop: 2 }}
              >
                {bus.plate ?? ""}
                {bus.atStationName ? ` · 在${bus.atStationName}` : ""}
              </p>
              {/* 需求 4：再下一班车（第二辆在途车）—— 站数不突出显示 */}
              {second && (
                <p
                  className="t-label t-muted"
                  style={{ textAlign: "center", lineHeight: 1.5, marginTop: 4 }}
                >
                  再下一班：还有 {second.stopsAway} 站
                  {second.plate ? ` · ${second.plate}` : ""}
                  {second.atStationName ? ` · 在${second.atStationName}` : ""}
                </p>
              )}
            </div>
          );
        })
      )}

      {data && (
        <p className="t-label t-muted" style={{ marginTop: 8 }}>
          更新于 {fmtTime(data.fetchedAt)} · 数据来自澳门交通事务局，仅供参考
        </p>
      )}
    </div>
  );
}
