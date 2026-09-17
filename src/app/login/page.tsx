import LoginForm from "@/components/LoginForm";

/**
 * 登录页（v1.1.11 改：表单改为**服务端直出**）
 *
 * 原实现用 `<Suspense>` 包 `LoginForm`，因为表单内部调了 `useSearchParams()`
 * —— 代价是**首屏 HTML 只有「加载中…」**，真正能输入的表单要等客户端 JS 水合才出现。
 * 登录页是全站最不能出问题的一页（口令门的唯一入口），万一水合失败就永远停在加载中。
 *
 * 现在把 `from` / `dev` 由**服务端**读出来当 props 传给表单：
 *   · `LoginForm` 不再需要 `useSearchParams()` → 不需要 Suspense → 首屏就能看见输入框
 *   · 无 JS 时至少也能看到表单结构（提交仍需 JS，但不再是一片空白）
 */
export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const one = (k: string): string | null => {
    const v = sp[k];
    const s = Array.isArray(v) ? v[0] : v;
    return s && s.trim() ? s.trim() : null;
  };
  // 只接受站内相对路径，避免被拿去做跳转钓鱼（`//evil.com` 这类）
  const rawFrom = one("from");
  const from = rawFrom && rawFrom.startsWith("/") && !rawFrom.startsWith("//") ? rawFrom : null;

  return <LoginForm from={from} dev={one("dev") === "1"} />;
}
