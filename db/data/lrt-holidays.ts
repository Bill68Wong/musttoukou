/**
 * 澳门法定公众假期种子（2026–2027，来源 gov.mo 官方年历）。
 * 班别判定用：命中该日 → 轻轨执行 sat_sun_holiday 班表（周末/假日班）。
 * 每年初需补种下一年（届时以 gov.mo 当年公开假期为准，勿凭记忆）。
 */
export interface LrtHolidaySeed {
  /** 'YYYY-MM-DD' */
  date: string;
  code: string;
  name_tc: string;
  name_pt?: string | null;
}

export const LRT_HOLIDAYS: LrtHolidaySeed[] = [
  { date: "2026-01-01", code: "new_year", name_tc: "元旦", name_pt: "Dia de Ano Novo" },
  { date: "2026-02-17", code: "lunar_new_year_d1", name_tc: "農曆正月初一", name_pt: "1.º dia do Ano Novo Chinês" },
  { date: "2026-02-18", code: "lunar_new_year_d2", name_tc: "農曆正月初二", name_pt: "2.º dia do Ano Novo Chinês" },
  { date: "2026-02-19", code: "lunar_new_year_d3", name_tc: "農曆正月初三", name_pt: "3.º dia do Ano Novo Chinês" },
  { date: "2026-04-03", code: "good_friday", name_tc: "耶穌受難日", name_pt: "Sexta-Feira Santa" },
  { date: "2026-04-04", code: "easter_eve", name_tc: "復活節前日", name_pt: "Sábado de Aleluia" },
  { date: "2026-04-05", code: "ching_ming", name_tc: "清明節", name_pt: "Cheng Ming" },
  { date: "2026-05-01", code: "labour_day", name_tc: "勞動節", name_pt: "Dia do Trabalhador" },
  { date: "2026-05-24", code: "buddha_birthday", name_tc: "佛誕節", name_pt: "Dia do Buda" },
  { date: "2026-06-19", code: "dragon_boat", name_tc: "端午節", name_pt: "Barcos Dragão" },
  { date: "2026-09-26", code: "day_after_mid_autumn", name_tc: "中秋節翌日", name_pt: "Dia seguinte ao Chong Chao" },
  { date: "2026-10-01", code: "national_day", name_tc: "中華人民共和國國慶日", name_pt: "Dia Nacional da República Popular da China" },
  { date: "2026-10-02", code: "day_after_national_day", name_tc: "中華人民共和國國慶日翌日", name_pt: "Dia seguinte ao Dia Nacional" },
  { date: "2026-10-18", code: "chung_yeung", name_tc: "重陽節", name_pt: "Chong Yeong" },
  { date: "2026-11-02", code: "all_souls_day", name_tc: "追思節", name_pt: "Dia de Finados" },
  { date: "2026-12-08", code: "immaculate_conception", name_tc: "聖母無原罪瞻禮", name_pt: "Imaculada Conceição" },
  { date: "2026-12-20", code: "macau_sar_day", name_tc: "澳門特別行政區成立紀念日", name_pt: "Dia da Região Administrativa Especial de Macau" },
  { date: "2026-12-22", code: "winter_solstice", name_tc: "冬至", name_pt: "Solstício de Inverno" },
  { date: "2026-12-24", code: "christmas_eve", name_tc: "聖誕節前日", name_pt: "Véspera de Natal" },
  { date: "2026-12-25", code: "christmas", name_tc: "聖誕節", name_pt: "Natal" },
  { date: "2027-01-01", code: "new_year", name_tc: "元旦", name_pt: "Dia de Ano Novo" },
  { date: "2027-02-06", code: "lunar_new_year_d1", name_tc: "農曆正月初一", name_pt: "1.º dia do Ano Novo Chinês" },
  { date: "2027-02-07", code: "lunar_new_year_d2", name_tc: "農曆正月初二", name_pt: "2.º dia do Ano Novo Chinês" },
  { date: "2027-02-08", code: "lunar_new_year_d3", name_tc: "農曆正月初三", name_pt: "3.º dia do Ano Novo Chinês" },
  { date: "2027-03-26", code: "good_friday", name_tc: "耶穌受難日", name_pt: "Sexta-Feira Santa" },
  { date: "2027-03-27", code: "easter_eve", name_tc: "復活節前日", name_pt: "Sábado de Aleluia" },
  { date: "2027-04-05", code: "ching_ming", name_tc: "清明節", name_pt: "Cheng Ming" },
  { date: "2027-05-01", code: "labour_day", name_tc: "勞動節", name_pt: "Dia do Trabalhador" },
  { date: "2027-05-13", code: "buddha_birthday", name_tc: "佛誕節", name_pt: "Dia do Buda" },
  { date: "2027-06-09", code: "dragon_boat", name_tc: "端午節", name_pt: "Barcos Dragão" },
  { date: "2027-09-16", code: "day_after_mid_autumn", name_tc: "中秋節翌日", name_pt: "Dia seguinte ao Chong Chao" },
  { date: "2027-10-01", code: "national_day", name_tc: "中華人民共和國國慶日", name_pt: "Dia Nacional da República Popular da China" },
  { date: "2027-10-02", code: "day_after_national_day", name_tc: "中華人民共和國國慶日翌日", name_pt: "Dia seguinte ao Dia Nacional" },
  { date: "2027-10-08", code: "chung_yeung", name_tc: "重陽節", name_pt: "Chong Yeong" },
  { date: "2027-11-02", code: "all_souls_day", name_tc: "追思節", name_pt: "Dia de Finados" },
  { date: "2027-12-08", code: "immaculate_conception", name_tc: "聖母無原罪瞻禮", name_pt: "Imaculada Conceição" },
  { date: "2027-12-20", code: "macau_sar_day", name_tc: "澳門特別行政區成立紀念日", name_pt: "Dia da Região Administrativa Especial de Macau" },
  { date: "2027-12-22", code: "winter_solstice", name_tc: "冬至", name_pt: "Solstício de Inverno" },
  { date: "2027-12-24", code: "christmas_eve", name_tc: "聖誕節前日", name_pt: "Véspera de Natal" },
  { date: "2027-12-25", code: "christmas", name_tc: "聖誕節", name_pt: "Natal" },
];
