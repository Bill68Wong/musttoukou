"use client";

/**
 * 座区选择（src/components/ZonePicker.tsx，v1.0.6）
 *
 * 澳科大按教学楼分三个座区（B/C、N/O、R）—— 下车后走到哪一座，步行时间完全不同，
 * 所以座区是**门到门时长的必要输入**，不是可选装饰。
 *
 * ★ v1.0.6：说明文字去掉「到達」二字。座区对**两个方向都生效**：
 *   去学校 → 影响「下车后走到校舍」；从学校出发 → 影响「从校舍走到上车站」。
 *   旧文案只写「到達澳科大哪一座？」，字面像只管去程，容易让人以为回程没用上座区。
 *
 * 设计：座区选择**只在首页**（v1.0.0 起），`/recommend` 只读 `?zone=` ——
 *   避免用户在两处看到同一个选择器，也不会在结果页切换时产生「结果与所选不一致」的困惑。
 *
 * 状态存 `localStorage`（`must.zone`）：主人每天走同一座，不该每次重选。
 * ⚠️ SSR 首帧恒为 `DEFAULT_ZONE`（服务端读不到 localStorage）→ 挂载后再校正，避免 hydration mismatch。
 */
import { useEffect, useState } from "react";
import { DEFAULT_ZONE, SCHOOL_ZONES, type SchoolZone } from "@/lib/recommend/types";

const KEY = "must.zone";

function isZone(v: string | null): v is SchoolZone {
  return v === "B/C" || v === "N/O" || v === "R";
}

/** 读持久化的座区（服务端 / 隐私模式 → 默认 N/O） */
export function readZone(): SchoolZone {
  if (typeof window === "undefined") return DEFAULT_ZONE;
  try {
    const v = window.localStorage.getItem(KEY);
    return isZone(v) ? v : DEFAULT_ZONE;
  } catch {
    return DEFAULT_ZONE;
  }
}

/** 组件内使用：挂载后取值（首帧 = 默认座区） */
export function useZone(): [SchoolZone, (z: SchoolZone) => void] {
  const [zone, setZone] = useState<SchoolZone>(DEFAULT_ZONE);
  useEffect(() => {
    setZone(readZone());
  }, []);
  const update = (z: SchoolZone) => {
    setZone(z);
    try {
      window.localStorage.setItem(KEY, z);
    } catch {
      /* 隐私模式：仅本次会话内生效 */
    }
  };
  return [zone, update];
}

export default function ZonePicker({
  value,
  onChange,
  hint,
}: {
  value: SchoolZone;
  onChange: (z: SchoolZone) => void;
  /** 可选说明（首页用） */
  hint?: string;
}) {
  return (
    <div className="zone-picker">
      <p className="t-label t-muted" style={{ marginBottom: 6 }}>
        {hint ?? "你在澳科大哪一座？（去程影响下车后步行、回程影响出门到站步行）"}
      </p>
      <div className="chip-row">
        {SCHOOL_ZONES.map((z) => (
          <button
            key={z.value}
            className={`chip${value === z.value ? " chip--on" : ""}`}
            onClick={() => onChange(z.value)}
            aria-pressed={value === z.value}
          >
            {z.label}
          </button>
        ))}
      </div>
    </div>
  );
}
