"use client";

import { useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { writeDevMode } from "@/lib/dev-mode";

export default function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
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
      // ★ v1.1.11：若是从「開發者模式：需口令」那个开关点进来的（dev=1），
      //   登录成功就顺手把开发者模式打开 —— 用户点一次开关就到位，不用再点第二次。
      if (params.get("dev") === "1") writeDevMode(true);
      router.push(params.get("from") || "/");
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
          <span style={{ opacity: 0.75 }}>開發者模式與數據頁需要口令</span>
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
