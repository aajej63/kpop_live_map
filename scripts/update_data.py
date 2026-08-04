#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
每周自动更新 data/concerts.json

数据来源：
  1) data/asia_curated.json      - 人工核实的亚洲真实场次（种子/兜底）
  2) Bandsintown Events API       - 免密钥全球演出数据（覆盖亚洲的关键）
                                    对 data/artists.json 中每个艺人逐个查询
  3) Ticketmaster Discovery API   - 可选增强（若配置 TICKETMASTER_API_KEY）

合并策略：三源合并 → 去重(artist_lower + date + city_lower) → 过滤过期
       → 生成 id → 写 data/concerts.json

任意数据源失败都不会让脚本崩溃，最坏情况下也会用 asia_curated.json 兜底。
"""
import json
import os
import sys
import re
import time
import hashlib
import datetime
import unicodedata
from urllib import request, parse, error

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA_DIR = os.path.join(ROOT, "data")

# ---------------- Ticketmaster ----------------
TM_API_KEY = os.environ.get("TICKETMASTER_API_KEY", "").strip()
TM_ENDPOINT = "https://app.ticketmaster.com/discovery/v2/events.json"
TM_COUNTRY_CODES = ["US", "SG", "HK", "PH", "TH", "MY", "ID", "JP", "AU"]

CODE_TO_REGION = {
    "US": "USA", "SG": "Singapore", "HK": "HongKong", "PH": "Philippines",
    "TH": "Thailand", "MY": "Malaysia", "ID": "Indonesia",
    "JP": "Japan", "KR": "Korea", "AU": "Other",
}
CODE_TO_COUNTRY_NAME = {
    "US": "USA", "SG": "Singapore", "HK": "Hong Kong", "PH": "Philippines",
    "TH": "Thailand", "MY": "Malaysia", "ID": "Indonesia",
    "JP": "Japan", "KR": "Korea", "AU": "Australia",
}

# ---------------- Bandsintown ----------------
BIT_APP_ID = "kpop-live-map"
BIT_ENDPOINT = "https://rest.bandsintown.com/artists/{artist}/events"

# Bandsintown country string → 我们内部 region 枚举
BIT_COUNTRY_TO_REGION = {
    "South Korea": "Korea",
    "Korea, Republic of": "Korea",
    "Korea": "Korea",
    "Japan": "Japan",
    "United States": "USA",
    "USA": "USA",
    "US": "USA",
    "Singapore": "Singapore",
    "Hong Kong": "HongKong",
    "Macau": "Macau",
    "Macao": "Macau",
    "Philippines": "Philippines",
    "Thailand": "Thailand",
    "Malaysia": "Malaysia",
    "Indonesia": "Indonesia",
}
# 我们想保留的 region 集合：亚洲 + USA
KEEP_REGIONS = {"Korea", "Japan", "USA", "Singapore", "HongKong", "Macau",
                "Philippines", "Thailand", "Malaysia", "Indonesia"}

# ---------------- Tiers ----------------
MAJOR = {"BTS", "NCT 127", "aespa", "ITZY", "IVE", "SEVENTEEN", "ENHYPEN",
         "Stray Kids", "TREASURE", "LE SSERAFIM", "BABYMONSTER", "BIGBANG",
         "Monsta X", "MONSTA X", "TWICE", "BLACKPINK", "TXT", "TOMORROW X TOGETHER",
         "NCT DREAM", "Red Velvet", "ATEEZ", "EXO", "SHINee", "Girls' Generation",
         "NewJeans", "(G)I-DLE"}
SOLOIST = {"LISA", "Young K", "CHANYEOL", "Chanyeol", "T.O.P", "LEE YOUNGJI",
           "Lee Young Ji", "Byeon Woo-seok", "Gyubin", "Jennie", "Jisoo",
           "Rosé", "IU", "TAEYEON", "Taeyeon", "V", "Jungkook", "Jung Kook",
           "JIMIN", "Jimin", "J-HOPE", "j-hope", "SUGA", "Agust D", "RM", "Jin",
           "Baekhyun", "Kai", "TAEMIN", "Hwasa", "Jackson Wang", "CL", "SUNMI",
           "CHUNG HA", "Taeyang", "IU", "Crush", "DEAN", "Jay Park",
           "G-DRAGON", "Wonho", "Kai"}


# ---------------- Helpers ----------------
def slugify(s):
    s = unicodedata.normalize("NFKD", s or "").encode("ascii", "ignore").decode()
    s = re.sub(r"[^a-zA-Z0-9]+", "-", s).strip("-").lower()
    return s or "x"


def make_id(artist, city, date, venue):
    base = f"{artist}-{city}-{date}-{venue}"
    h = hashlib.md5(base.encode("utf-8")).hexdigest()[:6]
    return f"{slugify(base)}-{h}"[:80]


def infer_type(name, tour):
    text = f"{name or ''} {tour or ''}".lower()
    if re.search(r"festival|waterbomb|lollapalooza|kcon|a-nation|anation|hallyu|\bfes\b", text):
        return "festival"
    if re.search(r"fan\s*meet|fanmeeting|fan-con|fancon|fan concert", text):
        return "fanmeeting"
    return "concert"


def tier_for(artist, ttype):
    if ttype == "festival":
        return "festival"
    if artist in MAJOR:
        return "major"
    if artist in SOLOIST:
        return "soloist"
    return "rising"


def http_get_json(url, timeout=20):
    req = request.Request(url, headers={"User-Agent": "kpop-map-updater/1.0"})
    with request.urlopen(req, timeout=timeout) as resp:
        raw = resp.read().decode("utf-8", "ignore")
        return json.loads(raw)


def today_iso():
    return datetime.datetime.utcnow().date().isoformat()


# ---------------- Bandsintown ----------------
def load_artists():
    fp = os.path.join(DATA_DIR, "artists.json")
    if not os.path.exists(fp):
        return []
    try:
        with open(fp, encoding="utf-8") as f:
            arr = json.load(f)
        return [a for a in arr if isinstance(a, str) and a.strip()]
    except Exception as e:
        print(f"[BIT] load artists.json failed: {e}")
        return []


def _bit_offer_url(event):
    offers = event.get("offers") or []
    # 优先带 Tickets 的
    for o in offers:
        if (o.get("type") or "").lower() == "tickets" and o.get("url"):
            return o["url"]
    for o in offers:
        if o.get("url"):
            return o["url"]
    return event.get("url") or ""


def normalize_bit(event, artist_name):
    dt = event.get("datetime") or ""
    if not dt:
        return None
    date = dt.split("T", 1)[0]
    venue = event.get("venue") or {}
    country = (venue.get("country") or "").strip()
    region = BIT_COUNTRY_TO_REGION.get(country)
    if region is None:
        return None  # 丢弃欧洲/南美/大洋洲等
    if region not in KEEP_REGIONS:
        return None

    city = (venue.get("city") or "").strip()
    venue_name = (venue.get("name") or "").strip()
    try:
        lat = float(venue.get("latitude") or 0)
    except (TypeError, ValueError):
        lat = 0.0
    try:
        lng = float(venue.get("longitude") or 0)
    except (TypeError, ValueError):
        lng = 0.0
    if lat == 0 and lng == 0:
        return None

    title = (event.get("title") or "").strip()
    ticket_url = _bit_offer_url(event)
    source = event.get("url") or ticket_url

    ttype = infer_type(title, "")
    tier = tier_for(artist_name, ttype)

    return {
        "id": make_id(artist_name, city, date, venue_name),
        "artist": artist_name,
        "tour": title,
        "type": ttype,
        "tier": tier,
        "date": date,
        "endDate": date,
        "time": "",
        "venue": venue_name,
        "city": city,
        "country": country,
        "region": region,
        "lat": lat,
        "lng": lng,
        "status": "on_sale",
        "platforms": [{
            "key": "bandsintown",
            "name": "购票",
            "region": region,
            "color": "#00b4b3",
            "url": ticket_url or source,
        }] if (ticket_url or source) else [],
        "source": source,
        "poster": "",
        "note": "",
    }


def fetch_bandsintown():
    artists = load_artists()
    if not artists:
        print("[BIT] artists.json empty, skip.")
        return []

    out = []
    today = today_iso()
    ok, fail = 0, 0
    for i, name in enumerate(artists):
        # URL 需要转义（Bandsintown 支持 "(G)I-DLE" 这类，但要 percent encode）
        artist_path = parse.quote(name, safe="")
        url = f"{BIT_ENDPOINT.format(artist=artist_path)}?app_id={parse.quote(BIT_APP_ID)}&date=upcoming"
        try:
            data = http_get_json(url, timeout=15)
        except Exception as e:
            fail += 1
            print(f"[BIT] {name}: {e}")
            time.sleep(0.3)
            continue

        if not isinstance(data, list):
            # Bandsintown 找不到时可能返回 {"errors": [...]}
            time.sleep(0.3)
            continue

        for ev in data:
            try:
                item = normalize_bit(ev, name)
            except Exception as e:
                print(f"[BIT] normalize error {name}: {e}")
                continue
            if not item:
                continue
            if item["date"] < today:
                continue
            out.append(item)
        ok += 1
        time.sleep(0.3)

    print(f"[BIT] artists queried ok={ok} fail={fail}, events collected={len(out)}")
    return out


# ---------------- Ticketmaster ----------------
def fetch_ticketmaster():
    if not TM_API_KEY:
        print("[TM] No TICKETMASTER_API_KEY, skip.")
        return []

    all_events = []
    today = today_iso()
    for code in TM_COUNTRY_CODES:
        for page in range(2):
            params = {
                "apikey": TM_API_KEY,
                "classificationName": "K-Pop",
                "countryCode": code,
                "size": "100",
                "page": str(page),
                "sort": "date,asc",
                "startDateTime": f"{today}T00:00:00Z",
            }
            url = f"{TM_ENDPOINT}?{parse.urlencode(params)}"
            try:
                data = http_get_json(url, timeout=25)
            except Exception as e:
                print(f"[TM] fetch failed {code} p{page}: {e}")
                break

            events = (data.get("_embedded") or {}).get("events", []) or []
            if not events:
                break
            for ev in events:
                try:
                    x = normalize_tm(ev, code)
                    if x:
                        all_events.append(x)
                except Exception as e:
                    print(f"[TM] normalize error: {e}")
                    continue
            if page + 1 >= (data.get("page") or {}).get("totalPages", 0):
                break
    print(f"[TM] collected {len(all_events)} events")
    return all_events


def normalize_tm(ev, code):
    name = (ev.get("name") or "").strip()
    if not name:
        return None
    date = (ev.get("dates") or {}).get("start", {}).get("localDate") or ""
    if not date:
        return None

    venue_obj = ((ev.get("_embedded") or {}).get("venues") or [{}])[0]
    venue = venue_obj.get("name") or ""
    city = ((venue_obj.get("city") or {}).get("name")) or ""
    try:
        lat = float(((venue_obj.get("location") or {}).get("latitude") or 0) or 0)
        lng = float(((venue_obj.get("location") or {}).get("longitude") or 0) or 0)
    except (TypeError, ValueError):
        lat, lng = 0.0, 0.0

    attractions = (ev.get("_embedded") or {}).get("attractions") or []
    artist = (attractions[0].get("name") if attractions else name) or name

    url = ev.get("url") or ""
    status_raw = ((ev.get("dates") or {}).get("status") or {}).get("code", "")
    status_map = {
        "onsale": "on_sale",
        "offsale": "sold_out",
        "cancelled": "sold_out",
        "postponed": "announced",
        "rescheduled": "announced",
    }
    status = status_map.get(status_raw, "on_sale")

    ttype = infer_type(name, "")
    tier = tier_for(artist, ttype)

    concert = {
        "id": make_id(artist, city, date, venue),
        "artist": artist,
        "tour": name,
        "type": ttype,
        "tier": tier,
        "date": date,
        "endDate": date,
        "time": (ev.get("dates") or {}).get("start", {}).get("localTime") or "",
        "venue": venue,
        "city": city,
        "country": CODE_TO_COUNTRY_NAME.get(code, code),
        "region": CODE_TO_REGION.get(code, "Other"),
        "lat": lat,
        "lng": lng,
        "status": status,
        "platforms": [{
            "key": "ticketmaster",
            "name": "Ticketmaster",
            "region": CODE_TO_REGION.get(code, "Other"),
            "color": "#026cdf",
            "url": url,
        }],
        "source": url,
        "poster": "#026cdf",
        "note": "",
    }
    if concert["lat"] == 0 and concert["lng"] == 0:
        return None
    return concert


# ---------------- Merge / dedupe / filter ----------------
def load_curated():
    fp = os.path.join(DATA_DIR, "asia_curated.json")
    if not os.path.exists(fp):
        return []
    with open(fp, encoding="utf-8") as f:
        return json.load(f)


def dedupe(concerts):
    """去重键: (artist_lower, date, city_lower). curated 优先保留（先加入者胜）。"""
    seen = {}
    order = []
    for c in concerts:
        key = ((c.get("artist") or "").strip().lower(),
               (c.get("date") or "").strip(),
               (c.get("city") or "").strip().lower())
        if key in seen:
            continue
        seen[key] = c
        order.append(key)
    return [seen[k] for k in order]


def filter_future(concerts):
    today = today_iso()
    out = []
    for c in concerts:
        end = c.get("endDate") or c.get("date") or ""
        if end and end < today:
            continue
        out.append(c)
    return out


def ensure_ids(concerts):
    for c in concerts:
        if not c.get("id"):
            c["id"] = make_id(c.get("artist", ""), c.get("city", ""),
                              c.get("date", ""), c.get("venue", ""))
    return concerts


def write_output(concerts, source_counts):
    payload = {
        "updated_at": datetime.datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%SZ"),
        "source_counts": source_counts,
        "count": len(concerts),
        "concerts": concerts,
    }
    out_fp = os.path.join(DATA_DIR, "concerts.json")
    with open(out_fp, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)
    print(f"[OK] wrote {out_fp} · {len(concerts)} concerts · sources={source_counts}")


def main():
    os.makedirs(DATA_DIR, exist_ok=True)
    curated = load_curated()
    print(f"[SEED] curated={len(curated)}")

    try:
        bit = fetch_bandsintown()
    except Exception as e:
        print(f"[BIT] fatal: {e}")
        bit = []

    try:
        tm = fetch_ticketmaster()
    except Exception as e:
        print(f"[TM] fatal: {e}")
        tm = []

    # curated 放在前面 → 遇到冲突时优先保留人工核实数据
    combined = dedupe(curated + bit + tm)
    combined = filter_future(combined)
    combined = ensure_ids(combined)
    combined.sort(key=lambda c: (c.get("date", ""), c.get("artist", "")))

    write_output(combined, {
        "curated": len(curated),
        "bandsintown": len(bit),
        "ticketmaster": len(tm),
    })


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        print(f"[FATAL] {e}", file=sys.stderr)
        # 最终兜底：只用 curated
        try:
            curated = load_curated()
            curated = filter_future(curated)
            curated = ensure_ids(curated)
            write_output(curated, {"curated": len(curated),
                                   "bandsintown": 0,
                                   "ticketmaster": 0})
        except Exception as e2:
            print(f"[FATAL2] {e2}", file=sys.stderr)
            sys.exit(0)
