# Windows 与 Linux 部署

运行时需要 Node.js 24+。Windows 默认使用已安装的 Edge；Linux 默认使用 Playwright Chromium，无 DISPLAY 时默认无界面运行。两者共用同一套 Node、SQLite 和网页代码。

## 两端共用的启动与停止

需要 Node.js 24+。Linux 先安装依赖及 Chromium，使用普通服务用户运行：

```sh
npm ci
npx playwright install --with-deps chromium
sh start.sh
```

Windows 使用 `./start.ps1`，Linux 使用 `sh start.sh`；两者调用同一个 Node 启动入口，默认只监听本机 `127.0.0.1:4318`。可共用 `npm start`。运行期间退出或睡眠会停止监测。

| 操作 | Windows PowerShell | Linux shell | 通用 npm |
| --- | --- | --- | --- |
| 默认本机启动 | `./start.ps1` | `sh start.sh` | `npm start` |
| 局域网启动 | `./start.ps1 -Lan` | `sh start.sh --lan` | `npm start -- --lan` |
| 强制仅本机 | `./start.ps1 -Local` | `sh start.sh --local` | `npm start -- --local` |
| 正常停止 | `./stop.ps1` | `sh stop.sh` | `node scripts/stop-server.ts` |

两端保留相同的账号保存、只读扫描、默认表单、通知队列、飞书发送、浏览器重启、人工接管及普通浏览器验证流程。显式命令行选项优先于 PITCH_HOST；无选项时读取 PITCH_HOST，未设置则仅本机。停止脚本读取服务数据目录内的 server.json，支持自定义 PORT；启动和停止时使用同一个 PITCH_DATA_DIR。

## 仅局域网访问

启动前会用实际扫描器的专用浏览器检查运行环境，成功后复用同一上下文；缺少浏览器、系统库或启动环境异常时会退出并打印修复方法，不启动场地重试循环。显式设置 `PITCH_START_PAUSED=1` 时跳过浏览器检查并保持网站监测暂停，适合只打开控制台配置；该选项不会关闭已经启用的飞书通知。

如果日志出现 `Executable doesn't exist ... chromium_headless_shell-...`，表示当前 Playwright 版本要求的无头浏览器没有装在服务用户可见的位置。先停止进程，在项目目录中以运行服务的同一用户执行：

```sh
npm ci
npx playwright install --with-deps chromium
```

再使用原参数启动。完整 `chromium` 安装包含普通浏览器及无头组件；不要把下载步骤整条改成 `sudo npx ...`，否则可能装到 root 的缓存。系统依赖需要提权时按 CLI 提示处理。更新依赖、切换服务用户，或改变 `PLAYWRIGHT_BROWSERS_PATH` 后，应在相同用户与路径设置下重新安装；`npm ci` 本身不会下载浏览器。默认缓存位于服务用户的 `~/.cache/ms-playwright`。安装行为参见 [Playwright 官方说明](https://playwright.dev/docs/browsers#install-browsers)。

局域网模式监听 IPv4 的 0.0.0.0，并在启动日志打印本机地址、每个私有网卡的访问地址，以及允许的网段；不发送 mDNS/UDP 广播，不自动打开防火墙。其他设备使用日志中的 LAN access 地址访问。

默认仅接受本机与服务器私有网卡所属网段的 TCP 对端，拒绝公网地址及其他私有网段。可用 PITCH_LAN_CIDRS 进一步明确允许的 IPv4 私有 CIDR，以逗号分隔，例如：

```sh
PITCH_LAN_CIDRS=192.168.1.0/24 sh start.sh --lan
```

公网 CIDR、0.0.0.0/0 和非法配置会拒绝启动。不会信任 X-Forwarded-For 来放宽来源检查。Host、Origin 与操作令牌校验仍保留；本机 IP 和局域网网卡 IP 自动进入 Host/Origin 白名单。若使用内部域名，可配置 PITCH_PUBLIC_ORIGIN 为对应完整 HTTP(S) 来源，不带路径。

此控制台共享一套扫描账号和管理能力，允许访问的内网用户都属于可信使用者。防火墙应同样仅允许目标 LAN 网段访问该端口，且不要配置公网端口转发；反向代理会使后端看到代理地址，因此代理也必须限制来源。Ubuntu 可参考[官方防火墙说明](https://ubuntu.com/server/docs/how-to/security/firewalls/)。本程序不自动更改系统防火墙。

如果仅需 SSH 隧道，继续使用默认本机模式：

```sh
ssh -L 4318:127.0.0.1:4318 your-user@your-server
```

## 人机验证与人工接管

无界面模式可以监测，但无法让用户看到并完成人机验证。需要人工接管的服务器应配置有界面 Chromium、虚拟显示及受保护的远程桌面，或使用已有图形桌面。程序不会破解验证码。

以已有 Xvfb/noVNC 服务为例，在**同一服务用户、同一 DISPLAY**下启动监测：

```sh
DISPLAY=:99 PITCH_HEADLESS=0 PITCH_MANUAL_BROWSER_URL=http://127.0.0.1:6080/vnc.html npm start
```

noVNC 必须连接到这个 DISPLAY，并限制在回环接口或认证代理后。SSH 隧道可以同时转发控制台和桌面：

```sh
ssh -L 4318:127.0.0.1:4318 -L 6080:127.0.0.1:6080 your-user@your-server
```

局域网用户接管时，PITCH_MANUAL_BROWSER_URL 必须填服务器可达的局域网地址或受保护的内部代理地址，不能填访问者自己的 127.0.0.1。

“账号与接管”和故障提示中的“打开远程浏览器”是配置好的 noVNC 链接，在访问者的浏览器打开。官网正常预订链接仍直接在访问者浏览器打开，与扫描会话分开。官网验证完成后，无操作一分钟会自动检查并恢复监测；验证仍在或页面仍不可读取时保持接管。不要把 `PITCH_MANUAL_BROWSER_URL` 填成普通官网 URL，普通官网标签页不共享服务器的扫描会话。

## 配置与持久化

| 环境变量 | 默认与用途 |
| --- | --- |
| `PORT` | `4318` |
| `PITCH_HOST` | `127.0.0.1`；显式局域网模式为 `0.0.0.0`，也可绑定本机私有 IPv4 |
| `PITCH_LAN_CIDRS` | 默认私有网卡所属网段；可用逗号分隔的私有 IPv4 CIDR 限制访问 |
| `PITCH_BROWSER_EXECUTABLE` | 可选，普通人工验证和自动扫描共用的浏览器可执行文件路径 |
| `PITCH_DATA_DIR` | 项目内 `.local`；可设为服务用户可写的持久目录 |
| `PITCH_HEADLESS` | Windows 默认 `0`；Linux 无 DISPLAY 默认 `1`；显式 `0/1` 可覆盖 |
| `PITCH_BROWSER_CHANNEL` | Windows `msedge`；Linux 默认随 Playwright 安装的 Chromium；可指定 `chrome`、`msedge` 或 `chromium` |
| `PITCH_PUBLIC_ORIGIN` | `http://127.0.0.1:4318`（随 PORT 变化）；反向代理的精确来源，不含路径 |
| `PITCH_MANUAL_BROWSER_URL` | 可选，受保护的远程浏览器桌面 HTTP(S) 地址 |
| `PITCH_ENCRYPTION_KEY` | Linux 可选，32 字节密钥的标准 Base64；不设置时生成 `secrets/master.key` |
| `PITCH_START_PAUSED` | `1` 时暂停网站监测后启动；不会关闭已经启用的飞书发送 |

Windows 保持 DPAPI CurrentUser 加密及旧文件格式。Linux 使用 AES-256-GCM，密文按账号组绑定，密钥目录权限 700、密钥文件 600；凭据及飞书配置共用服务数据目录下的密钥。可由部署环境注入 `PITCH_ENCRYPTION_KEY`，不可把密钥写进 Git、命令行参数或前端。备份应同时保留数据目录与对应密钥；丢失或替换密钥后旧密文无法解密。

Windows 的 DPAPI 密文不能直接在 Linux 解密。迁移时停止旧服务，迁移 SQLite、Council 默认地址文件后，在 Linux 控制台重新保存三组账号及飞书配置；浏览器配置目录与会话不保证跨系统兼容，建议重新登录。新旧实例不要同时发送通知或共用浏览器 profile。

## systemd 示例

先用服务用户安装依赖与 Chromium，并创建可写数据目录。按实际 Node 路径、项目路径、服务用户及局域网网段修改（下面的 192.168.1.0/24 只是示例）：

```ini
[Unit]
Description=Pitch Reserve read-only monitor
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=pitchreserve
WorkingDirectory=/srv/pitch_reserve
Environment=PORT=4318
Environment=PITCH_HOST=0.0.0.0
Environment=PITCH_LAN_CIDRS=192.168.1.0/24
Environment=PITCH_DATA_DIR=/var/lib/pitch_reserve
Environment=PITCH_HEADLESS=1
ExecStart=/usr/bin/node --disable-warning=ExperimentalWarning scripts/start-server.ts
Restart=on-failure
RestartSec=10
TimeoutStopSec=120
UMask=0077

[Install]
WantedBy=multi-user.target
```

需要人工验证时将 `PITCH_HEADLESS=0`，补充 DISPLAY 和远程浏览器地址，并让图形桌面先于本服务就绪。不要删 profile 来解决验证码。服务收到 SIGTERM 会保存会话后退出；重启会恢复凭据、通知去重与故障记录。

## 验证

```sh
npm run check
node --disable-warning=ExperimentalWarning --test --test-concurrency=1 tests/*.test.ts
node scripts/verify-console.ts
```

最后一项需要控制台已启动；所有发送和配置操作均使用模拟响应。GitHub Actions 的 Windows/Ubuntu 矩阵安装 Chromium 并运行类型检查及测试；矩阵配置本身不代表远端 CI 已运行成功。

## PlayFootball 普通浏览器验证

当自动化浏览器中的 Cloudflare 验证循环、普通浏览器却可正常使用时，控制台账号页提供“普通浏览器验证”。需要 Linux 图形桌面、DISPLAY，以及可访问该桌面的远程会话。验证阶段关闭该网站 Playwright 后，使用同一专用 profile 启动普通 Chromium；不连接自动化或调试协议。人工验证进入日历后关闭专用窗口，空闲检测会接回只读监测。`PITCH_BROWSER_EXECUTABLE` 可为普通验证与自动扫描指定同一浏览器可执行文件。无 DISPLAY 时会明确提示先配置图形桌面，不在无头窗口中重试验证。

`.local/native-verification/playfootball.json` 只记录工具启动的验证进程 ID，避免服务重启后同时占用 profile；程序不会根据该文件杀进程。服务重启时验证窗口可继续保留，关闭后再自动接回；主动暂停不会被覆盖。官网仍可能拒绝接回后的自动化，此时继续人工接管，需要场馆支持的接入方式。

进程保护以验证窗口实际存活为前提。systemd 等管理器可能在停止服务时一并结束子进程，建议先完成人工验证再重启服务；程序下次启动会在验证进程已结束后接回监测，不会尝试控制已经退出的窗口。
## 远程查看服务器浏览器（Ubuntu 直接启动）

`PITCH_HEADLESS=1` 适合无人值守读取，但不会产生可查看的窗口。需要登录、补资料或处理人机验证时，使用下面的虚拟桌面启动方式。Windows 仍使用 `start.ps1`，本机直接操作浏览器；日志、账号、通知和只读监测功能保持一致。

在项目目录，以实际运行服务的普通用户执行一次：

```sh
npm ci
sudo apt-get update
sudo apt-get install -y xvfb x11vnc openbox novnc websockify xauth
npx playwright install --with-deps chromium
mkdir -p .local/desktop
chmod 700 .local/desktop
x11vnc -storepasswd .local/desktop/vnc.pass
chmod 600 .local/desktop/vnc.pass
```

桌面密码在终端交互输入，不放入命令行或控制台配置。若设置了 `PITCH_DATA_DIR`，密码文件应位于该目录的 `desktop/vnc.pass`，不能使用其他账户的目录。

先用 `sh stop.sh` 正常停止原服务（自定义数据目录时传入相同的 `PITCH_DATA_DIR`），然后启动：

```sh
PITCH_HOST='<服务器的局域网IP>' \
PITCH_LAN_CIDRS='<允许访问的客户端或代理CIDR>' \
PITCH_PUBLIC_ORIGIN='http://<用户访问的主机>:<对外端口>' \
sh start-desktop.sh
```

这个脚本设置专用 `DISPLAY=:99`、私有 Xauthority 和 `PITCH_HEADLESS=0`，依次启动 Xvfb、Openbox、x11vnc、websockify，再启动原控制台。桌面密码开启；X11 禁止 TCP。VNC 5901 和 noVNC 6080 仅在 loopback 监听，不需要开放这些端口。通过现有控制台的 `/desktop/` 访问桌面，并沿用控制台的来源、Host 与局域网访问限制。它有权限操作该服务用户的浏览器和已登录会话，仅给可信内网用户访问。

进入“账号与接管 → 服务器浏览器 → 打开远程浏览器”，输入桌面密码。需要操作哪个网站，先点击该网站的“手动接管”。PlayFootball 验证循环时点击“普通浏览器验证”；手动验证后关闭**整个专用验证窗口**，工具会接回读取。工具不会代答验证码。虚拟桌面不会保证官网放行服务器 IP，持续拒绝时仍需联系官网。

`Ctrl+C` 或 `sh stop.sh` 会先停止控制台并保存会话，再关闭这次启动的桌面子进程。普通验证窗口仍开着时请先正常关闭。不要重复启动相同 display/端口；脚本会检查冲突，不关闭其他进程。可用 `PITCH_DESKTOP_DISPLAY`、`PITCH_VNC_PORT`、`PITCH_DESKTOP_PORT` 调整；noVNC 安装位置可用 `PITCH_NOVNC_DIR` 指定。当前为前台启动，关闭 SSH 会话前应使用 tmux，或按下文配置服务管理器。

如果经由反向代理访问，代理必须转发 WebSocket，保持外部 Host。Nginx 示例（放入对应 server 的 location；上游与当前部署一致）：

```nginx
location / {
    proxy_pass http://<后端服务器IP>:<后端服务端口>;
    proxy_http_version 1.1;
    proxy_set_header Host $http_host;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_read_timeout 3600s;
    proxy_buffering off;
}
```

以上占位符必须替换为本机实际配置；不要直接执行示例。`PITCH_LAN_CIDRS` 应填写实际连接后端的客户端或代理来源网段，不信任 `X-Forwarded-For`。真实 IP、映射端口和部署脚本只保存在被 Git 忽略的 `.local/` 或 `.env` 中，不写入仓库文档、示例或提交说明。本项目不会修改防火墙或代理配置。WebSocket 配置参考 [noVNC 官方 Nginx 说明](https://github.com/novnc/noVNC/wiki/Proxying-with-nginx)。

## 详细运行记录

“运行记录”支持按错误/警告/信息和网站筛选，每页 50 条，保留最近 5000 条 SQLite 记录。每轮检查带编号，记录阶段、耗时、日期覆盖、价格观察、重试次数、问题分类和处理建议。人工接管不等于无场地，仍显示“暂无信息”。

服务端同时写入 `.local/logs/runtime-YYYY-MM-DD.jsonl`（或 `PITCH_DATA_DIR/logs`），按伦敦日期保留 14 天。启动检查失败也写入该日志，方便服务尚未启动时排查。桌面子进程故障记录在 `logs/desktop-session.log`；超过 2 MiB 后下次启动轮换为 `.1`。日志不记录请求正文、密码、Cookie、令牌或网页正文。日志文件写入失败时 SQLite 仍保留记录，页面提示文件写入问题。

```sh
tail -n 100 .local/logs/runtime-*.jsonl
tail -n 100 .local/logs/desktop-session.log
```
