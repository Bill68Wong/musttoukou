"use client";

/**
 * 行程进度条（src/components/JourneyProgress.tsx，v0.12.2）
 * 替代原「主题色横条 phase-band」：顶部横条按项目等分（每项目等宽），
 * 随行程打点推进填充；各段按载具主题色着色，载具切换处做颜色渐变。
 *
 * 渲染技巧：
 *  - 轨道 .jp 固定灰底；填充条宽度 = 已推进比例
 *  - 渐变按「整条轨道宽度」构造并写入 backgroundImage，
 *    再用 backgroundSize = 100/宽度比例(%) 放大回整轨宽度，
 *    保证填充条变宽时已填部分颜色不缩放漂移（left 对齐）
 */

export interface ProgressUnitInput {
  kind: "walk" | "ride";
  color: string;
  group: number;
}

export default function JourneyProgress({
  units,
  filled,
}: {
  units: ProgressUnitInput[];
  filled: number;
}) {
  const total = units.length;
  if (total <= 0) return null;

  const pct = Math.max(0, Math.min(100, (filled / total) * 100));
  const step = 100 / total;

  // 等分渐变：每单位占 step%；组末位单位向下一组主题色渐变（需求 6「颜色渐变」）
  // 例：单位 i 从 c_i 起步，到边界处已是 c_{i+1}（同组则同色=纯色段）
  const stops: string[] = [];
  for (let i = 0; i < total; i++) {
    const c = units[i].color;
    const nextC = i < total - 1 && units[i + 1].group === units[i].group ? c : i < total - 1 ? units[i + 1].color : c;
    stops.push(`${c} ${i * step}%`, `${nextC} ${(i + 1) * step}%`);
  }
  const gradient = `linear-gradient(90deg, ${stops.join(", ")})`;
  // backgroundSize 放大回整轨宽度（left 对齐），宽度变化时颜色位置稳定
  const bgSize = `${(100 / Math.max(pct, 1)) * 100}% 100%`;

  return (
    <div
      className="jp"
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={total}
      aria-valuenow={Math.round(filled)}
      aria-label="行程进度"
    >
      {pct > 0 && (
        <div
          className="jp-fill"
          style={{ width: `${pct}%`, backgroundImage: gradient, backgroundSize: bgSize }}
        />
      )}
    </div>
  );
}
