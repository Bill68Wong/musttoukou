"use client";

/**
 * 开发者模式门禁（src/components/DevGate.tsx，v1.0.0）
 *
 * 用途：旧的「路线列表 → 点选方案开始计时」页（`/routes`）在 v1.0.0 之后不再是主入口，
 *   只对**打开开发者模式**的人开放 —— 他们才需要按老流程手动挑方案建会话。
 *
 * ⚠️ 状态存在 `localStorage`，**服务端读不到** → 不能在 server 组件里 `redirect()`，
 *    只能在客户端挂载后判定，所以这里必须是个 client 组件。
 * ⚠️ 判定完成前（`state === "loading"`）**不渲染 children**：
 *    否则普通用户会先看到一帧真实内容再被弹走（闪烁 + 白花花一次数据库查询的观感）。
 * ⚠️ children 由 server 渲染后作为 prop 传进来 —— Next App Router 允许 client 组件
 *    包 server children，数据查询仍发生在服务端。
 */
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { readDevMode, subscribeDevMode } from "@/lib/dev-mode";

export default function DevGate({
  children,
  fallbackHref = "/",
}: {
  children: React.ReactNode;
  /** 未开启开发者模式时的去向（默认回首页） */
  fallbackHref?: string;
}) {
  const router = useRouter();
  const [state, setState] = useState<"loading" | "on" | "off">("loading");

  useEffect(() => {
    const apply = (on: boolean) => {
      if (on) {
        setState("on");
      } else {
        setState("off");
        router.replace(fallbackHref);
      }
    };
    apply(readDevMode());
    // 同一标签页里关掉开关也会立即被弹走
    return subscribeDevMode(apply);
  }, [router, fallbackHref]);

  if (state === "loading") {
    return <div className="devgate" aria-busy="true" />;
  }

  if (state === "off") {
    return (
      <div className="devgate">
        <p className="t-label t-muted t-center">
          此页面仅供开发者使用，正在带您回上一页…
        </p>
        <p className="t-center" style={{ marginTop: 10 }}>
          <a className="btn btn--text btn--sm" href={fallbackHref}>
            手動前往
          </a>
        </p>
      </div>
    );
  }

  return <>{children}</>;
}
