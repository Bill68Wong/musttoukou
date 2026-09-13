-- =============================================================
-- MUST登校 · 数据库建表脚本（对应《数据库设计》v0.2）
-- 15 张表；幂等：全部 CREATE TABLE IF NOT EXISTS + ALTER ADD COLUMN IF NOT EXISTS，
-- 可安全重复执行（不再 DROP 重建）。本文件是「重建库唯一真相源」：
--   全新库 = apply-schema 后按需跑 db:migrate-v040→v071→v090…（迁移幂等，重复执行无副作用）
-- ⚠️ 生产库勿直接跑本脚本，一律走 db/migrate-vXXX.ts（只读数据不动，计时数据绝不触碰）
-- =============================================================

-- 2.1 地点（家 / 学校 / 口岸）
CREATE TABLE IF NOT EXISTS places (
    id          SERIAL PRIMARY KEY,
    slug        TEXT NOT NULL UNIQUE,      -- 'home' | 'school' | 'hengqin'
    name        TEXT NOT NULL,             -- '擎天汇 T8'
    kind        TEXT NOT NULL,             -- 'dorm' | 'school' | 'border'
    is_active   BOOLEAN NOT NULL DEFAULT TRUE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 2.2 站点（巴士站 + 轻轨站）；无官方编号的站用 X-名称 临时编号
CREATE TABLE IF NOT EXISTS stations (
    code        TEXT PRIMARY KEY,          -- DSAT站码 'C653'/'T374'；轻轨 'LRT-SPW'；待补 'X-…'
    name_tc     TEXT NOT NULL,             -- '金峰南岸/金譽峰'
    kind        TEXT NOT NULL,             -- 'bus' | 'lrt'
    lat         DOUBLE PRECISION,
    lng         DOUBLE PRECISION,
    dsat_synced BOOLEAN NOT NULL DEFAULT FALSE,  -- 是否已从DSAT接口核对
    note        TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 2.3 地点↔站点步行耗时（v0.24.0：仅存实测值，由 db:walktimes 重灌；手工估算值已全部剔除）
CREATE TABLE IF NOT EXISTS walk_times (
    id          SERIAL PRIMARY KEY,
    place_id    INT NOT NULL REFERENCES places(id),
    station_code TEXT NOT NULL REFERENCES stations(code),
    zone        TEXT,                      -- 澳科大校区 'B/C' | 'N/O' | 'R'；非澳科大 place 为 NULL
    minutes     NUMERIC(5,1),              -- 实测均值；NULL = 尚未实测
    samples     INT NOT NULL DEFAULT 0,    -- 实测样本数（1~2 次也写入，靠此列体现可信度）
    source      TEXT NOT NULL DEFAULT 'timer',  -- v0.24.0 起只有 'timer'
    measured_at DATE,                      -- 最近一次样本日期
    UNIQUE (place_id, station_code, zone)
);

-- 2.4 线路
CREATE TABLE IF NOT EXISTS routes (
    id          SERIAL PRIMARY KEY,
    code        TEXT NOT NULL,             -- '50' | 'LRT-石排湾线'
    kind        TEXT NOT NULL,             -- 'bus' | 'lrt'
    company     TEXT,                      -- '澳巴' | '新福利' | '轻轨'
    color       TEXT,                      -- v0.7.0+ 主题色 hex：巴士=公司色、轻轨=线路官方主题色
    is_active   BOOLEAN NOT NULL DEFAULT TRUE,
    UNIQUE (code, kind)
);

-- 2.5 线路-站点序列（由 DSAT getRouteData 同步，用于车辆位置→到站推算）
CREATE TABLE IF NOT EXISTS route_stations (
    id            SERIAL PRIMARY KEY,
    route_id      INT NOT NULL REFERENCES routes(id),
    dsat_dir      TEXT NOT NULL,           -- DSAT方向值 '0'/'2'…
    seq           INT NOT NULL,            -- 站序
    station_code  TEXT NOT NULL REFERENCES stations(code),
    UNIQUE (route_id, dsat_dir, seq)
);

-- 2.6 通勤方案（种子数据 = commute-network.json 的 plans）
CREATE TABLE IF NOT EXISTS commute_plans (
    id           SERIAL PRIMARY KEY,
    plan_key     TEXT NOT NULL UNIQUE,     -- 'home-school-1'
    from_place   INT NOT NULL REFERENCES places(id),
    to_place     INT NOT NULL REFERENCES places(id),
    summary      TEXT NOT NULL,            -- '50路 金峰南岸→路氹东/新濠天地'
    is_active    BOOLEAN NOT NULL DEFAULT TRUE,
    note         TEXT,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 2.7 方案分段（walk / bus / lrt / transfer / cross_border）
CREATE TABLE IF NOT EXISTS plan_legs (
    id            SERIAL PRIMARY KEY,
    plan_id       INT NOT NULL REFERENCES commute_plans(id) ON DELETE CASCADE,
    seq           INT NOT NULL,
    leg_kind      TEXT NOT NULL,           -- 'walk'|'bus'|'lrt'|'transfer'|'cross_border'
    route_id      INT REFERENCES routes(id),
    route_options TEXT,                    -- 备选线路JSON数组 '["25B","25BS","50",…]'
    from_station  TEXT REFERENCES stations(code),
    to_station    TEXT REFERENCES stations(code),
    minutes       NUMERIC(5,1),            -- 已知耗时（步行实测值）；乘车段NULL走估算
    note          TEXT,
    border_label  TEXT,                    -- v0.13.0 cross_border 段口岸显示名：'橫琴口岸' / '關閘（拱北口岸）'
    board_candidates TEXT[],               -- bus 段可选上车站（v0.6.0 去学校 51 系：首项=默认展示）
    alight_candidates TEXT[],              -- bus 段可选下车点（v0.6.0 回宿舍动态下车：末位=强制终点）
    route_meta      JSONB,                 -- v0.17.0 合并卡「每线路差异化」：{"50":{"to":"T400"},"51A":{"board":["C690/1","C689/2"]}}
    UNIQUE (plan_id, seq)
);

-- 2.8 DSAT 实时快照（轮询缓存，只增不改，定期归档清理）
CREATE TABLE IF NOT EXISTS bus_snapshots (
    id            BIGSERIAL PRIMARY KEY,
    route_code    TEXT NOT NULL,           -- '26'/'50'…
    dsat_dir      TEXT NOT NULL,
    station_code  TEXT,
    bus_plate     TEXT,                    -- 'MY9362'
    bus_code      TEXT,                    -- 'E3390'
    speed_kmh     SMALLINT,
    status        TEXT,                    -- '0'/'1'
    passenger_flow SMALLINT,
    polled_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_snapshots_route_time ON bus_snapshots (route_code, polled_at DESC);
CREATE INDEX IF NOT EXISTS idx_snapshots_time ON bus_snapshots (polled_at);
-- v0.4.0 归属列（随会话打点写入；v0.9.0 起补外键 fk_bus_snapshots_session → timer_sessions ON DELETE CASCADE）
ALTER TABLE bus_snapshots ADD COLUMN IF NOT EXISTS session_id INT;
ALTER TABLE bus_snapshots ADD COLUMN IF NOT EXISTS stage TEXT;           -- 'depart'|'wait_start'|'alight'|'board'
ALTER TABLE bus_snapshots ADD COLUMN IF NOT EXISTS ref_station TEXT;     -- 参照站（用户上/下车站），stops_away 以它计
ALTER TABLE bus_snapshots ADD COLUMN IF NOT EXISTS stops_away SMALLINT;  -- ref_idx − bus_idx

-- 2.9 计时器会话（一次完整通勤 = 一个 session）
CREATE TABLE IF NOT EXISTS timer_sessions (
    id            SERIAL PRIMARY KEY,
    user_id       INT NOT NULL DEFAULT 1,  -- 预留多用户
    plan_id       INT REFERENCES commute_plans(id),
    route_code    TEXT,                    -- 实际乘坐线路
    dsat_dir      TEXT,
    travel_date   DATE NOT NULL,
    weekday       SMALLINT NOT NULL,       -- 0=周日…6=周六
    time_bucket   TEXT,                    -- 时段 'am_peak'/'pm_peak'/'day'/'night'
    crowd_level   SMALLINT,                -- 【v0.18.0 起废弃】旧会话级拥挤度 0空/1正常/2拥挤/3爆满；新数据写 ride_crowd（按程）
    missed_count  SMALLINT NOT NULL DEFAULT 0,  -- 没挤上车次数
    vehicle_plate TEXT,                    -- 打点时自动抓取的车辆牌号（失败留空）
    vehicle_code  TEXT,                    -- 车号
    started_at    TIMESTAMPTZ,
    ended_at      TIMESTAMPTZ,
    total_minutes NUMERIC(5,1),
    is_edited     BOOLEAN NOT NULL DEFAULT FALSE,  -- 是否被人工修正过（原值见 edit_audit）
    deleted_at    TIMESTAMPTZ              -- 软删除
);
CREATE INDEX IF NOT EXISTS idx_sessions_route_date ON timer_sessions (route_code, travel_date);

-- 2.9b 每程拥挤度（v0.18.0：拥挤度改为「上车后在行程内记录」，换乘每趟车都记一次）
--      语义：level = 0空(随便坐)/1正常(有座)/2饱和(没座位但站稳)/3挤(贴着站)/4爆满(前胸贴后背)
--      veh_index = 载具段序号（0-based，与 buildSteps 的 Step.vehIndex 同构）
--      route_code 冗余存当时的线路，便于统计「哪条线最挤」
CREATE TABLE IF NOT EXISTS ride_crowd (
    id           BIGSERIAL PRIMARY KEY,
    session_id   INT NOT NULL REFERENCES timer_sessions(id) ON DELETE CASCADE,
    veh_index    INT NOT NULL DEFAULT 0,
    level        SMALLINT NOT NULL,
    route_code   TEXT,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    source       TEXT NOT NULL DEFAULT 'in_ride',  -- 'in_ride' 行程内记录 / 'migrated' 由旧会话级 crowd_level 迁移
    UNIQUE (session_id, veh_index)
);
-- 说明：车牌/上下车时刻不在此表冗余——session_id 已绑定整趟行程，
--       需要「具体哪班车」时 join bus_snapshots（按 route_code + 时间窗/stage 取 bus_plate）
--       或 join timer_events 取 board/alight 时刻；轻轨无车辆数据。
CREATE INDEX IF NOT EXISTS idx_ride_crowd_route ON ride_crowd (route_code);

-- 2.11 自由记站（v0.19.0：独立数据采集渠道，与乘车计时完全隔离、互不影响）
--      用途：平时有空坐车时采集「任意线路任意两站间的实测行车时长」，供自动选线建模
--      （巴士站间时长 ≈ N 站 ↔ X 分钟映射）；单次只记一条线、不换乘。
--      与 timer_sessions/events/ride_crowd 无任何关联，不入 stats/records。
CREATE TABLE IF NOT EXISTS free_rides (
    id             BIGSERIAL PRIMARY KEY,
    route_code     TEXT NOT NULL,          -- 实乘线路（如 '25B' / 'LRT-氹仔线'）
    dsat_dir       TEXT NOT NULL DEFAULT '0',
    board_station  TEXT,                   -- 上车站（events board 冗余）
    alight_station TEXT,                   -- 下车站（alight 事件带）
    vehicle_plate  TEXT,                   -- 上车时抓取的实际车辆牌号（轻轨/失败留空）
    vehicle_code   TEXT,                   -- 车号
    crowd_level    SMALLINT,               -- v0.19.0 五档（0空..4爆满，与 ride_crowd 同口径）
    started_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    ended_at       TIMESTAMPTZ,
    total_ms       INT,                    -- 全程毫秒（下车结算）
    is_test        BOOLEAN NOT NULL DEFAULT FALSE,
    note           TEXT,                   -- 备注（可选）
    deleted_at     TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_free_rides_route ON free_rides (route_code, started_at);

CREATE TABLE IF NOT EXISTS free_ride_events (
    id            BIGSERIAL PRIMARY KEY,
    free_ride_id  BIGINT NOT NULL REFERENCES free_rides(id) ON DELETE CASCADE,
    seq           INT NOT NULL,
    -- event_type：board（上车）/ stop_arrive（到站·记时刻）/ stop_pass（甩站·车未停）/
    --            stop_skip（忘记·已过站未记时，永不计时）/ alight（下车·结束）
    event_type    TEXT NOT NULL,
    station_code  TEXT,                    -- board=上车站；stop_*=该站；alight=下车站
    recorded_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (free_ride_id, seq)
);
-- v0.4.0 学校分区（B/C|N/O|R 三组座）：随 depart/arrive 打点落到会话，做步行分组上下文
ALTER TABLE timer_sessions ADD COLUMN IF NOT EXISTS from_zone TEXT;  -- 离校时从哪个座出发
ALTER TABLE timer_sessions ADD COLUMN IF NOT EXISTS to_zone TEXT;    -- 到校后到哪个座
-- v0.10.0 测试模式标记：测试运行 is_test=true；统计/记录/导出默认排除（「含测试」偏好可开）
ALTER TABLE timer_sessions ADD COLUMN IF NOT EXISTS is_test BOOLEAN NOT NULL DEFAULT false;
-- v0.13.0 通关耗时（border_start→border_end 配对闭合区间合计，独立于行程计时）
ALTER TABLE timer_sessions ADD COLUMN IF NOT EXISTS border_minutes NUMERIC(5,1);

-- 2.10 计时器打点事件
CREATE TABLE IF NOT EXISTS timer_events (
    id            BIGSERIAL PRIMARY KEY,
    session_id    INT NOT NULL REFERENCES timer_sessions(id) ON DELETE CASCADE,
    seq           INT NOT NULL,
    event_type    TEXT NOT NULL,           -- 'depart'|'wait_start'|'missed'|'board'|'station_arrive'|'station_pass'|'alight'|'border_start'|'border_end'|'arrive'|'pause'|'resume'（v0.12.0：pause/resume 为瞬态控制事件，不入 steps，arrive 收尾按 seq 配对扣减暂停秒数）
    station_code  TEXT REFERENCES stations(code),
    recorded_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    tap_id        TEXT,                    -- v0.10.0 客户端幂等键（每个关键打点一次生成，重试复用）
    UNIQUE (session_id, seq)
);
-- v0.10.0 事件幂等：同 (session_id, tap_id) 只记一次（网络重试/双击不双写；多 NULL 不冲突，兼容旧客户端）
CREATE UNIQUE INDEX IF NOT EXISTS uq_events_session_tap
    ON timer_events (session_id, tap_id)
    WHERE tap_id IS NOT NULL;

-- 2.10a 等车实时信息快照（等车阶段可多次更新）
CREATE TABLE IF NOT EXISTS wait_snapshots (
    id            BIGSERIAL PRIMARY KEY,
    session_id    INT NOT NULL REFERENCES timer_sessions(id) ON DELETE CASCADE,
    value_kind    TEXT NOT NULL,           -- 'stops'（车还有几站）| 'minutes'（轻轨还有几分钟）
    value         SMALLINT NOT NULL,       -- 手动分钟 0..11 连续档（轻轨，须带 station_code）；自动记录存真实站数
    source        TEXT NOT NULL DEFAULT 'manual',  -- 'manual'|'auto_depart'|'auto_wait_start'
    station_code  TEXT REFERENCES stations(code),  -- 自动记录所在的上车站（多段方案分段键）
    recorded_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- 迁移（幂等）：既有库补 source / station_code 列
ALTER TABLE wait_snapshots ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'manual';
ALTER TABLE wait_snapshots ADD COLUMN IF NOT EXISTS station_code TEXT;
CREATE INDEX IF NOT EXISTS idx_wait_snap_session ON wait_snapshots (session_id, recorded_at);
-- 幂等约束（v0.4.2 起按站分段）：同一会话同一自动时刻同一上车站只记一次（manual 可多次）
-- ⚠️ 分键必须含 station_code：多段方案第二段在另一上车站 wait_start 的 auto_wait_start
--    若只按 (session_id, source) 会被第一段的同 source 行 ON CONFLICT 丢弃（v0.4.1 bug）。
DROP INDEX IF EXISTS uq_wait_snap_auto_once;
CREATE UNIQUE INDEX uq_wait_snap_auto_once
    ON wait_snapshots (session_id, source, station_code)
    WHERE source IN ('auto_depart', 'auto_wait_start');

-- 轻轨手动分钟单次幂等（v0.6.0 起）：同一会话同一上车站只记一条，改选分钟 = 覆盖原值
-- 历史 manual 分钟行 station_code 为 NULL → 不满足谓词，建索引前无需去重
CREATE UNIQUE INDEX IF NOT EXISTS uq_wait_snap_manual_min_once
    ON wait_snapshots (session_id, station_code)
    WHERE source = 'manual' AND value_kind = 'minutes' AND station_code IS NOT NULL;

-- 无站手动分钟兜底（v0.9.0）：历史无站垃圾已清；未来 events 接口强制带站，此索引防漏网
CREATE UNIQUE INDEX IF NOT EXISTS uq_wait_snap_manual_min_nostation
    ON wait_snapshots (session_id)
    WHERE source = 'manual' AND value_kind = 'minutes' AND station_code IS NULL;

-- 2.10b 编辑痕迹（人工修正审计：只插入不更新，保留全部原值）
CREATE TABLE IF NOT EXISTS edit_audit (
    id            BIGSERIAL PRIMARY KEY,
    entity        TEXT NOT NULL,           -- 'timer_session' | 'timer_event' | 'wait_snapshot'
    entity_id     BIGINT NOT NULL,
    field         TEXT NOT NULL,           -- 被改字段名
    old_value     TEXT,                    -- 原值
    new_value     TEXT,                    -- 新值
    edited_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 2.10c DSAT 调用日志（风控三保险之一：记账本）
CREATE TABLE IF NOT EXISTS dsat_call_logs (
    id            BIGSERIAL PRIMARY KEY,
    purpose       TEXT NOT NULL,           -- 'timer_grab'|'poll'|'sync'
    route_code    TEXT,
    ok            BOOLEAN NOT NULL,
    http_status   SMALLINT,
    error         TEXT,
    latency_ms    SMALLINT,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_dsat_logs_time ON dsat_call_logs (created_at DESC);

-- 2.11 历史区段耗时统计（定时任务从 timer_sessions/events 汇总）
CREATE TABLE IF NOT EXISTS segment_stats (
    id            SERIAL PRIMARY KEY,
    route_code    TEXT NOT NULL,
    from_station  TEXT NOT NULL,
    to_station    TEXT NOT NULL,
    weekday       SMALLINT NOT NULL,
    time_bucket   TEXT NOT NULL,
    -- v0.22.0：起点站的到站类型——决定该段时长是否含停站时间
    --   stop = 起点是停靠（段时长 = 停站 + 行驶，乘客感知的实际到站间隔）
    --   pass = 起点是甩站（车没停，≈纯行驶时长；两档相减可反推停站耗时）
    --   all  = 两者合并，样本不足时的兜底
    arrive_kind   TEXT NOT NULL DEFAULT 'all',
    avg_minutes   NUMERIC(5,1) NOT NULL,
    p50_minutes   NUMERIC(5,1),
    samples       INT NOT NULL,
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (route_code, from_station, to_station, weekday, time_bucket, arrive_kind)
);

-- 2.12 轻轨 API 站点映射（motransportinfo getLrtStations 站 id ↔ DB 站码）
--     时刻表按 api_id 抓取；UI/业务一律用 DB 码（LRT-xxx），两层不可混淆
CREATE TABLE IF NOT EXISTS lrt_api_stations (
    api_id      TEXT PRIMARY KEY,                  -- 'MUS'（motransportinfo 站 id）
    db_code     TEXT NOT NULL UNIQUE REFERENCES stations(code),  -- 'LRT-MUST'
    name_tc     TEXT NOT NULL,                     -- 官方中文站名
    lat         DOUBLE PRECISION,
    lng         DOUBLE PRECISION,
    note        TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 2.13 轻轨时刻表整表（motransportinfo getMlmTimetable?all=1 全量入库 → 本地算报站）
--     每 站×线路×方向×班别 一行；minutes 原样存 [{hour, minutes[]}]
--     ⚠️ 首末班为「当日 00:00 起分钟偏移」，可 >1440（周五/假期跨午夜收车 25:xx），勿用 TIME
CREATE TABLE IF NOT EXISTS lrt_timetables (
    id          SERIAL PRIMARY KEY,
    api_station TEXT NOT NULL REFERENCES lrt_api_stations(api_id),
    route_no    TEXT NOT NULL,                     -- 'TPL' | 'HQL' | 'SPVL'
    direction   TEXT NOT NULL,                     -- 列车前往终点站代码 'BAR'/'TFT'/'HQ'/'LOT'/'SPV'/'UH'
    day_type    TEXT NOT NULL CHECK (day_type IN ('mon_thurs', 'fri', 'sat_sun_holiday')),
    first_min   SMALLINT NOT NULL,                 -- 首班分钟偏移
    last_min    SMALLINT NOT NULL,                 -- 末班分钟偏移（可 >1440 = 次日凌晨收车）
    minutes     JSONB NOT NULL,                    -- [{hour, minutes[]}] 原样
    fetched_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (api_station, route_no, direction, day_type)
);
CREATE INDEX IF NOT EXISTS idx_lrt_timetables_lookup
    ON lrt_timetables (api_station, route_no, direction, day_type);

-- 2.14 澳门公众假期（班别判定：命中该日 → sat_sun_holiday 班表）
CREATE TABLE IF NOT EXISTS lrt_holidays (
    id            SERIAL PRIMARY KEY,
    holiday_date  DATE NOT NULL,                   -- 假期日
    holiday_code  TEXT NOT NULL,                   -- 'national_day' …
    name_tc       TEXT NOT NULL,                   -- '中華人民共和國國慶日'
    name_pt       TEXT,
    source        TEXT NOT NULL DEFAULT 'macau_gov'
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_lrt_holidays_date ON lrt_holidays (holiday_date);
