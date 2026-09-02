import { NextRequest, NextResponse } from "next/server";

/** 口令验证：POST /api/auth {password} → 设 30 天 HttpOnly cookie */
export async function POST(req: NextRequest) {
  const password = process.env.ACCESS_PASSWORD;
  if (!password) {
    return NextResponse.json({ error: "服务端未配置 ACCESS_PASSWORD" }, { status: 500 });
  }

  let body: { password?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "请求格式错误" }, { status: 400 });
  }

  if (body.password !== password) {
    return NextResponse.json({ error: "口令不正确" }, { status: 401 });
  }

  const res = NextResponse.json({ ok: true });
  res.cookies.set("mx_auth", password, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: 30 * 24 * 3600,
    path: "/",
  });
  return res;
}
