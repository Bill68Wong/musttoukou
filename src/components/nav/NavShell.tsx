"use client";

/**
 * 首页导航壳（src/components/nav/NavShell.tsx，v1.3.0 · T04）
 *
 * 组成（设计 §2.E / §11.1）：**地图（上半屏） + 起点/目的地搜索框（下方） + 「出发」**。
 *   · 起点默认 = 「我的位置」（定位失败 → 提示手动选择，§D.1）；
 *   · ★ **不记忆**出发点（不用 localStorage，产品 R5）；
 *   · 「出发」→ 组 `/nav` URL（★ 坐标 **GCJ-02**；T03 的 `/api/nav` 契约）。
 *   · 地图失败**不阻塞**：搜索与出发照常（§Q7）。
 */
import { useCallback, useState } from "react";
import { useRouter } from "next/navigation";
import ConsentNotice from "./ConsentNotice";
import PoiSearchBox from "./PoiSearchBox";
import NavMap from "./NavMap";
import StationCard, { type StationCardStation } from "./StationCard";
import type { NavPoint } from "@/lib/nav/types";

const MY_LOCATION = "我的位置";

/** ★ v2.1.0：站点 → NavPoint（`kind='station'`，label 带站码，与 POI 搜索框口径一致） */
function stationToNavPoint(s: StationCardStation): NavPoint {
  return { kind: "station", label: `${s.code} ${s.name}`.trim(), lng: s.lng, lat: s.lat, code: s.code };
}

function navUrl(from: NavPoint, to: NavPoint): string {
  const sp = new URLSearchParams({
    fromLng: String(from.lng),
    fromLat: String(from.lat),
    toLng: String(to.lng),
    toLat: String(to.lat),
    fromLabel: from.label,
    toLabel: to.label,
    fromKind: from.kind,
    toKind: to.kind,
  });
  if (from.code) sp.set("fromCode", from.code);
  if (to.code) sp.set("toCode", to.code);
  return `/nav?${sp.toString()}`;
}

export default function NavShell({ jsKey, colors = {} }: { jsKey: string; colors?: Record<string, string> }) {
  const router = useRouter();
  /** 定位点（GCJ-02）；null = 尚未定位/定位失败 */
  const [userPos, setUserPos] = useState<{ lng: number; lat: number } | null>(null);
  /** 用户显式选择的起点（未选则以「我的位置」为准） */
  const [from, setFrom] = useState<NavPoint | null>(null);
  const [to, setTo] = useState<NavPoint | null>(null);
  const [picking, setPicking] = useState(false);
  /** ★ v2.1.0：地图上选中的巴士站（信息卡） */
  const [station, setStation] = useState<StationCardStation | null>(null);

  const onLocate = useCallback((pos: { lng: number; lat: number } | null) => setUserPos(pos), []);
  const onStationClick = useCallback((s: StationCardStation) => setStation(s), []);

  // 起点展示值与实际值
  const fromPoint: NavPoint | null =
    from ?? (userPos ? { kind: "gps", label: MY_LOCATION, lng: userPos.lng, lat: userPos.lat } : null);

  const canGo = !!fromPoint && !!to;

  function go() {
    if (!fromPoint || !to) return;
    setPicking(true);
    router.push(navUrl(fromPoint, to));
  }

  return (
    <section className="nav-shell">
      <div className="nav-map-wrap">
        <NavMap
          jsKey={jsKey}
          dest={to ? { lng: to.lng, lat: to.lat, label: to.label } : null}
          onLocate={onLocate}
          onStationClick={onStationClick}
        />
        {station && (
          <StationCard
            station={station}
            colors={colors}
            onClose={() => setStation(null)}
            onSetFrom={() => {
              setFrom(stationToNavPoint(station));
              setStation(null);
            }}
            onSetTo={() => {
              setTo(stationToNavPoint(station));
              setStation(null);
            }}
          />
        )}
      </div>

      <ConsentNotice />

      <div className="nav-shell__panel card">
        <PoiSearchBox
          label="起点"
          value={fromPoint}
          onChange={(p) => setFrom(p)}
          userPos={userPos}
          colors={colors}
          placeholder={userPos ? MY_LOCATION : "输入起点"}
        />
        <PoiSearchBox
          label="目的地"
          value={to}
          onChange={(p) => setTo(p)}
          userPos={userPos}
          colors={colors}
          placeholder="输入目的地"
          autoFocus
        />
        <button
          className="btn btn--primary btn--block btn--lg press-card"
          type="button"
          disabled={!canGo || picking}
          onClick={go}
        >
          {picking ? "正在规划…" : "出发"}
        </button>
        {!fromPoint && <p className="t-label t-muted">无法定位 · 请手动选择出发点</p>}
      </div>
    </section>
  );
}
