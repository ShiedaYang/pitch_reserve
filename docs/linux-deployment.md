# Windows 与 Linux 部署

运行时需要 Node.js 24+。Windows 默认使用已安装的 Edge；Linux 默认使用 Playwright Chromium，无 DISPLAY 时默认无界面运行。两者共用同一套 Node、SQLite 和网页代码。

## Linux 安装与启动

以下命令在项目目录以服务专用普通用户执行。安装系统依赖时可能需要 sudo；浏览器保持 Chromium sandbox 开启，不以 root 运行服务。

```sh
npm ci
npx playwright install --with-deps chromium
umask 077
PITCH_HEADLESS=1 npm start
```

默认监听 `127.0.0.1:4318`。从自己的电脑建立 SSH 隧道，再打开本地控制台：

```sh
ssh -L 4318:127.0.0.1:4318 your-user@your-server
```

浏览器安装及 Linux 有界面环境的要求参见 [Playwright 官方文档](https://playwright.dev/docs/browsers)及 [Linux CI 的 Xvfb 说明](https://playwright.dev/docs/ci#running-headed)。项目没有新增多用户认证；公网部署需要在反向代理提供 HTTPS 和访问认证，并保留后端的回环绑定。代理保留 Host，设置 `PITCH_PUBLIC_ORIGIN=https://你的控制台域名`；不要把未认证的控制台或浏览器桌面直接公开。

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

“账号与接管”和故障提示中的“打开远程浏览器”是配置好的 noVNC 链接，在访问者的浏览器打开。官网正常预订链接仍直接在访问者浏览器打开，与扫描会话分开。官网验证完成后，无操作一分钟会自动检查并恢复监测；验证仍在或页面仍不可读取时保持接管。不要把 `PITCH_MANUAL_BROWSER_URL` 填成普通官网 URL，普通官网标签页不共享服务器的扫描会话。

## 配置与持久化

| 环境变量 | 默认与用途 |
| --- | --- |
| `PORT` | `4318` |
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

先用服务用户安装依赖与 Chromium，并创建可写数据目录。按实际 Node 路径、项目路径和服务用户修改：

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
Environment=PITCH_DATA_DIR=/var/lib/pitch_reserve
Environment=PITCH_HEADLESS=1
ExecStart=/usr/bin/node --disable-warning=ExperimentalWarning src/server.ts
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
