#!/bin/sh
# Tải vietnam-latest.osm.pbf (Geofabrik) và cắt theo khung Gia Lai -> /data/gialai.osm.pbf
# Bỏ qua nếu đã có. Ép tải lại: docker compose run --rm osrm-prep --force
set -eu
cd /data
BBOX="${OSRM_BBOX:-107.0,12.5,109.6,15.0}"
URL="${OSM_EXTRACT_URL:-https://download.geofabrik.de/asia/vietnam-latest.osm.pbf}"

if [ "${1:-}" = "--force" ]; then
  rm -f vietnam-latest.osm.pbf gialai.osm.pbf
fi

if [ -s gialai.osm.pbf ]; then
  echo "[osrm-prep] đã có gialai.osm.pbf ($(du -h gialai.osm.pbf | cut -f1)), bỏ qua"
  exit 0
fi

if [ ! -s vietnam-latest.osm.pbf ]; then
  echo "[osrm-prep] tải $URL"
  wget -q --show-progress --progress=dot:giga -O vietnam-latest.osm.pbf.part "$URL"
  mv vietnam-latest.osm.pbf.part vietnam-latest.osm.pbf
fi

echo "[osrm-prep] cắt theo khung $BBOX"
# complete_ways: giữ trọn các đường cắt ngang mép khung để không đứt mạng lưới
osmium extract --strategy complete_ways -b "$BBOX" vietnam-latest.osm.pbf -o gialai.osm.pbf.part -f pbf --overwrite
mv gialai.osm.pbf.part gialai.osm.pbf
osmium fileinfo gialai.osm.pbf | grep -E 'Bounding|Timestamp|osmosis_replication_timestamp' || true
# bản Việt Nam ~330 MB không cần nữa; giữ lại sẽ đỡ tải khi đổi khung (KEEP_COUNTRY=1)
[ "${KEEP_COUNTRY:-0}" = "1" ] || rm -f vietnam-latest.osm.pbf
echo "[osrm-prep] xong: $(du -h gialai.osm.pbf | cut -f1)"
