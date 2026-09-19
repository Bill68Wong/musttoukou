"use client";

/**
 * 登录表单（v1.1.11 改：参数由 props 传入，不再用 useSearchParams）
 *
 * 为什么改：`useSearchParams()` 必须包在 `<Suspense>` 里 → 首屏只出 fallback，
 * 表单要等客户端水合。登录页是口令门的唯一入口，不该依赖水合才可见（见 `app/login/page.tsx`）。
 */
import { useState } from "react";
import { useRouter } from "next/navigation";
import { writeDevMode } from "@/lib/dev-mode";

export default function LoginForm({
  from = null,
  dev = false,
}: {
  /** 登录成功后回跳的站内路径（已由服务端校验为相对路径） */
  from?: string | null;
  /** 是否从「開發者模式：需口令」那个开关点进来的 —— 是则登录后顺手开启开发者模式 */
  dev?: boolean;
}) {
  const router = useRouter();
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/auth", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
      if (!res.ok) {
        const data = (await res.json()) as { error?: string };
        throw new Error(data.error ?? "登录失败");
      }
      // ★ v1.1.11：从开发者开关点进来（dev=1）→ 登录成功就顺手把开发者模式打开，
      //   用户点一次开关就到位，不用再点第二次。
      if (dev) writeDevMode(true);
      router.push(from || "/");
      router.refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="page page--center">
      <div
        className="anim-fade-up"
        style={{
          width: "100%",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
        }}
      >
        <div
          className="icon-badge"
          style={{ width: 64, height: 64, fontSize: 28, marginBottom: 16 }}
        >
          🚌
        </div>
        <h1 className="h-headline t-center" style={{ marginBottom: 4 }}>
          MUST登校
        </h1>
        <p className="t-label t-muted t-center" style={{ marginBottom: 28 }}>
          请输入访问口令
          <br />
          <span style={{ opacity: 0.75 }}>开发者模式与数据页需要口令</span>
        </p>
        <form
          onSubmit={submit}
          style={{ width: "100%", display: "flex", flexDirection: "column", gap: 12 }}
        >
          <input
            type="password"
            className="field"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="口令"
            autoFocus
          />
          {error && <p className="t-label t-error t-center">{error}</p>}
          <button
            type="submit"
            disabled={loading || !password}
            className="btn btn--primary btn--block btn--lg"
            style={{ marginTop: 4 }}
          >
            {loading ? "验证中…" : "进入"}
          </button>
        </form>
      </div>
    </main>
  );
}
