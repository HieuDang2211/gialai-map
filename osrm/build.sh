#!/bin/sh
# osrm-extract -> osrm-partition -> osrm-customize (thuật toán MLD) cho MỘT phương tiện.
#   OSRM_NAME    : tên bộ dữ liệu đầu ra (gialai = xe máy, gialai-car = ô tô, gialai-foot = đi bộ)
#   OSRM_PROFILE : file profile Lua (/opt/motorbike.lua, /opt/car.lua, /opt/foot.lua)
# Chỉ chạy lại khi dữ liệu OSM hoặc profile thay đổi (so dấu sha256 trong <name>.osrm.stamp).
set -eu
cd /data
NAME="${OSRM_NAME:-gialai}"
PROFILE="${OSRM_PROFILE:-/opt/motorbike.lua}"
STAMP="$(sha256sum gialai.osm.pbf "$PROFILE" | cut -d' ' -f1 | tr '\n' '-')"

if [ "${1:-}" != "--force" ] && [ -s "$NAME.osrm.mldgr" ] && [ "$(cat "$NAME.osrm.stamp" 2>/dev/null)" = "$STAMP" ]; then
  echo "[osrm-build:$NAME] dữ liệu định tuyến đã cập nhật, bỏ qua"
  exit 0
fi

# osrm-extract đặt tên đầu ra theo file vào -> mỗi phương tiện dùng một liên kết tới cùng file OSM
[ "$NAME" = "gialai" ] || ln -sf gialai.osm.pbf "$NAME.osm.pbf"
rm -f "$NAME".osrm*
echo "[osrm-build:$NAME] extract ($PROFILE)"
osrm-extract -p "$PROFILE" -t "$(nproc)" "$NAME.osm.pbf"
echo "[osrm-build:$NAME] partition"
osrm-partition "$NAME.osrm"
echo "[osrm-build:$NAME] customize"
osrm-customize "$NAME.osrm"
echo "$STAMP" > "$NAME.osrm.stamp"
echo "[osrm-build:$NAME] xong"
