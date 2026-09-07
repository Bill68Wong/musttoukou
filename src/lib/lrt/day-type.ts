/**
 * 轻轨服务班别判定（src/lib/lrt/day-type.ts）
 * motransportinfo 时刻表按 3 班别组织：mon_thurs / fri / sat_sun_holiday。
 * 判定口径（2026-09-07 与 API today 对拍验证）：
 *   - 周一~四 → mon_thurs；周五 → fri
 *   - 周六/周日 → sat_sun_holiday
 *   - 命中澳门法定公众假期（lrt_holidays，含落于工作日的假期）→ sat_sun_holiday
 * 本文件只做「给定条件 → 班别」的纯判定；假期集合由调用方查库传入。
 */
export type DayType = "mon_thurs" | "fri" | "sat_sun_holiday";

export const DAY_TYPES: DayType[] = ["mon_thurs", "fri", "sat_sun_holiday"];

/** weekday：0=周日…6=周六（JS getDay 语义） */
export function dayTypeOf(weekday: number, isHoliday: boolean): DayType {
  if (isHoliday || weekday === 0 || weekday === 6) return "sat_sun_holiday";
  if (weekday === 5) return "fri";
  return "mon_thurs";
}

export interface MacauNowParts {
  /** 'YYYY-MM-DD'（澳门自然日，GMT+8） */
  ymd: string;
  /** 0=周日…6=周六 */
  weekday: number;
  /** 当日已过秒数（0..86399） */
  daySec: number;
}

/** 当前澳门（GMT+8）时刻 → 自然日 ymd + 星期 + 日内秒。时间基准不依赖服务器时区。 */
export function macauNowParts(now?: Date): MacauNowParts {
  const macau = new Date((now ?? new Date()).getTime() + 8 * 3600 * 1000);
  const y = macau.getUTCFullYear();
  const m = macau.getUTCMonth() + 1;
  const d = macau.getUTCDate();
  return {
    ymd: `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`,
    weekday: macau.getUTCDay(),
    daySec: macau.getUTCHours() * 3600 + macau.getUTCMinutes() * 60 + macau.getUTCSeconds(),
  };
}

/** 'YYYY-MM-DD' 平移 N 天（支持跨月/跨年；纯日期运算） */
export function shiftYmd(ymd: string, deltaDays: number): string {
  const [y, m, d] = ymd.split("-").map(Number);
  const dt = new Date(Date.UTC(y, (m ?? 1) - 1, (d ?? 1) + deltaDays));
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, "0")}-${String(
    dt.getUTCDate(),
  ).padStart(2, "0")}`;
}
