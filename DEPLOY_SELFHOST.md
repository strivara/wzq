# 五子棋 · 自托管部署手册（部署到自己的服务器 www.zigushi.com）

目标：把联机五子棋真正跑在你自己的腾讯云服务器（公网 IP `122.51.60.242`）上，
通过域名 `wzq.zigushi.com` 访问，访问 `https://wzq.zigushi.com/multi` 即可联机对战。

> 说明：纯上传 HTML 只能玩「人机对战」单机版；「联机对战」必须有 Node 进程常驻 + 反向代理，
> 所以下面是一套完整流程。所有命令在**服务器上**执行（先 `ssh root@122.51.60.242`）。

---

## 第 1 步：准备目录并上传 7 个文件
在服务器上建目录（路径随意，下面以 `/var/www/gomoku` 为例）：
```bash
sudo mkdir -p /var/www/gomoku
```
用 `scp` / FTP / 宝塔面板 把本地 `gomoku/` 里的这 7 个文件上传到 `/var/www/gomoku/`：
```
server.js  multiplayer.html  index.html  package.json  Procfile  railway.json  render.yaml
```

## 第 2 步：确认 Node 已安装（>=16）
```bash
node -v
```
- 已有且版本 >=16 → 跳到第 3 步。
- 没装 / 版本太低，按系统装：
  - Ubuntu/Debian：`sudo apt update && sudo apt install -y nodejs npm`
  - CentOS：`sudo dnf install -y nodejs` 或用 `nvm` 安装 LTS。

本项目**无任何第三方依赖**，`node server.js` 直接能跑，无需 `npm install`。

## 第 3 步：用进程管理器保活（二选一）

### 方案 A：systemd（推荐，开机自启）
把仓库里的 `deploy/gomoku.service` 上传到 `/etc/systemd/system/gomoku.service`，
确认文件里 `User` / `WorkingDirectory` / `ExecStart` 路径正确，然后：
```bash
sudo systemctl daemon-reload
sudo systemctl enable --now gomoku
systemctl status gomoku      # 应显示 active (running)
curl 127.0.0.1:3201/multi   # 应返回 HTML
```

### 方案 B：pm2（更简单，命令式）
```bash
sudo npm i -g pm2
cd /var/www/gomoku
pm2 start server.js --name gomoku
pm2 save
pm2 startup                 # 按提示执行它打印的那条命令，实现开机自启
```

## 第 4 步：Nginx 反向代理（含 WebSocket）
把仓库里的 `deploy/nginx-wzq.conf` 上传到 `/etc/nginx/conf.d/wzq.zigushi.com.conf`，
然后：
```bash
sudo nginx -t               # 语法检查，应显示 ok
sudo systemctl reload nginx
```
（若你服务器用的是 Apache 而非 Nginx，告诉我，我给你 Apache 的等价配置。）

## 第 5 步：DNS 解析
去你管理 `zigushi.com` 的 DNS 后台，新增一条记录：
```
类型: A
主机名/名称: wzq
值/指向: 122.51.60.242
TTL: 默认
```
等几分钟生效（可用 `nslookup wzq.zigushi.com` 验证）。

## 第 6 步：HTTPS 证书（浏览器联机必须用 wss）
```bash
sudo apt install -y certbot python3-certbot-nginx   # CentOS 用 certbot nginx 插件
sudo certbot --nginx -d wzq.zigushi.com
```
证书会自动续期。完成后访问 `https://wzq.zigushi.com/multi` 即可。

---

## 验证清单
- [ ] `curl 127.0.0.1:3201/multi` 在服务器上返回 HTML
- [ ] `systemctl status gomoku`（或 `pm2 status`）显示运行中
- [ ] `nslookup wzq.zigushi.com` 解析到 122.51.60.242
- [ ] 浏览器打开 `https://wzq.zigushi.com/multi`，两人填同房间号能联机

---

## 常见问题
- **只想放单机版（人机对战）**：不需要 Node/代理，直接把 `index.html` 传到网站根目录，
  用 `https://www.zigushi.com/index.html` 打开即可。
- **想用 `/wzq` 路径而不是子域名**：路径方案需要改写 `server.js` 支持基路径，较麻烦；
  子域名方案零改代码，强烈推荐。需要路径方案告诉我，我帮你改 server.js。
- **Nginx 报 502**：多半是 Node 没起来，查 `systemctl status gomoku` / `journalctl -u gomoku`。
- **WebSocket 连不上**：确认 `nginx-wzq.conf` 里的 `Upgrade` / `Connection` 两行已加，且 reload 了 Nginx。

---

## 宝塔面板用户专属步骤（更省事，推荐）
如果你用 **宝塔** 管理 122.51.60.242，几乎不用手写 Nginx / systemd 配置：

### A. 上传文件
宝塔 → 文件 → 进入 `/var/www/`（没有就新建 `gomoku` 文件夹）→ 把 7 个文件上传进去。

### B. 启动 Node（二选一）
**方式 1：宝塔 Node.js 管理器（最省心）**
1. 软件商店 → 安装「Node.js 版本管理器」（已装则跳过）
2. 打开它 → 项目 → 添加项目：
   - 项目目录：`/var/www/gomoku`
   - 启动文件 / 入口：`server.js`
   - 端口：`3201`
   - 启动命令：`node server.js`
3. 保存并启动，确认状态为「运行中」。

**方式 2：SSH + pm2**
```bash
npm i -g pm2
cd /var/www/gomoku && pm2 start server.js --name gomoku && pm2 save
```

### C. 添加站点 + 反代（含 WebSocket）
1. 宝塔 → 网站 → 添加站点：域名填 `wzq.zigushi.com`，其他默认，提交。
2. 点该站点 → 反向代理 → 添加反向代理：
   - 代理名称：gomoku
   - 目标 URL：`http://127.0.0.1:3201`
   - **勾选「启用 WebSocket 支持」**
   - 提交。

### D. 证书
站点 → SSL → Let's Encrypt → 勾选 `wzq.zigushi.com` → 申请并强制 HTTPS。

### E. DNS
去 DNSPod / 腾讯云（或你的域名商）加 A 记录：`wzq → 122.51.60.242`。

完成后访问 `https://wzq.zigushi.com/multi` 即可联机。
