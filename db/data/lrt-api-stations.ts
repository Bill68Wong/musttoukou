/**
 * motransportinfo（DSAT 同源）getLrtStations 站 id ↔ 本库 DB 站码 映射种子。
 * 唯一真相源：抓取脚本与查询端共用，勿在别处散落硬编码（v0.15.0）。
 *
 * 站名/坐标以 motransportinfo 返回为准（脚本会 merge 刷新）；此处预置 DB 码映射，
 * 因 getLrtStations 本身不含「LRT-xxx」本库码。LOT/UH 为多线换乘站（api 同 id 多站台）。
 */
export interface LrtApiStationSeed {
  /** motransportinfo 站 id */
  api_id: string;
  /** 本库站码 stations.code */
  db_code: string;
  /** 官方中文站名 */
  name_tc: string;
  /** 该站经停线路（route_no 逗号分隔，仅注释用） */
  lines?: string;
}

export const LRT_API_STATIONS: LrtApiStationSeed[] = [
  { api_id: "BAR", db_code: "LRT-BAR", name_tc: "媽閣站", lines: "TPL" },
  { api_id: "OCE", db_code: "LRT-OCH", name_tc: "海洋站", lines: "TPL" },
  { api_id: "JOC", db_code: "LRT-JCK", name_tc: "馬會站", lines: "TPL" },
  { api_id: "STA", db_code: "LRT-STD", name_tc: "運動場站", lines: "TPL" },
  { api_id: "PAK", db_code: "LRT-PAK", name_tc: "排角站", lines: "TPL" },
  { api_id: "COW", db_code: "LRT-CWE", name_tc: "路氹西站", lines: "TPL" },
  { api_id: "LOT", db_code: "LRT-LOT", name_tc: "蓮花站", lines: "TPL,HQL" },
  { api_id: "UH", db_code: "LRT-UH", name_tc: "協和醫院站", lines: "TPL,SPVL" },
  { api_id: "EAG", db_code: "LRT-EAG", name_tc: "東亞運站", lines: "TPL" },
  { api_id: "COE", db_code: "LRT-LDE", name_tc: "路氹東站", lines: "TPL" },
  { api_id: "MUS", db_code: "LRT-MUST", name_tc: "科大站", lines: "TPL" },
  { api_id: "AIR", db_code: "LRT-AP", name_tc: "機場站", lines: "TPL" },
  { api_id: "TFT", db_code: "LRT-TFT", name_tc: "氹仔碼頭站", lines: "TPL" },
  { api_id: "HQ", db_code: "LRT-HQ", name_tc: "橫琴站", lines: "HQL" },
  { api_id: "SPV", db_code: "LRT-SPW", name_tc: "石排灣站", lines: "SPVL" },
];
