"use client";

import { useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";

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
      router.push(params.get("from") || "/");
      router.refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="page" style={{ justifyContent: "center" }}>
      <h1 style={{ fontSize: 24, marginBottom: 8 }}>MUST登校</h1>
      <p style={{ color: "var(--muted)", marginBottom: 32 }}>请输入访问口令</p>
      <form onSubmit={submit}>
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="口令"
          autoFocus
          style={{
            width: "100%",
            minHeight: 48,
            fontSize: 17,
            padding: "12px 16px",
            borderRadius: 12,
            border: "1px solid #3a3f4b",
            background: "var(--card)",
            color: "var(--text)",
            marginBottom: 12,
          }}
        />
        {error && (
          <p style={{ color: "var(--danger)", marginBottom: 12, fontSize: 14 }}>{error}</p>
        )}
        <button type="submit" disabled={loading || !password}>
          {loading ? "验证中…" : "进入"}
        </button>
      </form>
    </main>
  );
}
