# K-POP LIVE MAP · 全球 K-pop 演出实时地图

一个**纯静态**的 K-pop 演出可视化站点：Leaflet 世界地图 + 左侧筛选与列表 + 每张卡片直达官方购票页 + 中文购买教程弹窗。

- **亚洲 & 全球场次**：现在**每周自动更新**，由 GitHub Actions 抓取 [Bandsintown](https://rest.bandsintown.com/)（免费全球演出接口，**无需密钥**） + [Ticketmaster](https://developer.ticketmaster.com/) 双源。
- **兜底种子**：`data/asia_curated.json` 中的 44 条人工核实场次，包含 fanclub 抽选、纯本土票务这类小众场，永远打底显示。
- **没有任何编造数据**：所有场次都可点击「购票」跳转到官方页面自行核实。

---

## 🚀 部署到 GitHub Pages（三步）

### 1) 把 `output` 目录里的**所有文件**（包括隐藏的 `.github/`、`.nojekyll`、`data/`）上传到你的 GitHub 仓库根目录

推荐仓库名：`kpop-live-map`。请务必用 "Add file → Upload files" 或 `git push` 上传，**不要漏掉 `.github` 与 `.nojekyll`**。

### 2) 打开 Pages

仓库 → **Settings** → **Pages** →
- **Source**：`Deploy from a branch`
- **Branch**：`main` / `root`（或 `master` / `root`）→ Save

等 1~2 分钟后，Pages 就会给出访问地址（形如 `https://<user>.github.io/<repo>/`）。

### 3) 让每周自动更新跑起来

上传完成后 → **Actions** 页签 → 选择 `Weekly update concerts.json` → **Run workflow** 手动跑一次，看看是否成功。以后**每周一 UTC 03:00**（北京时间周一上午 11:00）会自动触发；工作流会更新 `data/concerts.json` 并 push 回仓库，Pages 会自动重新发布。

> Ticketmaster key 是**可选增强**（欧美/日本部分场次覆盖更全）。不加也能跑，Bandsintown 那一路仍会正常拉数据。如需配置：仓库 → **Settings** → **Secrets and variables** → **Actions** → **New repository secret** → Name `TICKETMASTER_API_KEY`，Secret 填 [Ticketmaster Developer](https://developer.ticketmaster.com/) 的 Consumer Key。

---

## 📂 目录说明

```
.
├── index.html                  # 页面主入口
├── app.js                      # 前端逻辑（Leaflet 地图 + 筛选 + 弹窗）
├── styles.css                  # 样式
├── data.js                     # FALLBACK_CONCERTS（离线兜底数据）
├── tutorials.js                # 各购票平台中文购买教程
├── data/
│   ├── artists.json            # 关注的 K-pop 艺人名单（每周自动查询他们的巡演）
│   ├── asia_curated.json       # 人工核实的亚洲场次（兜底 / 补充小众场）
│   └── concerts.json           # 站点实际加载的数据（由 GitHub Actions 每周更新）
├── scripts/
│   └── update_data.py          # Bandsintown + Ticketmaster + 种子合并脚本
├── .github/
│   └── workflows/
│       └── update-concerts.yml # 每周更新工作流
├── .nojekyll                   # 让 GitHub Pages 不忽略隐藏目录
└── README.md
```

---

## 🎤 想追加 / 减少关注的爱豆？

**只要编辑 `data/artists.json` 加一个或删一个名字即可**，保存 push 之后，下一次每周自动更新时脚本会去 Bandsintown 查该艺人的巡演行程，命中的场次会自动落到地图上。

例如想加入某位新出道爱豆：

```json
[
  "BTS",
  "BLACKPINK",
  "…（原有名单）…",
  "新的爱豆英文名"
]
```

> 使用**英文艺名**（Bandsintown 用英文注册艺人页面）。首字母大小写不敏感，但空格、括号需要与官方一致（如 `(G)I-DLE`、`Girls' Generation`）。

---

## 🔄 数据来源与更新机制

- **Bandsintown（免费、无密钥、覆盖亚洲的关键）**：
  - 每周对 `data/artists.json` 中每位艺人调用 `https://rest.bandsintown.com/artists/{name}/events?app_id=kpop-live-map&date=upcoming`
  - 只保留 region ∈ 韩/日/新/港/澳/菲/台/泰/马/印尼/美 的场次
  - 只保留日期 ≥ 今天(UTC) 的
- **Ticketmaster（欧美/亚太增强，可选）**：
  - 遍历 `US / SG / HK / PH / TH / MY / ID / TW / JP / AU` 拉取 K-Pop classification
  - 未配置 API key 时自动跳过，不会导致工作流失败
- **人工核实种子**：`data/asia_curated.json`，包含 44 条已核实场次（韩国 fanclub 抽选、Interpark/YES24 首发、Weverse 独家等），永远打底显示。
- **合并 & 过滤**：三源合并 → 用 `artist_lower + date + city_lower` 去重（种子优先）→ 过滤 `endDate < 今天` → 生成 id → 写入 `data/concerts.json`。
- **前端加载**：站点优先 `fetch('./data/concerts.json')`，失败则回退到 `data.js` 的 `FALLBACK_CONCERTS`。

### ⚠️ 局限（诚实说明）

Bandsintown 的数据主要来自艺人官方在其平台上主动同步的巡演信息，**部分纯本土 fanclub 抽选场次、韩国综艺公开录制类活动可能不在 Bandsintown 上**。我们已经用 `data/asia_curated.json` 手工补齐了这类小众场；如果你发现有遗漏，可直接编辑该文件（schema 同下）。

---

## 🛠 想手工添加/修改亚洲场次？

编辑 `data/asia_curated.json`：追加一条形如

```json
{
  "id": "自动或自取一个-唯一-slug",
  "artist": "TWICE",
  "tour": "TWICE FIFTH WORLD TOUR",
  "type": "concert",
  "tier": "major",
  "date": "2026-11-08",
  "endDate": "2026-11-09",
  "time": "",
  "venue": "KSPO DOME",
  "city": "Seoul",
  "country": "Korea",
  "region": "Korea",
  "lat": 37.5209,
  "lng": 127.1230,
  "status": "on_sale",
  "platforms": [{
    "key": "yes24",
    "name": "YES24 Ticket",
    "region": "Korea",
    "color": "#00539f",
    "url": "https://ticket.yes24.com/xxx"
  }],
  "source": "https://weverse.io/xxx",
  "poster": "#ff3d9a",
  "note": ""
}
```

保存并 push，下一次自动更新时会自动合并到 `data/concerts.json`。

---

## 🎫 官方购票平台一键入口

页面左下方的「官方购票平台 · 实时查询入口」区块里，列出了各地官方票务的搜索/首页链接：Ticketmaster / Klook · K-pop / SISTIC / Interpark & NOL World / YES24 / Melon Ticket Global / Lawson Ticket / Ticket Pia / Cityline / SM Tickets / tixCraft / ThaiTicketMajor。这些页面由平台自己维护，永远最新。

---

## 常见问题

- **Pages 打开后是白屏？** 大概率是没上传 `.nojekyll` 或漏了 `data/`。请确认仓库根目录下能看到这些文件。
- **Bandsintown 查不到某位小众爱豆？** 那位艺人可能还没在 Bandsintown 建档；用 `asia_curated.json` 手工补一条即可。
- **想更换定时时间？** 修改 `.github/workflows/update-concerts.yml` 中的 `cron` 表达式（当前 `0 3 * * 1` = 每周一 UTC 03:00）。
