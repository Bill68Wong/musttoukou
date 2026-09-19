/**
 * 首末步行短距修正 —— 兼容转发（src/lib/nav/walk-fix.ts）
 *
 * 设计 §3 列出 `src/lib/nav/walk-fix.ts`；任务说明要求落在 `src/lib/amap/walk-fix.ts`
 * （它服务于「高德步行几何」，与 amap 域同源）。这里做**零逻辑转发**以兼容设计路径。
 *
 * ⚠️ 唯一实现见 `src/lib/amap/walk-fix.ts`；改修正规则请改那里。
 */
export * from "@/lib/amap/walk-fix";
