"""Xác minh / hiệu chỉnh toạ độ địa điểm bằng dữ liệu OpenStreetMap trên máy (không gọi mạng).

Chạy:
  1) trích dữ liệu tham chiếu từ file OSM của OSRM (xem README) -> data/osm/reference.geojsonseq
  2) xuất địa điểm:  docker compose exec -T db psql ... > places.json   (xem README)
  3) python -I -X utf8 api/scripts/verify-locations.py data/osm/reference.geojsonseq places.json data/corrections/locations.json

Phân loại mỗi địa điểm:
  verified  : có đối tượng OSM cùng tên + cùng loại cách <= 150 m
  corrected : có đối tượng OSM cùng tên + cùng loại, duy nhất, cách 150 m – 15 km -> dùng toạ độ OSM
  suspect   : không có tham chiếu và toạ độ nằm ngoài xã/phường ghi trong nguồn > 1 km
  unverified: không có tham chiếu để đối chiếu
Mục "manual" trong file kết quả (do người kiểm tra ghi) luôn được giữ nguyên và ưu tiên hơn kết quả tự động.
"""
import difflib
import json
import math
import os
import sys
import unicodedata

VERIFIED_M = 150
MAX_FIX_M = 15000

# Loại OSM chấp nhận cho từng danh mục
FAMILY = {
    'cho': ('amenity=marketplace', 'shop=mall'),
    'danh-lam-thang-canh': ('tourism=', 'natural=', 'waterway=waterfall', 'leisure=park', 'leisure=garden', 'water=', 'historic='),
    'dia-diem-check-in': ('tourism=', 'natural=', 'leisure=', 'historic=', 'water=', 'waterway='),
    'dia-danh-van-hoa': ('tourism=museum', 'tourism=attraction', 'historic=', 'amenity=place_of_worship', 'tourism=artwork'),
    'khu-vui-choi': ('tourism=', 'leisure='),
    'nha-hang': ('amenity=restaurant', 'amenity=fast_food', 'amenity=food_court'),
    'quan-ca-phe': ('amenity=cafe', 'amenity=restaurant'),
    'quan-nuoc': ('amenity=cafe', 'amenity=fast_food', 'amenity=bar', 'amenity=pub'),
    'khach-san': ('tourism=hotel', 'tourism=guest_house', 'tourism=motel', 'tourism=apartment'),
    'nha-nghi': ('tourism=guest_house', 'tourism=hotel', 'tourism=motel', 'tourism=hostel'),
    'homestay': ('tourism=guest_house', 'tourism=hotel', 'tourism=hostel', 'tourism=chalet'),
}
# điểm (lối vào, điểm ngắm) tốt hơn tâm đa giác (giữa lòng hồ) cho chỉ đường
POINT_PREFERRED = ('tourism=viewpoint', 'tourism=attraction', 'tourism=information')
GENERIC = {'pleiku', 'gia', 'lai', 'tp', 'thanh', 'pho', 'tinh', 'xa', 'huyen', 'phuong', 'viet', 'nam', 'moi'}
KEYS = ('tourism', 'historic', 'natural', 'waterway', 'amenity', 'water', 'leisure', 'shop')


def norm(s):
    s = unicodedata.normalize('NFD', s or '').replace('đ', 'd').replace('Đ', 'D')
    s = ''.join(c for c in s if unicodedata.category(c) != 'Mn').lower()
    return ' '.join(''.join(c if c.isalnum() else ' ' for c in s).split())


def core(s):
    return ' '.join(w for w in norm(s).split() if w not in GENERIC)


def name_match(a, b):
    """Hai tên chỉ cùng một nơi: giống >= 0.85 hoặc phần lõi (bỏ từ chung chung) trùng khớp."""
    ca, cb = core(a), core(b)
    if len(ca) >= 4 and ca == cb:
        return True
    return difflib.SequenceMatcher(None, norm(a), norm(b)).ratio() >= 0.85


def center(g):
    if g['type'] == 'Point':
        return g['coordinates']
    ring = g['coordinates'][0] if g['type'] == 'Polygon' else g['coordinates'][0][0]
    xs, ys = [c[0] for c in ring], [c[1] for c in ring]
    return [sum(xs) / len(xs), sum(ys) / len(ys)]


def dist(a, b):
    dx = (a[0] - b[0]) * 111320 * math.cos(math.radians(a[1]))
    dy = (a[1] - b[1]) * 110540
    return math.hypot(dx, dy)


def load_reference(path):
    feats = []
    for line in open(path, encoding='utf-8'):
        line = line.strip().lstrip('\x1e')
        if not line:
            continue
        f = json.loads(line)
        p = f['properties']
        names = [n for n in (p.get('name:vi'), p.get('name'), p.get('alt_name'), p.get('old_name')) if n]
        if not names:
            continue
        kind = next((f'{k}={p[k]}' for k in KEYS if k in p), '?')
        feats.append({'names': names, 'kind': kind, 'lnglat': center(f['geometry']),
                      'ref': f"{p.get('@type', 'x')}/{p.get('@id')}", 'polygon': f['geometry']['type'] != 'Point'})
    return feats


def main(ref_path, places_path, out_path):
    feats = load_reference(ref_path)
    places = json.load(open(places_path, encoding='utf-8'))
    manual = {}
    if os.path.exists(out_path):
        manual = json.load(open(out_path, encoding='utf-8')).get('manual', {})

    auto, stats = {}, {}
    for p in places:
        here = [p['lng'], p['lat']]
        fam = FAMILY.get(p['cat'], ())
        cands = []
        for f in feats:
            if fam and not f['kind'].startswith(fam):
                continue
            if any(name_match(p['name'], n) for n in f['names']):
                cands.append({**f, 'd': dist(here, f['lnglat'])})
        exact = norm(p['name'])
        # ưu tiên: trùng tên y hệt -> điểm lối vào/điểm ngắm -> điểm (không phải đa giác) -> gần nhất
        cands.sort(key=lambda c: (all(norm(n) != exact for n in c['names']), c['kind'] not in POINT_PREFERRED, c['polygon'], c['d']))
        near = [c for c in cands if c['d'] <= VERIFIED_M]
        # chỉ dời về ĐIỂM: tâm đa giác của hồ/khu rừng có thể nằm giữa lòng hồ, cách xa lối vào hàng chục km
        inrange = [c for c in cands if c['d'] <= MAX_FIX_M and not c['polygon']]
        # cùng tên ở nhiều nơi cách xa nhau (chuỗi cửa hàng) -> không tự sửa; các điểm trong bán kính 1,5 km = cùng một nơi
        spread = max((dist(a['lnglat'], b['lnglat']) for a in inrange for b in inrange), default=0)

        if near:
            entry = {'status': 'verified', 'ref': near[0]['ref'], 'distance_m': round(near[0]['d'])}
        elif inrange and spread <= 1500:
            c = inrange[0]
            entry = {'status': 'corrected', 'lng': round(c['lnglat'][0], 6), 'lat': round(c['lnglat'][1], 6),
                     'ref': c['ref'], 'kind': c['kind'], 'moved_m': round(c['d']),
                     'from': [round(p['lng'], 6), round(p['lat'], 6)]}
        elif p.get('admin_offset_m', 0) > 1000:
            entry = {'status': 'suspect', 'reason': f"toạ độ cách xã/phường ghi trong nguồn ({p.get('area')}) {round(p['admin_offset_m'] / 1000, 1)} km, không có tham chiếu OSM"}
        else:
            entry = {'status': 'unverified'}
        entry['name'] = p['name']
        auto[p['id']] = entry
        stats[entry['status']] = stats.get(entry['status'], 0) + 1

    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    json.dump({
        'note': 'auto = do verify-locations.py sinh ra (chạy lại sẽ ghi đè). manual = người kiểm tra ghi tay, ưu tiên cao nhất: '
                '{"<id>": {"status": "corrected", "lng": ..., "lat": ..., "note": "..."}} hoặc {"status": "hidden", "note": "không tồn tại"}',
        'reference': 'OpenStreetMap (ODbL) – trích từ data/osrm gialai.osm.pbf',
        'manual': manual,
        'auto': auto,
    }, open(out_path, 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
    print(stats)
    for k, e in auto.items():
        if e['status'] in ('corrected', 'suspect'):
            print(f"{e['status']:9} {e['name'][:40]:40} {e.get('moved_m', '')} {e.get('kind', '')} {e.get('reason', '')}")


if __name__ == '__main__':
    main(*sys.argv[1:4])
