# Bản đồ số Gia Lai

Bản mẫu (prototype) kết hợp **hạ tầng bản đồ kiểu bando.tphcm.gov.vn** (vector tile, cache, zoom mượt)
với **trải nghiệm tìm kiếm kiểu gialai-travel** (gõ không dấu, gõ sai, gợi ý tức thì, dữ liệu địa điểm phong phú).

## Chạy

Yêu cầu: Docker Desktop.

```bash
docker compose up -d --build
docker compose exec api node scripts/seed.js   # nạp dữ liệu vào PostGIS + Meilisearch (chạy lại bao nhiêu lần cũng được)
```

Mở <http://localhost:8088>.

Phát triển giao diện với hot-reload (stack Docker vẫn chạy):

```bash
cd web && npm install && npm run dev            # http://localhost:5173, /api và /tiles được chuyển sang gateway
```

### Bật ảnh vệ tinh Google

Dùng **Map Tiles API** chính thức (không dùng link tile `mt1.google.com` — vi phạm điều khoản Google).

1. Google Cloud Console: tạo project, bật billing, bật **Map Tiles API**, tạo API key.
2. Giới hạn key: *Application restrictions* → HTTP referrers (vd `http://localhost:8088/*`, domain thật);
   *API restrictions* → chỉ Map Tiles API. Key sẽ lộ ra trình duyệt nên bước này là bắt buộc.
3. Tạo file `.env` cạnh `docker-compose.yml`:
   ```
   GOOGLE_MAPS_API_KEY=AIza...
   ```
4. `docker compose up -d api` rồi bấm **Vệ tinh** trên bản đồ.

Ảnh vệ tinh có kèm tên đường (`satellite` + `layerRoadmap`). Theo chính sách Google: luôn hiện "Google Maps" + chuỗi bản quyền
theo khung nhìn, và **không cache** tile Google (service worker bỏ qua `tile.googleapis.com`).

### Bổ sung lưu trú trung tâm Pleiku cũ (OpenStreetMap)

```bash
node api/scripts/crawl-osm.js                     # Overpass API -> data/raw/osm_lodging_pleiku.json
docker compose exec api node scripts/seed.js      # nạp lại (lọc theo 5 phường, bỏ trùng, ghi nguồn ODbL)
docker compose restart martin && docker compose exec gateway sh -c 'rm -rf /var/cache/nginx/tiles/* && nginx -s reload'
```

5 phường trung tâm TP Pleiku cũ: Pleiku, Diên Hồng, Thống Nhất, Hội Phú, An Phú (`api/scripts/osm.js`).
Lần chạy ngày 16/10/2026: 44 cơ sở từ OSM → 40 nằm trong 5 phường → thêm 39, 1 trùng; tổng lưu trú khu trung tâm 9 → 48.

### Chỉ đường và lộ trình (OSRM tự host, xe máy)

Lần `docker compose up` đầu tiên tự dựng dữ liệu định tuyến (~2–3 phút, phần lớn là tải 330 MB):

1. `osrm-prep` (`osrm/Dockerfile.prep`, `osrm/prepare.sh`): tải `vietnam-latest.osm.pbf` từ Geofabrik,
   cắt theo khung Gia Lai `107.0,12.5,109.6,15.0` bằng `osmium extract` → `gialai.osm.pbf` (~28 MB), xoá bản Việt Nam.
2. `osrm-build` (`osrm/build.sh`): `osrm-extract` (profile `osrm/motorbike.lua`) → `osrm-partition` → `osrm-customize` (MLD).
3. `osrm` (`ghcr.io/project-osrm/osrm-backend:v6.0.0`): `osrm-routed --algorithm mld`, chỉ API nội bộ gọi tới.

Dữ liệu nằm trong volume `osrmdata`. Các lần sau hai bước đầu tự bỏ qua; bước build chỉ chạy lại khi file OSM hoặc profile
đổi (so sha256). Dựng lại:

```bash
# sửa osrm/motorbike.lua rồi:
docker compose up -d osrm-build && docker compose restart osrm
# tải bản OSM mới nhất từ Geofabrik:
docker compose run --rm osrm-prep --force && docker compose up -d osrm-build && docker compose restart osrm
# làm lại từ đầu:
docker compose rm -sf osrm osrm-build osrm-prep && docker volume rm gialai-map_osrmdata && docker compose up -d
```

Profile xe máy (`osrm/motorbike.lua`) sửa từ `car.lua` của OSRM v6: tốc độ trung bình quốc lộ 50, tỉnh lộ 40–45,
đường huyện 35, đường phố/ngõ 25–30, đường đất 15 km/h; thẻ `maxspeed` chỉ được hạ chứ không nâng tốc độ;
không đi cao tốc (cấm xe máy), được đi `highway=track`, lọt cọc chắn/hẻm hẹp; quyền đi xét `motorcycle=*` trước.

API (qua gateway `/api`):

| | |
|---|---|
| `GET /api/route?from=<id\|lng,lat>&to=<id\|lng,lat>` | tuyến 2 điểm, `geometry` GeoJSON, các bước rẽ có câu hướng dẫn tiếng Việt (`osrm-text-instructions`, `vi`) |
| `POST /api/trip {ids, start?, roundtrip?, optimize?, steps?}` | 2–12 địa điểm; `optimize` (mặc định `true`) gọi OSRM `/trip` để sắp lại thứ tự, điểm `start` (mặc định `ids[0]`) luôn đứng đầu; trả về `stops` theo thứ tự đi, `legs` (m, giây), `geometry`, và `baseline` = quãng đường theo thứ tự người dùng chọn |

Kiểm tra với 6 điểm (Bảo tàng Pleiku, Biển Hồ T'Nưng, Chùa Minh Thành, Hàng Thông Trăm Tuổi, Quảng trường Đại Đoàn Kết,
Thác 7 Tầng), xuất phát từ Bảo tàng, không quay về: **45,2 km / 67 phút** sau tối ưu so với **68,2 km / 98 phút**
theo thứ tự nhập (máy chủ demo OSRM với profile ô tô: 45,4 km / 49 phút — quãng đường khớp, thời gian khác vì xe máy chậm hơn).

Giao diện: mở địa điểm → **+ Thêm vào lộ trình**; chip **🧭 Lộ trình** mở danh sách (đổi thứ tự ↑↓, bỏ điểm),
**Tối ưu thứ tự** / **Chỉ đường** (giữ thứ tự) vẽ tuyến trên bản đồ, đánh số điểm dừng, tổng km/thời gian, từng chặng
kèm hướng dẫn rẽ. Chọn giờ khởi hành + thời gian ở mỗi điểm để ước tính giờ đến và cảnh báo nơi có thể đã đóng cửa
(theo `opening_hours`). Lộ trình nằm trên URL (`?trip=id1,id2,…`) nên gửi link được. Nút **Google Maps** là phương án dự phòng.

Không dùng `router.project-osrm.org` trong ứng dụng: máy chủ demo đó chỉ cho thử nghiệm.
Nâng cấp sau: VROOM (khung giờ mở cửa, nhiều ngày) dùng chính OSRM này làm ma trận khoảng cách.

#### Phương tiện: xe máy, ô tô, đi bộ, xe buýt

Mỗi phương tiện là một tiến trình OSRM riêng trên cùng file OSM (`osrm/build.sh` nhận `OSRM_NAME` + `OSRM_PROFILE`):

| Phương tiện | Profile | Dịch vụ | Tham số API |
|---|---|---|---|
| 🛵 Xe máy | `osrm/motorbike.lua` | `osrm` | `mode=motorbike` (mặc định) |
| 🚗 Ô tô | `/opt/car.lua` (có sẵn trong image) | `osrm-car` | `mode=car` |
| 🚶 Đi bộ | `/opt/foot.lua` (có sẵn trong image) | `osrm-foot` | `mode=foot` |
| 🚌 Xe buýt | — | — | `mode=bus` → `501`: **chưa có dữ liệu** |

Cùng 4 điểm trong Pleiku: xe máy 12,3 km / 20 phút, ô tô 12,4 km / 16 phút, đi bộ 12,1 km / 145 phút.
Ô tô nhanh hơn xe máy vì `car.lua` dùng tốc độ mặc định của OSRM; muốn sát thực tế Việt Nam thì hạ tốc độ như đã làm với xe máy.

**Xe buýt**: OpenStreetMap chưa có tuyến buýt nào trong khu vực Pleiku nên không thể tính đường buýt mà không bịa dữ liệu.
Khi có GTFS (tuyến, điểm dừng, giờ chạy) từ đơn vị vận tải/Sở Xây dựng, dùng OpenTripPlanner hoặc thuật toán RAPTOR
(đi bộ tới trạm → buýt → đi bộ) và bật lại nút trong `TripPanel.tsx` (`MODES`).

#### Mô phỏng di chuyển

Sau khi có tuyến, bấm **▶ Mô phỏng di chuyển**: biểu tượng người (🛵 / 🚗 / 🚶) chạy dọc tuyến, mũi tên chỉ hướng,
vệt cam là đoạn đã đi, dừng nhẹ ở mỗi điểm. Thời gian từng đoạn lấy từ OSRM (`annotations=duration`, API trả về
`segmentDurations`) nên đường lớn đi nhanh, đường nhỏ đi chậm. Điều khiển: chạy/tạm dừng, kéo thanh tiến độ, tốc độ ×30–×300
(mặc định ~40 giây cho cả hành trình), **Bám theo** (camera đi theo; tắt sẵn nếu hệ điều hành bật "giảm chuyển động").
Mã: `web/src/simulate.ts`, `web/src/components/SimControls.tsx`.

### Xác minh vị trí địa điểm

Toạ độ trong dữ liệu gialai-travel không đồng đều (nhiều điểm làm tròn 4 chữ số, có nơi lệch hàng km so với địa chỉ).
`api/scripts/verify-locations.py` đối chiếu từng địa điểm với OpenStreetMap trích **ngay trên máy** từ file OSM của OSRM
(không gọi mạng) và ghi `data/corrections/locations.json`; `seed.js` áp dụng khi nạp.

```bash
# 1) trích dữ liệu tham chiếu (điểm du lịch, chợ, quán ăn, khách sạn…) từ file OSM của OSRM
MSYS_NO_PATHCONV=1 docker compose run --rm --no-deps -v "$(pwd)/data/osm:/out" --entrypoint sh osrm-prep -c \
  "osmium tags-filter /data/gialai.osm.pbf nwr/tourism nwr/historic n/natural=waterfall,volcano,peak,cave_entrance nwr/waterway=waterfall nwr/amenity=place_of_worship,marketplace,restaurant,cafe,fast_food,bar,pub,food_court nwr/water nwr/natural=water nwr/leisure=park,garden nwr/shop=mall -O -o /tmp/f.osm.pbf && osmium export /tmp/f.osm.pbf --geometry-types=point,polygon -a type,id -f geojsonseq -O -o /out/reference.geojsonseq"
# 2) xuất địa điểm (xem truy vấn trong lịch sử dự án) -> places.json, rồi:
python -I -X utf8 api/scripts/verify-locations.py data/osm/reference.geojsonseq places.json data/corrections/locations.json
docker compose exec api node scripts/seed.js
```

| Trạng thái | Ý nghĩa | Kết quả (147 địa điểm gialai-travel) |
|---|---|---|
| `verified` | có đối tượng OSM cùng tên, cùng loại trong 150 m | 10 |
| `corrected` | có đối tượng OSM cùng tên, cùng loại, duy nhất, cách 150 m–15 km → dùng toạ độ OSM | 2 (Quảng trường Đại Đoàn Kết −675 m, Biển Hồ Pleiku −4,8 km) |
| `suspect` | không có tham chiếu và toạ độ cách xã/phường ghi trong địa chỉ > 1 km | 7 (Thác 7 Tầng 20 km, Buôn Jun 26 km, Cầu Treo, Đường Thông, Chùa Phật Tích Hùng Vương, Mì Cay Kitachi, Quán ăn sáng Toàn Lộc) |
| `unverified` | OSM không có đối tượng để so | 128 |

Trang chi tiết hiện mức tin cậy ("✓ đã đối chiếu", "⚠ có thể chưa chính xác"…). Không tự dời về tâm đa giác
(hồ, rừng) và không tự sửa khi cùng tên xuất hiện ở nhiều nơi (chuỗi cửa hàng). Người kiểm tra ghi quyết định vào mục
`manual` của `data/corrections/locations.json` (`{"<id>": {"status": "corrected", "lng": …, "lat": …, "note": "…"}}`
hoặc `{"status": "hidden", "note": "không tồn tại"}`); mục này không bị ghi đè khi chạy lại.

#### Báo sai vị trí và trang kiểm tra (`/review`)

128 địa điểm không có đối tượng OSM để so nên cần người xem. Luồng xử lý:

1. **Người dân** mở địa điểm → **📍 Báo sai vị trí** → kéo ghim đỏ (hoặc chạm bản đồ) tới đúng cổng/lối vào, ghi chú tuỳ chọn → *Gửi báo cáo*.
   Có thể tích *“Địa điểm này không tồn tại / đã đóng cửa”* (khi đó bắt buộc ghi chú).
   `POST /api/locations/:id/reports` lưu vào bảng `location_reports` (`pending` / `accepted` / `rejected`). Chống lạm dụng:
   tối đa 5 báo cáo / 10 phút và 20 / ngày cho mỗi IP, điểm phải nằm trong ranh giới tỉnh, cách vị trí hiện tại 10 m – 20 km,
   mỗi IP chỉ một báo cáo đang chờ cho mỗi địa điểm.
2. **Người kiểm tra** vào `http://localhost:8088/review`, nhập mã `REVIEW_TOKEN` (đặt trong `.env`, xem `.env.example`; để trống = tắt trang).
   Hàng chờ gồm địa điểm *nghi ngờ*, *chưa đối chiếu* và mọi địa điểm có báo cáo đang chờ — nghi ngờ trước, rồi theo số báo cáo.
   Bản đồ nhỏ hiện vị trí hiện tại (xanh dương), điểm báo cáo (đỏ), ứng viên OSM gần đó hoặc trùng tên trong 20 km (xanh lá, từ
   `data/osm/reference.geojsonseq`) và điểm chọn (cam, kéo được; bật *Vệ tinh* nếu có key Google). Ba quyết định:
   - **Chấp nhận điểm đã chọn** → mục `manual` `{"status": "corrected", "lng", "lat", "from", "moved_m", "report"|"ref", "note"}`
   - **Vị trí hiện tại đúng** → `{"status": "verified"}`
   - **Ẩn — không tồn tại** → `{"status": "hidden"}` (bỏ khỏi bản đồ và tìm kiếm)

   Báo cáo được chọn thành `accepted`, các báo cáo đang chờ khác của địa điểm thành `rejected` (khi ẩn: báo cáo “không tồn tại” được
   `accepted`). Mỗi quyết định ghi thêm một dòng vào `location_reviews`.
3. **Áp dụng ngay** (`api/src/reports.js`): ghi `data/corrections/locations.json` trước (API mount thư mục này có quyền ghi), rồi
   cập nhật `locations` (toạ độ, xã/phường, trạng thái), tài liệu Meilisearch (`_geo`, `areaCode`, `areaName`; xoá khi ẩn), và
   **xoá tile `pois` đã cache** ở gateway quanh vị trí cũ và mới (`api/src/tilecache.js`: tính mọi tile z0–18 chứa điểm kể cả vùng đệm,
   xoá file `md5("/tiles/pois/z/x/y")` trong volume `tilecache`; nginx dùng `proxy_cache_key $uri`). Martin chạy với
   `cache_size_mb: 0` vì gateway đã là lớp cache. `/api/config` trả `tilesVersion` (= số quyết định) và web gắn `?v=<tilesVersion>`
   vào URL tile để trình duyệt + service worker tải tile mới ở lần mở bản đồ kế tiếp.
4. **Bền vững qua nạp lại**: `seed.js` đọc lại mục `manual` (ưu tiên hơn `auto`); `verify-locations.py` giữ nguyên mục này.
   Bảng `location_reports` / `location_reviews` không có khoá ngoại tới `locations` nên `TRUNCATE ... CASCADE` của seed không xoá chúng.

```bash
# kiểm tra nhanh bằng curl
curl -X POST localhost:8088/api/locations/<id>/reports -H 'content-type: application/json'   -d '{"lng":108.0449,"lat":13.9706,"note":"lối vào cạnh đường Lê Duẩn"}'
curl localhost:8088/api/review/queue -H "Authorization: Bearer $REVIEW_TOKEN"
curl -X POST localhost:8088/api/review/locations/<id>/decision -H "Authorization: Bearer $REVIEW_TOKEN"   -H 'content-type: application/json' -d '{"action":"accept","lng":108.0449,"lat":13.9706,"reportId":1}'
# action khác: {"action":"verify"} | {"action":"hide","note":"không tồn tại"}; bỏ qua một báo cáo: POST /api/review/reports/<id>/reject
```

Sau khi đổi cấu hình lần đầu: `docker compose up -d --build api gateway && docker compose restart martin`.

### Sửa vị trí địa điểm bằng Excel (trừ quán ăn)

```bash
# 1) xuất danh sách cần kiểm tra (xem truy vấn trong script) -> data/templates/sua_vi_tri_dia_diem.xlsx
python -X utf8 api/scripts/make-location-fix-sheet.py places.json data/templates/sua_vi_tri_dia_diem.xlsx
# 2) nhận file đã điền: thử trước rồi ghi vào mục "manual" của data/corrections/locations.json
python -X utf8 api/scripts/apply-location-fixes.py <file_da_dien.xlsx> data/corrections/locations.json --dry-run
python -X utf8 api/scripts/apply-location-fixes.py <file_da_dien.xlsx> data/corrections/locations.json
# 3) nạp + làm mới tile
docker compose exec api node scripts/seed.js
docker compose restart martin && docker compose exec gateway sh -c 'rm -rf /var/cache/nginx/tiles/* && nginx -s reload'
```

Kết quả kiểm tra → trạng thái: Vị trí đúng → `verified`; Sửa vị trí → `corrected` + toạ độ mới; Địa điểm không tồn tại → ẩn;
Đã chuyển đi → `suspect`. Chỉ dòng hợp lệ được nhận (toạ độ trong Gia Lai, có cách xác định, dời ≤ 20 km).
`seed.js` áp mục `manual` lần cuối sau khi nạp mọi nguồn, nên sửa được cả điểm OSM, ngân hàng, khảo sát.

`--safe` (nên dùng): thay đổi lớn **không áp ngay** mà ghi ra `<file>_cho_xac_nhan.xlsx` — báo "không tồn tại" với địa điểm
từ website ngân hàng hoặc OSM, dời > 1 km (trừ dữ liệu gialai-travel), toạ độ mới trùng với địa điểm khác. Ghi chú của người kiểm
tra lưu nội bộ (`reviewNote`), trang chi tiết chỉ hiện một dòng ngắn.

Lần nhập 17/10/2026 (`sua_vi_tri_dia_diem_v2.xlsx`, 526 dòng): áp 226 (179 vị trí đúng, 36 sửa vị trí, 11 ẩn), chờ xác nhận 300
(218 báo không tồn tại trên dữ liệu ngân hàng/OSM, 63 toạ độ mới trùng địa điểm khác, 19 dời > 1 km).
Cùng ngày, người kiểm tra đồng ý toàn bộ → đã áp cả 526 (179 đúng, 118 sửa vị trí, 229 ẩn). Bản trước khi áp:
`data/backups/corrections_truoc_xac_nhan_20261017_1326.json` — muốn hoàn tác, chép đè lên `data/corrections/locations.json` rồi chạy lại seed.
Sau đó xoá thêm 19 điểm sai (12 cây xăng bị dời chồng lên nhau, 7 điểm "nghi sai"), mục `manual` có `source: xoa-du-lieu-sai`.

Tile địa điểm có `?v=<phiên bản>` = băm của (số điểm đang hiện, `max(updated_at)`, số quyết định ở /review) (`tilesVersion()` trong
`api/src/reports.js`): mọi lần seed / sửa vị trí đều đổi phiên bản, trình duyệt và service worker không dùng lại tile cũ
(trước đây chỉ đổi khi duyệt ở /review → ghim hiện ở vị trí cũ, bấm vào bị "nhảy").

### Khảo sát quán ăn TP Pleiku cũ

```bash
# 1) sổ khảo sát (danh sách đi thực địa + phiếu A4) -> data/templates/so_khao_sat_quan_an_pleiku.xlsx
python -X utf8 api/scripts/make-survey-list.py <danh_sach.json> <he_thong.json> data/osm/reference.geojsonseq <wards.json> data/templates/so_khao_sat_quan_an_pleiku.xlsx
# 2) sau khi đi khảo sát: chuyển sổ đã điền -> data/raw/survey_quan_an_pleiku.json
python -X utf8 api/scripts/convert-survey.py data/templates/so_khao_sat_quan_an_pleiku_dakhaosat.xlsx data/templates/so_khao_sat_quan_an_pleiku.xlsx data/raw/survey_quan_an_pleiku.json
# 3) nạp (api/scripts/survey.js) + làm mới tile
docker compose exec api node scripts/seed.js
docker compose restart martin && docker compose exec gateway sh -c 'rm -rf /var/cache/nginx/tiles/* && nginx -s reload'
```

`convert-survey.py … --gps-proof=pending` (mặc định): toạ độ GPS do người khảo sát nhập được dùng để **dời vị trí** nhưng ghi
"chờ đối chiếu file GPX" (`unverified`); chạy lại với `--gps-proof=gpx` sau khi đã đối chiếu file GPX/KML thì mới thành `verified`.
Lần nhập v2 (17/10/2026): cập nhật + dời vị trí 65 quán đã có, thêm 309, ẩn 1; 304 quán chờ đối chiếu GPX, 5 trùng toạ độ.
Bản v1 lưu ở `data/backups/`.

Quy tắc nhập: quán đã có trên bản đồ (cùng tên / tên gần giống, cách < 120 m) được **cập nhật**, không tạo bản trùng;
quán mới thêm với nguồn `survey`; "Đã đóng cửa / Không tìm thấy / Không phải quán ăn" → ẩn nếu đang có; "Đã chuyển địa chỉ" → `suspect`.
Mức tin cậy: `verified` khi toạ độ đo GPS tại chỗ; `unverified` khi toạ độ trong sổ trùng y toạ độ tham khảo (chưa đo độc lập);
`suspect` khi trùng toạ độ với quán khác. Tên người khảo sát không được công khai.

Lần nhập 17/10/2026 (sổ `so_khao_sat_quan_an_pleiku_dakhaosat.xlsx`, 384 dòng): cập nhật 62, thêm 312, ẩn 1, đánh dấu chuyển địa chỉ 1,
bỏ qua 8 → TP Pleiku cũ có 385 quán ăn/cà phê đang hiển thị (trước đó 66). 365/384 toạ độ trùng y toạ độ tham khảo nên phần lớn
ở mức `unverified`; 26 quán `suspect` vì trùng toạ độ. Chưa có SĐT, giờ mở cửa, giá — nhập sau qua `mau_thu_thap_quan_an.xlsx`.

### ATM, ngân hàng, cây xăng, trạm sạc

```bash
node api/scripts/crawl-services.js               # Vietcombank + Agribank (website) + OSM -> data/raw/services_gialai.json
docker compose exec api node scripts/seed.js     # lọc 5 ngân hàng + ranh giới tỉnh, bỏ trùng (api/scripts/services.js)
```

Chỉ giữ ATM/ngân hàng của **Vietcombank, BIDV, Agribank, VietinBank, MB**:

| Ngân hàng | Nguồn | Ghi chú |
|---|---|---|
| Vietcombank | API trang "Mạng lưới" (robots.txt cho phép) | 59 ATM/R-ATM, 25 điểm giao dịch, có giờ giao dịch + SĐT |
| Agribank | file dữ liệu tĩnh của trang "ATM - Chi nhánh" | 65 ATM; chi nhánh phần lớn **không có toạ độ** trên website → bỏ, bù bằng OSM |
| MB | trang bản đồ MB (`/api/getMaps` chặn truy cập tự động 403) → ghi lại khi xem bằng trình duyệt: `data/raw/mb_gialai.json` | 32 ATM/CRM/SmartBank, 7 chi nhánh; cập nhật thủ công |
| BIDV | OpenStreetMap (website có trang chống bot — không vượt qua) | 2 ATM, 8 chi nhánh |
| VietinBank | OpenStreetMap (robots.txt chặn `/api`) | 3 ATM, 4 chi nhánh |

Cây xăng (193) và trạm sạc (3) lấy từ OpenStreetMap trong ranh giới tỉnh. Trạm sạc trên OSM còn rất thiếu.
Các điểm dịch vụ có `priority` 30 nên chỉ hiện từ zoom 12 để không che điểm du lịch.

## Kiến trúc

```
Trình duyệt (React + MapLibre GL, PWA)
  │
  ▼
gateway (nginx :8088) ── cache như CDN, gzip
  ├─ /            web tĩnh (JS/CSS có hash, cache 1 năm)
  ├─ /tiles/*  →  Martin ──► PostGIS     vector tile động: ranh giới xã/phường, mặt nạ ngoài tỉnh, địa điểm
  ├─ /api/*    →  API (Fastify)
  │                 ├─ /api/search        → Meilisearch (không dấu, chịu lỗi gõ, lọc bán kính, facet)
  │                 ├─ /api/locations/:id → PostGIS (chi tiết + địa điểm lân cận bằng ST_DWithin)
  │                 ├─ /api/areas/:code   → PostGIS (dân số, diện tích, sáp nhập từ…)
  │                 ├─ /api/locations/:id/reports, /api/review/* → PostGIS + data/corrections + xoá cache tile
  │                 └─ /api/route, /api/trip → OSRM (MLD, profile xe máy, dữ liệu OSM cắt theo Gia Lai)
  └─ /img/*    →  imgproxy (thu nhỏ + WebP, chỉ cho phép ảnh từ nguồn dữ liệu)
Bản đồ nền: vector tile OpenFreeMap (OpenMapTiles).
```

| Thư mục | Nội dung |
|---|---|
| `db/init/01_schema.sql` | Lược đồ PostGIS + hàm sinh tile `tiles_boundaries`, `tiles_pois` |
| `martin/martin.yaml` | Khai báo nguồn tile cho Martin |
| `api/scripts/seed.js` | ETL: `data/raw/*.json` → PostGIS → chỉ mục Meilisearch (cấu hình xếp hạng, từ đồng nghĩa) |
| `api/src/server.js` | API tìm kiếm / chi tiết |
| `api/src/routing.js` | API chỉ đường / lộ trình (proxy OSRM, kiểm tra id trong PostGIS, tối đa 12 điểm) |
| `osrm/` | Tải + cắt OSM (`prepare.sh`), dựng MLD (`build.sh`), profile xe máy (`motorbike.lua`) |
| `web/src` | Giao diện: `App.tsx`, `map.ts` (style + lớp), `simulate.ts` (mô phỏng di chuyển), `components/` (`TripPanel.tsx`: lộ trình) |
| `web/nginx.conf` | Gateway: cache tile, ảnh, API |

## Giao diện & cá nhân hoá

- **Bố cục kiểu Google Maps**: máy tính có cột điều hướng trái (Khám phá · Đã lưu · Gần đây · Lộ trình) + thanh bên
  cao toàn màn hình, nút `‹ / ›` ở mép để ẩn/hiện; di động dùng thanh điều hướng dưới + bottom sheet 3 mức
  (nửa màn hình → toàn màn hình → chỉ tiêu đề).
- **Thanh lọc danh mục** (`CategoryBar.tsx`): nằm ngang phía trên bản đồ (máy tính), có mũi tên + mép mờ khi còn chip bị che,
  lăn chuột để cuộn ngang, nút **Tất cả** luôn hiện → màn Khám phá (danh mục theo nhóm Ăn uống / Tham quan / Lưu trú).
- **Cá nhân hoá** (`personalize.ts`, chỉ lưu trong `localStorage` của trình duyệt, không gửi lên máy chủ):
  ghim tối đa 6 danh mục lên đầu; danh mục hay dùng tự xếp lên trước (điểm giảm dần, nửa đời 14 ngày);
  địa điểm **Đã lưu** (♡ Lưu) và **Gần đây** (20 địa điểm đã xem). Có nút "Đặt lại" và "Xoá lịch sử".

## Những gì đã đo được (máy local)

| | Trước (gialai-travel) | Bản này |
|---|---|---|
| Ranh giới xã/phường | 1 file GeoJSON 18,5 MB, ~4,3 s | tile 0,3–9 KB, cache tại gateway |
| Ảnh thumbnail | ảnh gốc ~400–550 KB | WebP ~3 KB |
| Tìm kiếm | 55–150 ms | 1–4 ms xử lý trong Meilisearch |
| Lọc bán kính | không thấy truy vấn server | `_geoRadius` trên server |
| JS trang bản đồ | — | ~273 KB gzip (MapLibre 218 KB, chunk riêng) |

## Lưu ý

- Dữ liệu từ OpenStreetMap (`source = 'osm'`) phải giữ ghi nguồn "© OpenStreetMap contributors" (ODbL); trang chi tiết đã hiển thị.
  Thông tin OSM thường thiếu (chỉ ~1/4 có địa chỉ, rất ít số điện thoại) → cần xác minh/bổ sung trước khi công bố.
- **Dữ liệu mẫu** trong `data/raw` lấy từ API công khai của gialai-travel (`apigl.sns.org.vn`), ảnh vẫn tải từ máy chủ đó.
  Chỉ dùng cho mục đích học tập; khi triển khai thật cần dữ liệu và ảnh của đơn vị mình.
- **Bản đồ nền** đang dùng OpenFreeMap. Khi triển khai: tự host PMTiles (cắt vùng Việt Nam/Gia Lai) trên CDN.
- `MEILI_MASTER_KEY` và mật khẩu Postgres trong `docker-compose.yml` chỉ dành cho máy dev — đổi trước khi đưa lên server.
- imgproxy đang chạy chế độ `insecure` (không ký URL), chỉ giới hạn nguồn ảnh; production nên bật `IMGPROXY_KEY/SALT`.
- Dữ liệu đường đi từ OpenStreetMap (ODbL): bản đồ nền đã ghi nguồn OSM; chất lượng tuyến phụ thuộc mức đầy đủ của đường ở Gia Lai trên OSM.
- Service worker chỉ đăng ký ở bản build (`npm run build`), cần HTTPS hoặc `localhost`.
