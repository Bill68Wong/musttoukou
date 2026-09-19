"use client";

/**
 * POI 搜索框（src/components/nav/PoiSearchBox.tsx，v1.3.0 · T04）
 *
 * ── 两段式搜索（设计 §2.A.6 / R5，产品已定）────────────────────────────
 *   · **打字**（防抖 300ms）→ `/api/poi/suggest?mode=type` —— **本地别名库，0 配额**、秒回；
 *   · **回车**             → `/api/poi/suggest?mode=enter` —— 本地优先，本地无坐标命中才调高德。
 *   ⇒ 结果里的站名/线路名是**繁体**（本地命中为繁体原名），高德兜底命中为高德原文。
 *
 * ── 界面约定 ──────────────────────────────────────────────────────────
 *   · 界面文案一律**简体**；来源徽章「来自高德」用简体，站名/线路名保留原文。
 *   · **不记忆**出发点（产品 R5 明确：不用 localStorage）。
 *   · 交互反馈（§11.1/§11.2）：键入即上屏 + focus 描边；防抖后下拉区**行内 loading**；
 *     失败/无匹配给**行内灰字**（不整屏）。
 */
import { useEffect, useRef, useState } from "react";
import RouteStack from "@/components/RouteStack";
import type { NavPoint, PoiSearchResult, PoiSuggestResponse } from "@/lib/nav/types";

export interface PoiSearchBoxProps {
  /** 输入框标签（简体，如「起点」「目的地」） */
  label: string;
  value: NavPoint | null;
  onChange: (p: NavPoint) => void;
  /** 用户当前位置（GCJ-02）——仅用于结果排序 */
  userPos?: { lng: number; lat: number } | null;
  /** 线路码 → 主题色（用于「线路候选」行渲染 `.route-stack`，§11.6） */
  colors?: Record<string, string>;
  placeholder?: string;
  autoFocus?: boolean;
}

const DEBOUNCE_MS = 300;

function toNavPoint(r: PoiSearchResult): NavPoint {
  return {
    kind: r.kind === "station" || r.kind === "lrt_station" ? "station" : r.kind === "place" ? "place" : "poi",
    label: r.name,
    lng: r.lng,
    lat: r.lat,
    code: undefined,
  };
}

export default function PoiSearchBox({
  label,
  value,
  onChange,
  userPos,
  colors,
  placeholder,
  autoFocus,
}: PoiSearchBoxProps) {
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [resp, setResp] = useState<PoiSuggestResponse | null>(null);
  const [err, setErr] = useState<string>("");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const boxRef = useRef<HTMLDivElement | null>(null);

  // 点击外部关闭
  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);

  async function query(keyword: string, mode: "type" | "enter") {
    const s = keyword.trim();
    if (!s) {
      setResp(null);
      setOpen(false);
      return;
    }
    setLoading(true);
    setErr("");
    try {
      const sp = new URLSearchParams({ q: s.slice(0, 50), mode });
      if (userPos) {
        sp.set("lat", String(userPos.lat));
        sp.set("lng", String(userPos.lng));
      }
      const res = await fetch(`/api/poi/suggest?${sp.toString()}`, { cache: "no-store" });
      const json = (await res.json()) as PoiSuggestResponse;
      setResp(json);
      setOpen(true);
    } catch {
      setErr("搜索暂不可用，请稍后再试");
      setOpen(true);
    } finally {
      setLoading(false);
    }
  }

  function onInput(v: string) {
    setQ(v);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void query(v, "type"), DEBOUNCE_MS);
  }

  function pick(r: PoiSearchResult) {
    onChange(toNavPoint(r));
    setQ(r.name);
    setOpen(false);
  }

  // 本地命中但无坐标 → 回车走高德确认坐标
  function pickPending(name: string) {
    setQ(name);
    void query(name, "enter");
  }

  const results = resp?.results ?? [];
  const pending = resp?.pending ?? [];
  const hint = resp?.hintText;

  return (
    <div className="nav-sbox" ref={boxRef}>
      <label className="nav-sbox__label t-label">{label}</label>
      <div className={`nav-sbox__field${open ? " nav-sbox__field--open" : ""}`}>
        <input
          className="inp nav-sbox__inp"
          value={q}
          onChange={(e) => onInput(e.target.value)}
          onFocus={() => q.trim() && setOpen(true)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              if (timer.current) clearTimeout(timer.current);
              void query(q, "enter");
            } else if (e.key === "Escape") {
              setOpen(false);
            }
          }}
          placeholder={placeholder ?? `输入目的地`}
          autoFocus={autoFocus}
          aria-label={label}
          inputMode="search"
        />
        {loading && <span className="nav-sbox__spin" aria-label="搜索中" />}
      </div>

      {open && (
        <div className="nav-sbox__drop">
          {results.map((r, i) => (
            <button key={`${r.name}-${i}`} type="button" className="nav-sbox__row" onClick={() => pick(r)}>
              <span className="nav-sbox__name">{r.name}</span>
              {r.source !== "local" && <span className="nav-sbox__badge">来自高德</span>}
              {(r.district || r.address) && <span className="nav-sbox__meta t-muted">{r.district || r.address}</span>}
              {typeof r.distM === "number" && <span className="nav-sbox__meta t-muted">{r.distM} m</span>}
            </button>
          ))}
          {pending.map((p, i) => (
            <button
              key={`p-${p.name}-${i}`}
              type="button"
              className="nav-sbox__row nav-sbox__row--pending"
              onClick={() => pickPending(p.name)}
              title="按回车用高德确认坐标"
            >
              {/* ★ §11.6：线路候选用主题色标签（单条 → `.route-stack` 也接受单块） */}
              {p.targetKind === "route" ? (
                <RouteStack codes={[p.name]} colorOf={(c) => colors?.[c] ?? null} />
              ) : (
                <span className="nav-sbox__name">{p.name}</span>
              )}
              <span className="nav-sbox__badge nav-sbox__badge--soft">按回车搜索</span>
            </button>
          ))}
          {!loading && !results.length && !pending.length && (
            <p className="nav-sbox__hint t-muted">{hint ?? (err || "找不到这个地点 · 试试换个说法")}</p>
          )}
          {!!results.length && hint && <p className="nav-sbox__hint t-muted">{hint}</p>}
        </div>
      )}
    </div>
  );
}
