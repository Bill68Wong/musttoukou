"use client";

/**
 * 轻量同意说明（src/components/nav/ConsentNotice.tsx，v1.3.0 · T05）
 *
 * 产品口径（R5 / Q11）：**只要「轻量同意」**，**不要完整 ConsentGate**（不挡功能）。
 *   · 文案（**简体**）：「本功能需使用您的位置（仅用于计算路线，不上传、不保存）」+「同意」；
 *   · 点「同意」后写 `localStorage` 标记，下次不再显示；
 *   · **不影响**搜索/出卡：不点也能用（只是每次进首页会看到这一条）。
 */
import { useEffect, useState } from "react";

const KEY = "mx_nav_consent_v1";

export default function ConsentNotice() {
  const [show, setShow] = useState(false);

  useEffect(() => {
    try {
      if (!localStorage.getItem(KEY)) setShow(true);
    } catch {
      /* localStorage 不可用（隐私模式）→ 不显示，不阻塞 */
    }
  }, []);

  if (!show) return null;

  return (
    <div className="card nav-consent" role="note">
      <p className="t-label nav-consent__text">
        本功能需要使用您的位置，<b>仅用于计算路线</b>，不上传、不保存。
      </p>
      <button
        className="btn btn--tonal btn--sm"
        type="button"
        onClick={() => {
          try {
            localStorage.setItem(KEY, "1");
          } catch {
            /* ignore */
          }
          setShow(false);
        }}
      >
        同意
      </button>
    </div>
  );
}
