/**
 * 轻轨时刻表 → 报站倒计时纯函数（src/lib/lrt/eta.ts）
 *
 * 时刻基准（重要，防跨午夜错乱）：
 *   - 每个 lrt_timetables 行 = 某「服务日」的班表；minutes 的 hour 是服务日 00:00 起的小时，
 *     hour 可 >23（周五/假期 24:xx 收车 → hour 24 表示次日凌晨）。
 *   - 查询日在 D。行内任一发车相对 D 00:00 的「绝对秒」= offsetMin*60（offset 可 >1440，
 *     即次日凌晨 D+1 00:xx——数值上仍可直接与 nowSec(D 日内秒) 相减求剩余）。
 *   - 前一服务日 D-1 的行只取跨午夜段（offset ≥ 1440，落到 D 凌晨），绝对秒 = (offset-1440)*60。
 *   - 因此所有候选统一到「D 00:00 起秒」这一条时间轴比较，无日期歧义。
 */
export interface LrtTimetableMinutes {
  /** 列名与 lrt_timetables 一致（pg 返回 snake_case，勿改 camel 否则取不到） */
  first_min: number;
  last_min: number;
  minutes: { hour: number; minutes: number[] }[];
}

/** [{hour, minutes[]}] → 升序去重的服务日分钟偏移数组（hour 可 >23） */
export function rowOffsetsOf(minutes: { hour: number; minutes: number[] }[]): number[] {
  const set = new Set<number>();
  for (const h of minutes) {
    for (const m of h.minutes) set.add(h.hour * 60 + m);
  }
  return [...set].sort((a, b) => a - b);
}

/**
 * 行 → 「D 00:00 起秒」时间轴候选。
 * isPrevDay=false（查询日行）：offset*60 直接入轴（>1440 即次日凌晨班，数值天然正确）。
 * isPrevDay=true（前一日行）：仅取 offset ≥ 1440 的跨午夜段 → (offset-1440)*60。
 */
export function rowCandidateSec(
  row: Pick<LrtTimetableMinutes, "minutes">,
  isPrevDay: boolean,
): number[] {
  const offs = rowOffsetsOf(row.minutes);
  if (!isPrevDay) return offs.map((o) => o * 60);
  return offs.filter((o) => o >= 1440).map((o) => (o - 1440) * 60);
}

/** 取严格晚于 nowSec 的最近 n 班（绝对秒，升序；同分重复自动折叠） */
export function nextN(secs: number[], nowSec: number, n: number): number[] {
  const out: number[] = [];
  for (const s of [...secs].sort((a, b) => a - b)) {
    if (s > nowSec && (out.length === 0 || s > out[out.length - 1])) out.push(s);
    if (out.length === n) break;
  }
  return out;
}

/** 取严格晚于 nowSec 的最近 2 班（绝对秒，升序；同分重复自动折叠） */
export function nextTwo(secs: number[], nowSec: number): number[] {
  return nextN(secs, nowSec, 2);
}

/** 日内秒（0..86399，容忍 ≥86400 自动折回）→ 'HH:MM' */
export function hhmmOf(daySec: number): string {
  const s = Math.max(0, Math.floor(daySec) % 86400);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/** 服务日分钟偏移（可 >1440）→ 时钟 'HH:MM'（折回 24h） */
export function hhmmOfMinutes(offsetMin: number): string {
  return hhmmOf((offsetMin % 1440) * 60);
}
