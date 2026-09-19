/**
 * 合规条（src/components/nav/ComplianceBar.tsx，v1.3.0 · T04）
 *
 * 协议 7.7 要求：新导航三页（`/`、`/nav`、`/nav/detail`）均挂一行合规说明 + 指向 `/about`。
 * 语气克制·不含糊·不卖萌（§11.4）；**界面文案用简体**（§6.2 / R5）。
 */
import Link from "next/link";

export default function ComplianceBar() {
  return (
    <footer className="nav-compliance t-label t-muted">
      <span>数据来源：澳门交通事务局（DSAT）· 高德地图。本服务仅供个人通勤参考，非官方。</span>
      <Link href="/about" className="link-hit">
        数据来源与合规声明 ›
      </Link>
    </footer>
  );
}
