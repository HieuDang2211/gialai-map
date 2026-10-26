-- Lược đồ dữ liệu bản đồ Gia Lai (chạy một lần khi khởi tạo volume Postgres)
CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS unaccent;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Ranh giới tỉnh (sau sáp nhập 2025)
CREATE TABLE province (
  code        int PRIMARY KEY,
  name        text NOT NULL,
  geom        geometry(MultiPolygon, 4326) NOT NULL,
  geom_3857   geometry(MultiPolygon, 3857) NOT NULL,
  mask_3857   geometry(Geometry, 3857)          -- phần "ngoài tỉnh", dùng để làm mờ
);

-- Xã / phường; merged_from giữ tên các đơn vị cũ trước sáp nhập
CREATE TABLE admin_units (
  code          int PRIMARY KEY,               -- mã xã chính thức (vd 23590)
  name          text NOT NULL,
  full_name     text NOT NULL,
  type          text NOT NULL,                 -- 'Xã' | 'Phường'
  province_code int,
  population    int,
  area_km2      numeric,
  density_km2   numeric,
  merged_from   text,
  headquarter   text,
  geom          geometry(MultiPolygon, 4326) NOT NULL,
  geom_3857     geometry(MultiPolygon, 3857) NOT NULL,
  label_3857    geometry(Point, 3857) NOT NULL
);
CREATE INDEX admin_units_geom_3857_idx ON admin_units USING gist (geom_3857);
CREATE INDEX admin_units_geom_idx ON admin_units USING gist (geom);
CREATE INDEX admin_units_label_3857_idx ON admin_units USING gist (label_3857);

CREATE TABLE categories (
  id               uuid PRIMARY KEY,
  slug             text UNIQUE NOT NULL,
  name             text NOT NULL,
  icon             text,
  is_accommodation boolean NOT NULL DEFAULT false,
  sort_order       int NOT NULL DEFAULT 0
);

CREATE TABLE locations (
  fid               serial UNIQUE,              -- id số nguyên cho feature-state trên vector tile
  id                uuid PRIMARY KEY,
  name              text NOT NULL,
  category_id       uuid REFERENCES categories(id),
  admin_code        int REFERENCES admin_units(code),
  short_description text,
  description       text,
  address           text,
  phone             text,
  website           text,
  email             text,
  images            text[] NOT NULL DEFAULT '{}',
  rating            numeric(2,1),
  review_count      int NOT NULL DEFAULT 0,
  popularity        int NOT NULL DEFAULT 0,
  priority          int NOT NULL DEFAULT 0,
  opening_hours     jsonb,
  best_time         jsonb,
  check_in          text,
  check_out         text,
  price_range       text,
  price_refs        jsonb,
  tags              text[] NOT NULL DEFAULT '{}',
  aliases           text[] NOT NULL DEFAULT '{}',
  is_active         boolean NOT NULL DEFAULT true,
  source            text NOT NULL DEFAULT 'gialai-travel',  -- nguồn dữ liệu: gialai-travel | osm | ...
  source_ref        text,                                   -- vd node/123456 (OSM)
  source_license    text,
  brand             text,                                   -- ngân hàng / hãng xăng (điểm dịch vụ)
  location_status   text NOT NULL DEFAULT 'unverified',     -- verified | corrected | unverified | suspect
  location_note     text,
  updated_at        timestamptz NOT NULL DEFAULT now(),
  geom              geometry(Point, 4326) NOT NULL,
  geom_3857         geometry(Point, 3857) NOT NULL
);
CREATE INDEX locations_geom_3857_idx ON locations USING gist (geom_3857);
CREATE INDEX locations_geom_idx ON locations USING gist (geom);
CREATE INDEX locations_geog_idx ON locations USING gist ((geom::geography));
CREATE INDEX locations_category_idx ON locations (category_id);

-- ---------------------------------------------------------------------------
-- Hàm sinh vector tile cho Martin: fn(z, x, y) -> bytea (MVT)
-- ---------------------------------------------------------------------------

-- Ranh giới: lớp communes (polygon), commune_labels (điểm), province (viền), mask (ngoài tỉnh)
CREATE OR REPLACE FUNCTION tiles_boundaries(z integer, x integer, y integer)
RETURNS bytea AS $$
DECLARE
  env  geometry := ST_TileEnvelope(z, x, y);
  -- dung sai đơn giản hoá ~ nửa pixel ở mức zoom hiện tại
  tol  double precision := 156543.03 / (2 ^ z) / 2;
  mvt  bytea;
BEGIN
  SELECT
    coalesce((SELECT ST_AsMVT(q, 'communes', 4096, 'geom', 'id') FROM (
      SELECT a.code AS id, a.name, a.full_name, a.type,
             ST_AsMVTGeom(ST_SimplifyPreserveTopology(a.geom_3857, tol), env, 4096, 16, true) AS geom
      FROM admin_units a
      WHERE z >= 7 AND a.geom_3857 && env
    ) q WHERE q.geom IS NOT NULL), '')
    ||
    coalesce((SELECT ST_AsMVT(q, 'commune_labels', 4096, 'geom', 'id') FROM (
      SELECT a.code AS id, a.name, a.type, a.population,
             ST_AsMVTGeom(a.label_3857, env, 4096, 64, true) AS geom
      FROM admin_units a
      WHERE z >= 9 AND a.label_3857 && ST_Expand(env, 2000)
    ) q WHERE q.geom IS NOT NULL), '')
    ||
    coalesce((SELECT ST_AsMVT(q, 'province', 4096, 'geom') FROM (
      SELECT p.name,
             ST_AsMVTGeom(ST_Boundary(ST_SimplifyPreserveTopology(p.geom_3857, tol)), env, 4096, 16, true) AS geom
      FROM province p WHERE p.geom_3857 && env
    ) q WHERE q.geom IS NOT NULL), '')
    ||
    coalesce((SELECT ST_AsMVT(q, 'mask', 4096, 'geom') FROM (
      SELECT ST_AsMVTGeom(ST_SimplifyPreserveTopology(p.mask_3857, tol), env, 4096, 16, true) AS geom
      FROM province p WHERE p.mask_3857 && env
    ) q WHERE q.geom IS NOT NULL), '')
  INTO mvt;
  RETURN mvt;
END
$$ LANGUAGE plpgsql STABLE PARALLEL SAFE;

-- Địa điểm: chỉ mang các trường cần để vẽ; chi tiết lấy qua API khi người dùng mở
CREATE OR REPLACE FUNCTION tiles_pois(z integer, x integer, y integer)
RETURNS bytea AS $$
  SELECT coalesce(ST_AsMVT(q, 'pois', 4096, 'geom', 'fid'), '')
  FROM (
    SELECT l.fid, l.id::text AS uid, l.name, c.slug AS cat, l.priority, l.rating,
           ST_AsMVTGeom(l.geom_3857, ST_TileEnvelope(z, x, y), 4096, 64, true) AS geom
    FROM locations l
    LEFT JOIN categories c ON c.id = l.category_id
    WHERE l.is_active
      AND l.geom_3857 && ST_Expand(ST_TileEnvelope(z, x, y), 1000)
      -- ở zoom thấp chỉ đưa địa điểm nổi bật để tile nhẹ
      AND (z >= 12 OR l.priority >= 60 OR z >= 10 AND l.priority >= 40)
  ) q WHERE q.geom IS NOT NULL;
$$ LANGUAGE sql STABLE PARALLEL SAFE;
