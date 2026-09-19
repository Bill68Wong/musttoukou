"use client";

/**
 * 导航地图（src/components/nav/NavMap.tsx，v1.3.0 · T04）
 *
 * ── 职责（设计 §2.D / §11.1）──────────────────────────────────────────
 *   · 高德 JS API 2.0 底图（`amap-loader`，懒加载，`ssr:false` 由调用方保证）；
 *   · **默认视角**：定位「我的位置」+ ★【6】**横向 5km**（`zoomForAcross`，随容器宽/纬度实时算）；
 *     **定位失败 → 全澳门视角** 中心 `113.558,22.155` · 同样横向 5km + 顶部提示「无法定位 · 请手动选择出发点」；
 *   · 标记：用户位置蓝点 + 目的地图标；
 *   · ★ **巴士站点图层（v2.1.0）**：地图就绪后一次性拉 `/api/stations` 并缓存（ref），
 *     仅在 `zoom >= STATION_MIN_ZOOM` 时渲染**屏幕内**站点（`getBounds()` 裁剪），
 *     拉远即清空；监听 `zoomend`/`moveend`（~150ms throttle），移动/缩放过程**零请求** ⇒ 不卡。
 *     点击站点 → `onStationClick`（信息卡）。移除点务必 `map.remove()` 清理，防泄漏。
 *   · ★ **地图失败不阻塞**：JS 加载失败/缺 Key/初始化异常 → 显示静态占位 + 「重试」，
 *     **搜索/出卡/详情完全不受影响**（产品已拍，§Q7）。
 *
 * ⚠️ 坐标：`Geolocation({ convert:true })` 的 `position` **已是 GCJ-02，不再转换**。
 * ⚠️ 文案：界面文案一律**简体**（站名/线路名才用繁体）。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { loadAMap } from "./amap-loader";

/* eslint-disable @typescript-eslint/no-explicit-any */
const MACAU_CENTER = { lng: 113.558, lat: 22.155 }; // 全澳门视角中心（§D.1）
/** 初始 zoom（地图创建占位用，随后立刻按「横向 5km」重算，见 `zoomForAcross`） */
const INIT_ZOOM = 13.5;
/**
 * ★ 【6】手机屏幕上**横向显示 5km** 的默认视野。
 *
 * 依据（标准 Web Mercator / 高德 256px 瓦片）：
 *   `米/像素(z, φ) = 156543.03392 · cos(φ) / 2^z`
 *   要在一屏宽 `W` 像素里横向放下 `D` 米 ⇒ `米/像素 = D / W`
 *   ⇒ 解出 `z = log2( 156543.03392 · cos(φ) · W / D )`
 *
 * 【实测代入】澳门纬度 φ≈22.15°（cos=0.9261）、手机宽 W=390px、D=5000m：
 *   z = log2(156543.03392 · 0.9261 · 390 / 5000) = log2(11309) ≈ 13.46
 *   （验算：z=17 时米/像素=1.106 → 390px≈431m ≈ 旧「500m 视野」，口径一致 ✓）
 * ⇒ 取 z≈13.46（随容器宽度实时计算，兼容手机/桌面）。旧值 17（≈500m）视野过小。
 */
const TARGET_METERS_ACROSS = 5000;

/**
 * ★ 站点图层显示阈值：`zoom < STATION_MIN_ZOOM` 时不显示任何站点（拉远即清空）。
 * 放显眼位置便于调试。16 时米/像素≈2.2（澳门纬度），一屏可见几十个站点 ⇒ 简洁不卡。
 */
const STATION_MIN_ZOOM = 16;
/** 视图事件节流（毫秒）：`zoomend`/`moveend` 高频触发，节流后再裁剪/渲染 */
const STATION_REFRESH_THROTTLE_MS = 150;

/** `/api/stations` 一条站点（坐标 **GCJ-02**，服务端已转好） */
export interface StationPointLite {
  code: string;
  name: string;
  lng: number;
  lat: number;
}

/** 让「一屏宽」横向放下 `TARGET_METERS_ACROSS` 米的 zoom（按纬度与容器像素宽实时算） */
function zoomForAcross(lat: number, widthPx: number): number {
  const w = widthPx > 0 ? widthPx : 390;
  const mpp = TARGET_METERS_ACROSS / w;
  const z = Math.log2((156543.03392 * Math.cos((lat * Math.PI) / 180)) / mpp);
  // 高德 zoom 支持小数；夹到合法区间防止极端容器宽度算出离谱值
  return Math.max(3, Math.min(19, Math.round(z * 100) / 100));
}

export interface NavMapProps {
  /** Web 端（JS API）Key（服务端以 prop 传入） */
  jsKey: string;
  /** 目的地图标（用户选定 POI 后） */
  dest?: { lng: number; lat: number; label: string } | null;
  /** 定位回调：成功给 GCJ-02 坐标；失败给 null */
  onLocate?: (pos: { lng: number; lat: number } | null) => void;
  /** ★ v2.1.0：点击巴士站点回调（信息卡）——坐标 GCJ-02 */
  onStationClick?: (s: StationPointLite) => void;
  /** 顶部说明（如「无法定位 · 请手动选择出发点」） */
  className?: string;
}

export default function NavMap({ jsKey, dest, onLocate, onStationClick, className = "" }: NavMapProps) {
  const canvasRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<any>(null);
  const userMarkerRef = useRef<any>(null);
  const destMarkerRef = useRef<any>(null);
  const locatedRef = useRef(false);
  /** ★ v2.1.0：全量站点（一次拉取，ref 缓存）与已渲染标记（code → marker） */
  const stationsRef = useRef<StationPointLite[] | null>(null);
  const stationMarkersRef = useRef<Map<string, any>>(new Map());
  /** 点击回调放进 ref：避免 prop 变化导致图层重新绑定事件 */
  const onStationClickRef = useRef<NavMapProps["onStationClick"]>(undefined);

  const [phase, setPhase] = useState<"loading" | "ready" | "failed">("loading");
  const [note, setNote] = useState<string>("");
  const [locating, setLocating] = useState(false);

  const init = useCallback(async () => {
    setPhase("loading");
    setNote("");
    try {
      if (!jsKey) throw new Error("缺少 AMAP_JS_KEY");
      const AMap = await loadAMap(jsKey, ["AMap.Geolocation"]);
      if (!canvasRef.current) return;
      // 先建图（放澳门中心，避免白屏）——定位成功再居中。
      const map = new AMap.Map(canvasRef.current, {
        zoom: INIT_ZOOM,
        center: [MACAU_CENTER.lng, MACAU_CENTER.lat],
        viewMode: "2D",
        resizeEnable: true,
      });
      mapRef.current = map;
      setPhase("ready");

      // ★ 【6】建图后立刻按「横向 5km」重设视角（容器像素宽此时才可测）
      const widthPx: number = map.getSize?.()?.width ?? (typeof window !== "undefined" ? window.innerWidth : 390);
      const failZoom = zoomForAcross(MACAU_CENTER.lat, widthPx);
      map.setZoomAndCenter(failZoom, [MACAU_CENTER.lng, MACAU_CENTER.lat]);
      // 便于自动化验收读取实际生效的 zoom（无副作用的最小测试钩子）
      canvasRef.current?.setAttribute("data-nav-zoom", String(failZoom));

      // ── 定位（R5：成功后 setCenter 到定位点；★【6】视野 = 横向 5km）──
      const geo = new AMap.Geolocation({ enableHighAccuracy: true, timeout: 10_000, convert: true });
      setLocating(true);
      geo.getCurrentPosition((status: string, result: any) => {
        setLocating(false);
        if (status === "complete" && result?.position) {
          // ★ position 已是 GCJ-02（convert:true）→ 不再转换
          const pos = { lng: result.position.lng, lat: result.position.lat };
          locatedRef.current = true;
          const w2: number = mapRef.current?.getSize?.()?.width ?? widthPx;
          const okZoom = zoomForAcross(pos.lat, w2);
          if (mapRef.current) mapRef.current.setZoomAndCenter(okZoom, [pos.lng, pos.lat]);
          canvasRef.current?.setAttribute("data-nav-zoom", String(okZoom));
          if (userMarkerRef.current) userMarkerRef.current.setPosition([pos.lng, pos.lat]);
          else
            userMarkerRef.current = new AMap.Marker({
              position: [pos.lng, pos.lat],
              content: '<div class="nav-map__mepin" aria-label="我的位置"></div>',
              offset: new AMap.Pixel(-9, -9),
            });
          if (mapRef.current && userMarkerRef.current) mapRef.current.add(userMarkerRef.current);
          onLocate?.(pos);
        } else {
          // ★ 定位失败 → 全澳门视角（横向 5km）+ 提示（§D.1）
          if (mapRef.current) mapRef.current.setZoomAndCenter(failZoom, [MACAU_CENTER.lng, MACAU_CENTER.lat]);
          setNote("无法定位 · 请手动选择出发点");
          onLocate?.(null);
        }
      });
    } catch (e) {
      setPhase("failed");
      setNote((e as Error)?.message ?? "地图加载失败");
      onLocate?.(null);
    }
  }, [jsKey, onLocate]);

  useEffect(() => {
    void init();
    return () => {
      try {
        mapRef.current?.destroy?.();
      } catch {
        /* ignore */
      }
      mapRef.current = null;
      userMarkerRef.current = null;
      destMarkerRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jsKey]);

  // ── 目的地标记（异步，不阻塞）──
  useEffect(() => {
    const AMap = typeof window !== "undefined" ? window.AMap : undefined;
    const map = mapRef.current;
    if (!map || !AMap || phase !== "ready") return;
    try {
      if (!dest) {
        if (destMarkerRef.current) {
          map.remove(destMarkerRef.current);
          destMarkerRef.current = null;
        }
        return;
      }
      const pos = [dest.lng, dest.lat];
      if (destMarkerRef.current) destMarkerRef.current.setPosition(pos);
      else {
        destMarkerRef.current = new AMap.Marker({
          position: pos,
          content: '<div class="nav-map__destpin" aria-hidden="true"></div>',
          offset: new AMap.Pixel(-10, -20),
          title: dest.label,
        });
        map.add(destMarkerRef.current);
      }
    } catch {
      /* 标记失败不影响底图 */
    }
  }, [dest, phase]);

  // ★ v2.1.0：同步点击回调到 ref（避免回调变化导致图层重建）
  useEffect(() => {
    onStationClickRef.current = onStationClick;
  }, [onStationClick]);

  // ── ★ v2.1.0：巴士站点图层（仅阈值内、仅视野内）──
  useEffect(() => {
    if (phase !== "ready") return;
    const AMap = typeof window !== "undefined" ? window.AMap : undefined;
    const map = mapRef.current;
    if (!map || !AMap) return;

    let timer: ReturnType<typeof setTimeout> | null = null;
    let cancelled = false;
    const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");

    const clearAll = () => {
      for (const [, mk] of stationMarkersRef.current) {
        try {
          map.remove(mk);
        } catch {
          /* ignore */
        }
      }
      stationMarkersRef.current.clear();
    };

    const render = () => {
      if (cancelled) return;
      try {
        const zoom = typeof map.getZoom === "function" ? map.getZoom() : 0;
        // ★ 无副作用观测钩子（同 `data-nav-zoom` 传统）：自动化验收读取实际生效的 zoom
        canvasRef.current?.setAttribute("data-nav-z", String(zoom));
        if (zoom < STATION_MIN_ZOOM) {
          clearAll(); // 拉远：清空（产品口径）
          return;
        }
        const data = stationsRef.current;
        if (!data) return;
        const bounds = typeof map.getBounds === "function" ? map.getBounds() : null;
        if (!bounds) return;
        const sw = bounds.getSouthWest();
        const ne = bounds.getNorthEast();
        const visible = new Set<string>();
        for (const s of data) {
          if (s.lat < sw.lat || s.lat > ne.lat || s.lng < sw.lng || s.lng > ne.lng) continue;
          visible.add(s.code);
          if (stationMarkersRef.current.has(s.code)) continue;
          const marker = new AMap.Marker({
            position: [s.lng, s.lat],
            content: `<div class="nav-map__station" data-code="${esc(s.code)}" title="${esc(s.name)}"></div>`,
            offset: new AMap.Pixel(-6, -6),
            zIndex: 90,
          });
          marker.on("click", () => onStationClickRef.current?.(s));
          map.add(marker);
          stationMarkersRef.current.set(s.code, marker);
        }
        // 移出视野的点：逐个 remove 清理（防泄漏）
        for (const [code, mk] of [...stationMarkersRef.current]) {
          if (visible.has(code)) continue;
          try {
            map.remove(mk);
          } catch {
            /* ignore */
          }
          stationMarkersRef.current.delete(code);
        }
      } catch {
        /* 图层失败不影响底图 */
      } finally {
        // ★ 无副作用观测钩子：无论走哪个分支，都回写当前已渲染站点数（拉远/清空后 = 0）
        canvasRef.current?.setAttribute("data-station-count", String(stationMarkersRef.current.size));
      }
    };

    const schedule = () => {
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        render();
      }, STATION_REFRESH_THROTTLE_MS);
    };

    map.on("zoomend", schedule);
    map.on("moveend", schedule);

    // 一次性拉全量站点（ref 缓存；失败静默，不影响其他功能）
    if (!stationsRef.current) {
      fetch("/api/stations", { cache: "force-cache" })
        .then((r) => r.json())
        .then((j: { stations?: StationPointLite[] }) => {
          if (cancelled) return;
          stationsRef.current = Array.isArray(j.stations) ? j.stations : [];
          render();
        })
        .catch(() => {
          console.warn("[NavMap] 站点列表加载失败（站点图层不可用，不影响其他功能）");
          stationsRef.current = [];
        });
    } else {
      render();
    }

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      try {
        map.off("zoomend", schedule);
        map.off("moveend", schedule);
      } catch {
        /* ignore */
      }
      clearAll();
    };
  }, [phase]);

  return (
    <div className={`nav-map ${className}`}>
      <div ref={canvasRef} className="nav-map__canvas" />
      {phase === "loading" && (
        <div className="nav-map__cover">
          <span className="rc-sk rc-sk--big" />
          <span className="nav-map__cover-text">{locating ? "定位中…" : "地图加载中…"}</span>
        </div>
      )}
      {phase === "failed" && (
        <div className="nav-map__cover nav-map__cover--fail">
          <p className="h-title">地图暂不可用</p>
          <p className="t-label t-muted">搜索与路线结果不受影响</p>
          <button className="btn btn--outline btn--sm" type="button" onClick={() => void init()}>
            重试
          </button>
          {note && <p className="t-label t-muted">{note}</p>}
        </div>
      )}
      {phase === "ready" && note && <div className="nav-map__note t-label">{note}</div>}
    </div>
  );
}
