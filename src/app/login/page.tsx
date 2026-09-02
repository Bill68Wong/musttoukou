import { Suspense } from "react";
import LoginForm from "@/components/LoginForm";

export default function LoginPage() {
  return (
    <Suspense
      fallback={
        <main className="page">
          <p style={{ color: "var(--muted)" }}>加载中…</p>
        </main>
      }
    >
      <LoginForm />
    </Suspense>
  );
}
