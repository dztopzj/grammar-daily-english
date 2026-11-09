# 小学英语语法 · 每日五题（云同步 + 在线题库版）

单文件前端应用 + 零依赖 Node.js 后端。部署一个服务即可同时获得：

- 📝 练习应用（`/` 直接访问，多账号、学习日历、错题本、听读跟读）
- ☁️ 云同步 API（多设备共享同一份数据）
- 🌐 在线题库抓取（自动从 first-english.org 抓取并转换为选择题）

## 目录结构

```
server/
  server.js          # 后端：API + 静态托管 public/ + 在线题库抓取
  package.json
  public/index.html  # 前端应用（由根目录「英语语法每日五题.html」同步而来）
deploy/index.html    # 纯静态版本（无后端时用）
```

## 本地运行

```bash
cd server
node server.js            # 默认端口 8787
# 或：PORT=3000 node server.js
```

打开 http://localhost:8787 即为完整应用。

## Render 免费层上线（推荐）

1. 把本仓库推送到 GitHub
2. render.com → New → **Web Service** → 选择仓库，Root Directory 填 `server`
3. Runtime：Node；Build command 留空；Start command：`node server.js`
4. 环境变量：`TOKEN` = 你自定义的口令（可选，用于 API 防护）
5. 部署完成后访问 `https://<你的服务名>.onrender.com`

## 环境变量

| 变量 | 说明 | 默认 |
|---|---|---|
| `PORT` | 监听端口 | 8787（Render 自动注入） |
| `TOKEN` | API 口令；设置后所有 `/api/*` 请求需带 `x-token` 头或 `?token=` | 不校验 |
| `DATA_DIR` | 数据目录 | `server/data` |

## 多设备共享数据

各设备打开应用 → ⚙️ 设置 → ☁️ 云同步：

- API 地址：`https://<你的服务地址>`
- 空间编号：全家统一填同一个（如 `family2026`）
- 口令：与服务器 `TOKEN` 一致

首次连接会把本机数据推上云，其他设备连接后自动合并。

## 免费层须知

- Render 免费实例 15 分钟无访问会休眠，下次打开约 30-50 秒唤醒
- 免费实例磁盘不持久；但应用采用「本地全量 + 打开自动合并回填」策略，数据会自愈
