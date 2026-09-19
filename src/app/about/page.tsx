/**
 * /about —— 「关于」页：数据来源与合规声明（src/app/about/page.tsx，v2.0.0）
 *
 * 这一页是**条款义务的落地**，不是装饰。依据 `docs/数据来源合规备忘-20260914.md`：
 *
 *   澳门特别行政区交通事务局（DSAT）网站使用条款（2009-10-28）明确：
 *     #3 非商业用途可复制再发布，必须注明内容由交通事务局提供 + 获得内容的日期；
 *     #5 禁止任何商业性用途（需书面授权）；
 *     #6 不得对内容作任何修改；
 *     #7 数字可再运算统计出新数字，但公布时必须指出来源 + 说明计算方法。
 *
 * 自动选线正是 #7 所说的「对官方数字再运算得出的新数字」→ 本页即其「来源 + 计算方法」披露。
 * ⚠️ 取得日期用**本页生成日**表达：实时报站是访问瞬间即时取得的，生成日即取得日。
 *
 * ── ★ v2.0.0：整页界面文案**简体化**（只改字形，不改法律含义）──────────
 *   保留**繁体**者仅三类（**机构/官方专有名称与地名**）：
 *     · 「澳門特別行政區」「交通事務局」「澳門輕軌」（机构/网络官方名称）
 *     · 「澳門科技大學」「澳門」（校名、地名）
 *     · 「氹仔線」（线路官方名称）
 *   其余**普通行文**一律简体（如 關於→关于、資料→数据、請求→请求、僅→仅…）。
 *   ⚠️ 改写时**逐句保持语义等价**，未增删任何权利义务表述。
 */
import Link from "next/link";
import { DSAT_UA } from "@/lib/dsat/ua";

export const metadata = {
  title: "关于 · MUST登校",
  description: "数据来源、计算方法与非商业声明",
};

const H2 = ({ children }: { children: React.ReactNode }) => (
  <h2 className="h-title" style={{ marginTop: 0 }}>
    {children}
  </h2>
);

const P = ({ children }: { children: React.ReactNode }) => (
  <p className="t-body t-muted" style={{ lineHeight: 1.85, marginTop: 8 }}>
    {children}
  </p>
);

const UL = ({ items }: { items: React.ReactNode[] }) => (
  <ul className="t-body t-muted" style={{ lineHeight: 1.9, marginTop: 8, paddingLeft: 18 }}>
    {items.map((it, i) => (
      <li key={i} style={{ marginBottom: 4 }}>
        {it}
      </li>
    ))}
  </ul>
);

export default function AboutPage() {
  const macau = new Date(Date.now() + 8 * 3_600_000);
  const p = (n: number) => String(n).padStart(2, "0");
  const today = `${macau.getUTCFullYear()}-${p(macau.getUTCMonth() + 1)}-${p(macau.getUTCDate())}`;

  return (
    <main className="page">
      <header className="rc-top">
        <Link href="/" className="btn btn--text btn--sm">
          ← 返回
        </Link>
      </header>

      <h1 className="h-headline" style={{ margin: "6px 0 4px" }}>
        关于本专案
      </h1>
      <p className="t-label t-muted" style={{ marginBottom: 16 }}>
        MUST登校 · 澳門科技大學校园通勤巴士／轻轨报站工具
      </p>

      <section className="card" style={{ padding: "16px 16px 18px" }}>
        <H2>一、非商业声明</H2>
        <P>
          本专案为<b>个人学业 / 作品用途</b>，不收取任何费用、不投放广告、不进行任何形式的商业利用。
          专案与其数据仅供本人通勤参考。
        </P>
        <P>
          ⚠️ 交通事務局使用条款明确禁止未经书面授权的商业性用途。若未来考虑任何形式的变现，
          将先取得官方书面授权。
        </P>
      </section>

      <section className="card" style={{ padding: "16px 16px 18px", marginTop: 12 }}>
        <H2>二、数据来源与取得日期</H2>
        <UL
          items={[
            <>
              <b>实时报站数据</b>：澳門特別行政區交通事務局（DSAT）巴士报站接口。
              本页生成于 <b>{today}</b>（澳門时间）；画面上显示的「更新于 HH:MM」
              即为该次取得内容的时刻。
            </>,
            <>
              <b>轻轨时刻表</b>：澳門輕軌公开时刻数据（经 motransportinfo 取得），
              班次按官方时刻表推算。
            </>,
            <>
              <b>站间行驶时间与步行时间</b>：官方无此数据，全部来自我本人<b>实地通勤打点的样本</b>，
              由本机自行统计得出。
            </>,
            <>
              <b>地图底图与路线规划（全澳导航）</b>：本服务来源于<b>高德地图</b>（AutoNavi）。
              导航的候选路线、首末段步行几何由高德路径规划接口提供；地图底图由高德 JS API 绘制。
              本服务对其<strong>原始数据不作修改</strong>，仅在此之上做时间重算与排序。
            </>,
          ]}
        />
      </section>

      <section className="card" style={{ padding: "16px 16px 18px", marginTop: 12 }}>
        <H2>二之一、位置用途说明</H2>
        <P>
          全澳导航需要取得你的位置，用途<b>仅限于计算路线</b>：把位置作为路径规划的起点，
          在装置上即时使用。<b>位置不会上传到服务器保存，也不会用于任何其他目的或分享给第三方。</b>
        </P>
        <P>
          你可以在浏览器／系统设置中随时关闭定位授权；关闭后仍可<b>手动选择出发地</b>使用本功能。
        </P>
      </section>

      <section className="card" style={{ padding: "16px 16px 18px", marginTop: 12 }}>
        <H2>三、不对原始内容作任何修改</H2>
        <P>
          站名、线路名、站序等均为官方原始数据，本专案<b>原样展示、不作任何修改</b>。
          所有推估值均以独立的「预估」标示呈现，不与官方数据混淆，亦不代表官方版本或经官方认可。
        </P>
      </section>

      <section className="card" style={{ padding: "16px 16px 18px", marginTop: 12 }}>
        <H2>四、推算数值的计算方法</H2>
        <P>
          「还有 N 站 ≈ 还要 X 分钟」、「最快路线」、「赶车分档」都是
          <b>由官方数字再运算得出的新数字</b>，计算方法如下：
        </P>
        <UL
          items={[
            <>
              <b>还有几站 → 几分钟</b>：用 DSAT 提供的「车辆挂载站」与用户等车站的站序差（即 N 站），
              把 N 个相邻区间<b>逐跳累加</b>，每跳取同站对的实测中位数（<b>不乘单一常数</b>）。
            </>,
            <>
              <b>车上时间</b>：站间实测统计值。口径为「关好门准备起步」至下站同一状态（含到站停靠）。
            </>,
            <>
              <b>步行时间</b>：同一地点↔站点的实测样本均值；澳科大不同校区座别分开统计。
            </>,
            <>
              <b>轻轨时间</b>：按官方表定逐跳 2 分钟估算（氹仔線实测各跳均落于 119~121 秒）。
            </>,
            <>
              <b>赶车分档</b>：以「正常走」为基准档（第 3 档），按冲刺／小跑／慢走／爬行的速度比
              推算所需时间，再与报时下限比较得出五个档位。
            </>,
            <>
              <b>换乘步行</b>：下车打点到「到达换乘站台开始等车」的实测间隔（已扣除等车时间）。
            </>,
            <>
              <b>候选路线的取舍</b>：只列出「以正常步速能赶上首班车」的路线。
              赶不上的路线<b>不列入候选</b>（不显示带估算等车时间的替代结果）；
              换乘后仍取「到达换乘站时刻之后的第一班」。
            </>,
          ]}
        />
        <P>
          ⚠️ 上述数值<b>均为估算，可能有误差</b>，亦可能因路况、班次调整而失效。请以现场实际情况为准。
          跨境的行程<b>不计通关时间</b>。
        </P>
      </section>

      <section className="card" style={{ padding: "16px 16px 18px", marginTop: 12, marginBottom: 24 }}>
        <H2>五、联络与自动化请求说明</H2>
        <P>本专案的自动化请求会主动亮明身份，User-Agent 为：</P>
        <p
          className="t-label"
          style={{
            marginTop: 8,
            padding: "8px 10px",
            borderRadius: "var(--r-field)",
            background: "var(--surface-dim)",
            wordBreak: "break-all",
            lineHeight: 1.6,
          }}
        >
          {DSAT_UA}
        </p>
        <P>
          请求全程<b>只读</b>（不写入、不注册、不登录），维持恒定低频节律，
          并具备失败降频与熔断退出机制。
          若官方认为该访问方式有任何不妥，请通过下列网址告知，将立即调整或停止。
        </P>
        <P>
          专案网址：
          <a href="https://musttoukou.vercel.app" style={{ color: "var(--primary)" }}>
            musttoukou.vercel.app
          </a>
        </P>
      </section>
    </main>
  );
}
