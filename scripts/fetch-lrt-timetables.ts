/**
 * 澳门轻轨各站「列车出发时刻表」图片抓取（scripts/fetch-lrt-timetables.ts）
 *
 * 数据源：https://www.mlm.com.mo/tc/route.html
 *   - 页面底部「點擊站點以查詢更多資訊」：span.selectPoint[data-href][data-station]（15 个站）
 *   - 每站详情页 station_locationDetail/article/<id>.html 内，时刻表为图片：
 *       <h2>往XXX - 列車出發時間表</h2><div><img src="/images/stations/TimeTable/<YYYY_MM>/TT_<站码>_<YYYY_MM>.jpg"></div>
 *   - 图片按「月」归档（如 2026_09），官网每月更新 → 脚本天然支持月度重跑
 *
 * 输出：
 *   data/lrt-timetables/<YYYY_MM>/TT_*.jpg   ← 图片（gitignored，逐月累积）
 *   data/lrt-timetables/manifest.json        ← 抓取清单（git 追踪）
 *
 * 用法：npm run lrt:timetable   （幂等：本地已有同名文件即跳过；零第三方依赖）
 */
import { mkdir, stat, writeFile } from "fs/promises";
import { existsSync } from "fs";
import { join } from "path";

const BASE = "https://www.mlm.com.mo";
const ROUTE_URL = `${BASE}/tc/route.html`;
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";
const OUT_ROOT = join(import.meta.dirname, "..", "data", "lrt-timetables");
const TT_IMG_RE = /<img[^>]*src="(\/images\/stations\/TimeTable\/[^"]+)"/g;
const H2_RE = /<h2[^>]*>([\s\S]*?)<\/h2>/g;

interface Station {
  slug: string;
  href: string;
  name: string;
  detail_url: string;
  images: { file: string; url: string; caption: string }[];
}
interface Manifest {
  source: string;
  fetched_at: string;
  month_dir: string;
  station_count: number;
  image_count: number;
  remark: string[];
  stations: Station[];
  fails: { station: string; url: string; error: string }[];
}

function unescapeHtml(s: string): string {
  return s
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'");
}

async function get(url: string): Promise<string> {
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
  return res.text();
}

/** route.html → 站点列表（只收 data-href 与 data-station 齐全的 selectPoint） */
function parseStations(html: string): { slug: string; href: string }[] {
  const out: { slug: string; href: string }[] = [];
  const spanRe = /<span class="selectPoint"[\s\S]*?>/g;
  for (const m of html.matchAll(spanRe)) {
    const tag = m[0];
    const href = /data-href="([^"]+)"/.exec(tag)?.[1];
    const slug = /data-station="([^"]*)"/.exec(tag)?.[1];
    if (href && slug) out.push({ slug, href });
  }
  return out;
}

/** 详情页 → 站名 + 时刻表图片列表（h2 caption 与紧随的 TimeTable img 配对） */
function parseDetailPage(html: string, href: string) {
  const name =
    /class="text_Title">([^<]+)</.exec(html)?.[1]?.trim() ??
    /<title>([^<]+)<\/title>/.exec(html)?.[1]?.trim() ??
    "";
  const imgs: { url: string; caption: string; at: number }[] = [];
  for (const m of html.matchAll(TT_IMG_RE)) {
    imgs.push({ url: m[1], caption: "", at: m.index });
  }
  const h2s: { caption: string; end: number }[] = [];
  for (const m of html.matchAll(H2_RE)) {
    h2s.push({
      caption: unescapeHtml(m[1].replace(/<[^>]+>/g, "").replace(/\s+/g, " ")).trim(),
      end: m.index + m[0].length,
    });
  }
  let cursor = 0;
  for (const img of imgs) {
    let best: { caption: string } | null = null;
    for (const h of h2s) {
      if (h.end < img.at) best = h;
      else break;
    }
    img.caption = best?.caption ?? "";
  }
  return { name, imgs: imgs.map((i) => ({ url: i.url, caption: i.caption })) };
}

/**
 * 下载图片。⚠️ mlm 图床防盗链：必须带 Referer（详情页）与浏览器头，
 * 否则返回 HTTP 200 + 空 body（2026-09-07 实测 node fetch / curl 均复现）
 */
async function download(url: string, referer: string, destDir: string, destFile: string): Promise<number> {
  const target = join(destDir, destFile);
  if (existsSync(target)) {
    const s = await stat(target);
    if (s.size > 0) return 0; // 幂等：已存在跳过
  }
  const res = await fetch(url, {
    headers: {
      "User-Agent": UA,
      Accept: "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
      "Accept-Language": "zh-TW,zh;q=0.9,en;q=0.8",
      Referer: referer,
    },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length === 0) throw new Error("empty body（疑似防盗链，需带 Referer）");
  await writeFile(target, buf);
  return buf.length;
}

async function main() {
  console.log("① 读取线路页 …");
  const routeHtml = await get(ROUTE_URL);
  const stationsRaw = parseStations(routeHtml);
  if (stationsRaw.length === 0) {
    console.error("❌ 未解析到任何站点（selectPoint 结构变了？）——请人工检查官网 HTML 更新选择器");
    process.exit(1);
  }
  // 备注（更新月份核对）：剥标签后取含「更新於」的子句
  const plainRoute = unescapeHtml(routeHtml.replace(/<[^>]+>/g, " ").replace(/\s+/g, " "));
  const remark = [...plainRoute.matchAll(/([^。;；]*更新於[^。;；]*[。;；]?)/g)]
    .map((m) => m[1].trim())
    .filter((s) => s.length > 2 && s.length <= 100);
  console.log(`   站点 ${stationsRaw.length} 个 → 逐站读取详情页 …`);

  const stations: Station[] = [];
  const fails: Manifest["fails"] = [];
  let downloadNew = 0;
  let downloadSkip = 0;

  for (const st of stationsRaw) {
    const detailUrl = `${BASE}${st.href}`;
    try {
      const html = await get(detailUrl);
      const { name, imgs } = parseDetailPage(html, st.href);
      if (imgs.length === 0) {
        fails.push({ station: name || st.slug, url: detailUrl, error: "详情页无 TimeTable 图片" });
        console.log(`  ⚠️ ${name || st.slug}: 未找到时刻表图片`);
        continue;
      }
      // 每张图按自身 URL 的月份归档（个别站官网会滞后，如路氹東站仍 2026_06）
      const imgsOut: Station["images"] = [];
      for (const im of imgs) {
        const mm = /TimeTable\/(\d{4}_\d{2})\//.exec(im.url)?.[1];
        if (!mm) continue;
        const base = decodeURIComponent(im.url.split("/").pop() || "");
        imgsOut.push({ file: `${mm}/${base}`, url: `${BASE}${im.url}`, caption: im.caption });
      }
      if (imgsOut.length === 0) {
        fails.push({ station: name || st.slug, url: detailUrl, error: "TimeTable 图片缺月份目录" });
        continue;
      }
      stations.push({
        slug: st.slug,
        href: st.href,
        name,
        detail_url: detailUrl,
        images: imgsOut,
      });
      console.log(`  ✓ ${name || st.slug}（${st.slug}）· ${imgsOut.length} 张`);
    } catch (e) {
      fails.push({ station: st.slug, url: detailUrl, error: (e as Error).message });
      console.log(`  ⚠️ ${st.slug}: ${(e as Error).message}`);
    }
  }

  if (stations.length === 0) {
    console.error("❌ 所有站点解析失败，终止（不写坏 manifest）");
    process.exit(1);
  }

  // ② 下载（每张图按自身月份目录落盘）
  const months = [...new Set(stations.flatMap((s) => s.images.map((i) => i.file.split("/")[0])))].sort();
  console.log(`\n② 下载到 data/lrt-timetables/${months.join("/")} …`);
  const imgJobs: { station: string; file: string; url: string; referer: string }[] = [];
  for (const st of stations) {
    for (const im of st.images) {
      imgJobs.push({ station: st.name || st.slug, file: im.file, url: im.url, referer: st.detail_url });
    }
  }
  for (const job of imgJobs) {
    const destDir = join(OUT_ROOT, job.file.split("/")[0]);
    await mkdir(destDir, { recursive: true });
    try {
      const base = job.file.split("/").slice(1).join("/");
      const n = await download(job.url, job.referer, destDir, base);
      if (n > 0) {
        downloadNew++;
        console.log(`  + ${job.file}（${n} bytes）`);
      } else downloadSkip++;
    } catch (e) {
      fails.push({ station: job.station, url: job.url, error: (e as Error).message });
      const cause = (e as { cause?: { code?: string; message?: string } }).cause;
      console.log(`  ⚠️ 下载失败 ${job.file}: ${(e as Error).message}${cause ? ` (${cause.code} ${cause.message})` : ""}`);
    }
  }

  // ③ manifest（month_dir = 最新月份；months = 本次实际检测到的全部月份）
  const manifest: Manifest = {
    source: ROUTE_URL,
    fetched_at: new Date().toISOString(),
    month_dir: months[months.length - 1] ?? "",
    station_count: stations.length,
    image_count: imgJobs.length,
    remark,
    stations,
    fails,
  };
  const manifestPath = join(OUT_ROOT, "manifest.json");
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n");

  // ④ 摘要
  console.log("\n──────── 摘要 ────────");
  console.log(`月份     : ${months.join(", ")}（最新 ${manifest.month_dir}）`);
  console.log(`站点数   : ${stations.length}（图片 ${imgJobs.length} 张）`);
  console.log(`新增下载 : ${downloadNew}  已存在跳过 : ${downloadSkip}  失败 : ${fails.length}`);
  if (remark.length) console.log(`官网备注 : ${remark.join(" ｜ ")}`);
  console.log(`manifest : ${manifestPath}`);
  if (fails.length > 0) {
    console.log("\n⚠️ 存在失败项（见 manifest.fails）：");
    for (const f of fails) console.log(`  - ${f.station} ${f.url} → ${f.error}`);
    process.exit(2);
  }
  console.log("✅ 完成");
}

main().catch((e) => {
  console.error("❌ 脚本异常：", (e as Error).message);
  process.exit(1);
});
