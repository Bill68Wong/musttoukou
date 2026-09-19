/**
 * /about —— 「關於」页：数据来源与合规声明（src/app/about/page.tsx，v1.0.0）
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
 */
import Link from "next/link";
import { DSAT_UA } from "@/lib/dsat/ua";

export const metadata = {
  title: "關於 · MUST登校",
  description: "資料來源、計算方法與非商業聲明",
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
        關於本專案
      </h1>
      <p className="t-label t-muted" style={{ marginBottom: 16 }}>
        MUST登校 · 澳門科技大學校園通勤巴士／輕軌報站工具
      </p>

      <section className="card" style={{ padding: "16px 16px 18px" }}>
        <H2>一、非商業聲明</H2>
        <P>
          本專案為<b>個人學業 / 作品用途</b>，不收取任何費用、不投放廣告、不進行任何形式的商業利用。
          專案與其資料僅供本人通勤參考。
        </P>
        <P>
          ⚠️ 交通事務局使用條款明確禁止未經書面授權的商業性用途。若未來考慮任何形式的變現，
          將先取得官方書面授權。
        </P>
      </section>

      <section className="card" style={{ padding: "16px 16px 18px", marginTop: 12 }}>
        <H2>二、資料來源與取得日期</H2>
        <UL
          items={[
            <>
              <b>實時報站數據</b>：澳門特別行政區交通事務局（DSAT）巴士報站接口。
              本頁生成於 <b>{today}</b>（澳門時間）；畫面上顯示的「更新於 HH:MM」
              即為該次取得內容的時刻。
            </>,
            <>
              <b>輕軌時刻表</b>：澳門輕軌公開時刻資料（經 motransportinfo 取得），
              班次按官方時刻表推算。
            </>,
            <>
              <b>站間行駛時間與步行時間</b>：官方無此數據，全部來自我本人<b>實地通勤打點的樣本</b>，
              由本機自行統計得出。
            </>,
            <>
              <b>地圖底圖與路線規劃（全澳導航）</b>：本服務來源於<b>高德地圖</b>（AutoNavi）。
              導航的候選路線、首末段步行幾何由高德路徑規劃接口提供；地圖底圖由高德 JS API 繪製。
              本服務對其<strong>原始數據不作修改</strong>，僅在此之上做時間重算與排序。
            </>,
          ]}
        />
      </section>

      <section className="card" style={{ padding: "16px 16px 18px", marginTop: 12 }}>
        <H2>二之一、位置用途說明</H2>
        <P>
          全澳導航需要取得你的位置，用途<b>僅限於計算路線</b>：把位置作為路徑規劃的起點，
          在裝置上即時使用。<b>位置不會上傳到伺服器保存，也不會用於任何其他目的或分享給第三方。</b>
        </P>
        <P>
          你可以在瀏覽器／系統設定中隨時關閉定位授權；關閉後仍可<b>手動選擇出發點</b>使用本功能。
        </P>
      </section>

      <section className="card" style={{ padding: "16px 16px 18px", marginTop: 12 }}>
        <H2>三、不對原始內容作任何修改</H2>
        <P>
          站名、線路名、站序等均為官方原始資料，本專案<b>原樣展示、不作任何修改</b>。
          所有推估值均以獨立的「預估」標示呈現，不與官方數據混淆，亦不代表官方版本或經官方認可。
        </P>
      </section>

      <section className="card" style={{ padding: "16px 16px 18px", marginTop: 12 }}>
        <H2>四、推算數值的計算方法</H2>
        <P>
          「還有 N 站 ≈ 還要 X 分鐘」、「最快路線」、「趕車分檔」都是
          <b>由官方數字再運算得出的新數字</b>，計算方法如下：
        </P>
        <UL
          items={[
            <>
              <b>還有幾站 → 幾分鐘</b>：用 DSAT 提供的「車輛掛載站」與用戶等車站的站序差（即 N 站），
              把 N 個相鄰區間<b>逐跳累加</b>，每跳取同站對的實測中位數（<b>不乘單一常數</b>）。
            </>,
            <>
              <b>車上時間</b>：站間實測統計值。口徑為「關好門準備起步」至下站同一狀態（含到站停靠）。
            </>,
            <>
              <b>步行時間</b>：同一地點↔站點的實測樣本均值；澳科大不同校區座別分開統計。
            </>,
            <>
              <b>輕軌時間</b>：按官方表定逐跳 2 分鐘估算（氹仔線實測各跳均落於 119~121 秒）。
            </>,
            <>
              <b>趕車分檔</b>：以「正常走」為基準檔（第 3 檔），按衝刺／小跑／慢走／爬行的速度比
              推算所需時間，再與報時下限比較得出五個檔位。
            </>,
            <>
              <b>換乘步行</b>：下車打點到「到達換乘站台開始等車」的實測間隔（已扣除等車時間）。
            </>,
            <>
              <b>候選路線的取捨</b>：只列出「以正常步速能趕上首班車」的路線。
              趕不上的路線<b>不列入候選</b>（不顯示帶估算等車時間的替代結果）；
              換乘後仍取「到達換乘站時刻之後的第一班」。
            </>,
          ]}
        />
        <P>
          ⚠️ 上述數值<b>均為估算，可能有誤差</b>，亦可能因路況、班次調整而失效。請以現場實際情況為準。
          跨境的行程<b>不計通關時間</b>。
        </P>
      </section>

      <section className="card" style={{ padding: "16px 16px 18px", marginTop: 12, marginBottom: 24 }}>
        <H2>五、聯絡與自動化請求說明</H2>
        <P>本專案的自動化請求會主動亮明身分，User-Agent 為：</P>
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
          請求全程<b>只讀</b>（不寫入、不註冊、不登入），維持恒定低頻節律，
          並具備失敗降頻與熔斷退出機制。
          若官方認為該訪問方式有任何不妥，請透過下列網址告知，將立即調整或停止。
        </P>
        <P>
          專案網址：
          <a href="https://musttoukou.vercel.app" style={{ color: "var(--primary)" }}>
            musttoukou.vercel.app
          </a>
        </P>
      </section>
    </main>
  );
}
