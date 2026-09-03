-- =============================================================
-- MUST登校 · 数据库建表脚本（对应《数据库设计》v0.2）
-- 15 张表；幂等：DROP IF EXISTS 后重建（生产慎跑，种子数据需重导）
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

-- 2.3 地点↔站点步行耗时（实测值，可被计时器数据刷新）
CREATE TABLE IF NOT EXISTS walk_times (
    id          SERIAL PRIMARY KEY,
    place_id    INT NOT NULL REFERENCES places(id),
    station_code TEXT NOT NULL REFERENCES stations(code),
    minutes     NUMERIC(5,1),              -- NULL = 尚未实测
    source      TEXT NOT NULL DEFAULT 'manual',  -- 'manual' | 'timer'
    measured_at DATE,
    UNIQUE (place_id, station_code)
);

-- 2.4 线路
CREATE TABLE IF NOT EXISTS routes (
    id          SERIAL PRIMARY KEY,
    code        TEXT NOT NULL,             -- '50' | 'LRT-石排湾线'
    kind        TEXT NOT NULL,             -- 'bus' | 'lrt'
    company     TEXT,                      -- '澳巴' | '新福利' | '轻轨'
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
    compare_routes JSONB,                  -- v0.5.0+ /stats 排序用：备选线路 JSON 数组
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
    board_candidates TEXT[],               -- bus 段可选上车站（v0.6.0 去学校 51 系：首项=默认展示）
    alight_candidates TEXT[],              -- bus 段可选下车点（v0.6.0 回宿舍动态下车：末位=强制终点）
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
    crowd_level   SMALLINT,                -- 0空/1正常/2拥挤/3爆满
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

-- 2.10 计时器打点事件
CREATE TABLE IF NOT EXISTS timer_events (
    id            BIGSERIAL PRIMARY KEY,
    session_id    INT NOT NULL REFERENCES timer_sessions(id) ON DELETE CASCADE,
    seq           INT NOT NULL,
    event_type    TEXT NOT NULL,           -- 'depart'|'wait_start'|'missed'|'board'|'station_arrive'|'alight'|'border_start'|'border_end'|'arrive'
    station_code  TEXT REFERENCES stations(code),
    recorded_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (session_id, seq)
);

-- 2.10a 等车实时信息快照（等车阶段可多次更新）
CREATE TABLE IF NOT EXISTS wait_snapshots (
    id            BIGSERIAL PRIMARY KEY,
    session_id    INT NOT NULL REFERENCES timer_sessions(id) ON DELETE CASCADE,
    value_kind    TEXT NOT NULL,           -- 'stops'（车还有几站）| 'minutes'（轻轨还有几分钟）
    value         SMALLINT NOT NULL,       -- 手动 10 表示 10+；自动记录存真实站数（2026-09-03 起）
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
    avg_minutes   NUMERIC(5,1) NOT NULL,
    p50_minutes   NUMERIC(5,1),
    samples       INT NOT NULL,
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (route_code, from_station, to_station, weekday, time_bucket)
);

-- 2.12 轻轨班次（若仅拿到静态间隔，改存 headway）
CREATE TABLE IF NOT EXISTS lrt_schedules (
    id            SERIAL PRIMARY KEY,
    line_code     TEXT NOT NULL,           -- 'LRT-石排湾线'
    station_code  TEXT NOT NULL,
    direction     TEXT NOT NULL,
    depart_time   TIME,                    -- 具体班次时刻（若公布）
    headway_min   NUMERIC(4,1),            -- 或班次间隔（分钟）
    valid_days    TEXT NOT NULL DEFAULT 'all'
);
