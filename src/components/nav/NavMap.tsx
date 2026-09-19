"use client";

/**
 * 导航地图（src/components/nav/NavMap.tsx，v1.3.0 · T04）
 *
 * ── 职责（设计 §2.D / §11.1）──────────────────────────────────────────
 *   · 高德 JS API 2.0 底图（`amap-loader`，懒加载，`ssr:false` 由调用方保证）；
 *   · **默认视角**：定位「我的位置」+ 视野 ~500m（`R5`）；**定位失败 → 全澳门视角**
 *     中心 `113.558,22.155` · zoom≈11 + 顶部提示「无法定位 · 请手动选择出发点」；
 *   · 标记：用户位置蓝点 + 目的地图标；
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
const LOCATE_ZOOM = 17; // ≈500m 视野

export interface NavMapProps {
  /** Web 端（JS API）Key（服务端以 prop 传入） */
  jsKey: string;
  /** 目的地图标（用户选定 POI 后） */
  dest?: { lng: number; lat: number; label: string } | null;
  /** 定位回调：成功给 GCJ-02 坐标；失败给 null */
  onLocate?: (pos: { lng: number; lat: number } | null) => void;
  /** 顶部说明（如「无法定位 · 请手动选择出发点」） */
  className?: string;
}

export default function NavMap({ jsKey, dest, onLocate, className = "" }: NavMapProps) {
  const canvasRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<any>(null);
  const userMarkerRef = useRef<any>(null);
  const destMarkerRef = useRef<any>(null);
  const locatedRef = useRef(false);

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
      // 先建图（放澳门中心，避免白屏）——定位成功再居中
      const map = new AMap.Map(canvasRef.current, {
        zoom: 11,
        center: [MACAU_CENTER.lng, MACAU_CENTER.lat],
        viewMode: "2D",
        resizeEnable: true,
      });
      mapRef.current = map;
      setPhase("ready");

      // ── 定位（R5：成功后 setCenter 到定位点，视野 ~500m）──
      const geo = new AMap.Geolocation({ enableHighAccuracy: true, timeout: 10_000, convert: true });
      setLocating(true);
      geo.getCurrentPosition((status: string, result: any) => {
        setLocating(false);
        if (status === "complete" && result?.position) {
          // ★ position 已是 GCJ-02（convert:true）→ 不再转换
          const pos = { lng: result.position.lng, lat: result.position.lat };
          locatedRef.current = true;
          if (mapRef.current) mapRef.current.setZoomAndCenter(LOCATE_ZOOM, [pos.lng, pos.lat]);
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
          // ★ 定位失败 → 全澳门视角 + 提示（§D.1）
          if (mapRef.current) mapRef.current.setZoomAndCenter(11, [MACAU_CENTER.lng, MACAU_CENTER.lat]);
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
