/**
 * /recommend 路由级加载骨架（src/app/recommend/loading.tsx，v1.0.0）
 *
 * 与 `page.tsx` 内 Suspense 的 fallback 同一形态 —— 这层负责「路由切换瞬间」的占位
 * （用户从首页点方向卡的第一次反馈），内层负责「数据正在算」的占位。
 * 两层形状一致 → 骨架不跳动。
 */
export default function Loading() {
  return (
    <main className="page">
      <div className="rc-top">
        <span className="btn btn--text btn--sm">← 返回</span>
        <span className="btn btn--text btn--sm">↻ 刷新</span>
      </div>
      <h1 className="h-headline rc-title">正在計算…</h1>
      <p className="t-label t-muted rc-subtitle">分析实时班次与步行时间</p>
      <div className="rc-list">
        {[0, 1, 2, 3, 4].map((i) => (
          <div key={i} className="card rc rc--skeleton" aria-hidden="true">
            <div className="rc-head">
              <span className="rc-sk rc-sk--big" />
              <span className="rc-sk rc-sk--chip" />
            </div>
            <div className="rc-line">
              <span className="rc-sk rc-sk--line" />
              <span className="rc-sk rc-sk--line" />
              <span className="rc-sk rc-sk--line rc-sk--short" />
            </div>
          </div>
        ))}
      </div>
    </main>
  );
}
