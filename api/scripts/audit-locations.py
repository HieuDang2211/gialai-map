"""Kiểm tra toạ độ địa điểm bằng cách đối chiếu với OpenStreetMap (Nominatim).

Chạy trên máy:  python -I -X utf8 api/scripts/audit-locations.py <places.json> <report.json>
  places.json: [{id, name, address, lng, lat, area}, ...] (xuất từ bảng locations)

Tuân thủ chính sách Nominatim: <= 1 truy vấn/giây, User-Agent nhận diện được, chỉ chạy thủ công khi cần.
Kết quả chỉ là ĐỀ XUẤT; việc áp dụng nằm ở data/corrections/locations.json (được seed.js đọc).
"""
import difflib
import json
import math
import sys
import time
import unicodedata
import urllib.parse
import urllib.request

UA = 'gialai-map-student-project/0.1 (Duy Tan University; location audit)'
VIEWBOX = '107.0,15.0,109.6,12.5'  # trái,trên,phải,dưới (Gia Lai)
GENERIC = {'quan', 'nha', 'hang', 'khach', 'san', 'cafe', 'ca', 'phe', 'cho', 'chua', 'gia', 'lai', 'pleiku', 'tp', 'thanh', 'pho', 'hotel'}


def norm(s):
    s = unicodedata.normalize('NFD', s or '').replace('đ', 'd').replace('Đ', 'D')
    s = ''.join(ch for ch in s if unicodedata.category(ch) != 'Mn').lower()
    return ' '.join(''.join(ch if ch.isalnum() else ' ' for ch in s).split())


def similarity(a, b):
    a, b = norm(a), norm(b)
    if not a or not b:
        return 0.0
    ratio = difflib.SequenceMatcher(None, a, b).ratio()
    # tên ngắn nằm gọn trong tên dài ("Thác 7 Tầng" ⊂ "Thác 7 Tầng Kon Chiêng") -> coi là khớp tốt
    ta, tb = set(a.split()) - GENERIC, set(b.split()) - GENERIC
    contain = len(ta & tb) / max(1, min(len(ta), len(tb))) if ta and tb else 0
    return max(ratio, 0.9 * contain if min(len(ta), len(tb)) >= 1 else 0)


def haversine(lng1, lat1, lng2, lat2):
    r = 6371000
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = p2 - p1, math.radians(lng2 - lng1)
    h = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(h))


last = 0.0


def nominatim(q):
    global last
    wait = 1.1 - (time.time() - last)
    if wait > 0:
        time.sleep(wait)
    last = time.time()
    qs = urllib.parse.urlencode({'q': q, 'format': 'jsonv2', 'limit': 5, 'countrycodes': 'vn',
                                 'viewbox': VIEWBOX, 'bounded': 1, 'accept-language': 'vi', 'namedetails': 1})
    req = urllib.request.Request(f'https://nominatim.openstreetmap.org/search?{qs}', headers={'User-Agent': UA})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.load(r)


def best_match(place):
    candidates = []
    for q in (place['name'], f"{place['name']}, Gia Lai"):
        for hit in nominatim(q):
            names = [hit.get('name') or ''] + list((hit.get('namedetails') or {}).values())
            sim = max(similarity(place['name'], n) for n in names if n) if any(names) else 0
            candidates.append({
                'sim': round(sim, 2),
                'lng': float(hit['lon']), 'lat': float(hit['lat']),
                'osm': f"{hit['osm_type']}/{hit['osm_id']}",
                'kind': f"{hit.get('category')}/{hit.get('type')}",
                'label': hit.get('display_name', '')[:140],
            })
        if any(c['sim'] >= 0.8 for c in candidates):
            break
    if not candidates:
        return None
    return max(candidates, key=lambda c: c['sim'])


def main(src, out):
    places = json.load(open(src, encoding='utf-8'))
    report = []
    for i, p in enumerate(places, 1):
        try:
            m = best_match(p)
        except Exception as e:  # mạng chập chờn: ghi lại, chạy tiếp
            m = {'error': str(e)}
        row = {'id': p['id'], 'name': p['name'], 'address': p.get('address'), 'area': p.get('area'),
               'current': [p['lng'], p['lat']], 'match': m}
        if m and 'lng' in m:
            row['distance_m'] = round(haversine(p['lng'], p['lat'], m['lng'], m['lat']))
        report.append(row)
        if i % 20 == 0:
            print(f'{i}/{len(places)}', flush=True)
    json.dump(report, open(out, 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
    good = [r for r in report if r.get('match') and r['match'].get('sim', 0) >= 0.8]
    far = [r for r in good if r['distance_m'] > 150]
    print(f'Đối chiếu {len(report)} địa điểm: {len(good)} khớp tên trên OSM, {len(far)} lệch > 150 m')


if __name__ == '__main__':
    main(sys.argv[1], sys.argv[2])
