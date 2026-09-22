# AuraPro

AuraPro 是为[极简探针 monitor](https://github.com/monitor-probe/monitor)开发的高密度状态页主题，基于官方 [`monitor-theme-default`](https://github.com/monitor-probe/monitor-theme-default) 二次开发。

## 特性

- Lumina 风格的浅色极简界面，同时保留深色模式
- 顶部展示在线节点、实时带宽、本月流量、今日流量
- 按国家/地区筛选节点
- 四列高密度节点卡，包含 CPU、内存、磁盘、负载、实时网速、累计流量、流量额度、TCP/UDP、在线时间和到期信息
- 桌面端、平板和手机端响应式布局
- 节点详情页保留官方历史指标与延迟图表

## 开发

先启动 hub：

```bash
monitor-hub --listen 127.0.0.1:9911 --db /tmp/monitor.db --site http://127.0.0.1:9911
```

再启动开发服务器，Vite 会把 `/api` 和 WebSocket 代理到 hub：

```bash
npm ci
npm run dev
```

## 检查与构建

```bash
npm run build
npm run lint
npm test
npm run package
```

`npm run package` 会生成可安装的 `theme.tar.gz`：

```text
theme.json
preview.png
dist/
└── index.html
```

解压后把这些文件放进 hub 的 `<themes-dir>/AuraPro/` 目录，或按极简探针后台支持的方式导入主题包后切换即可，无需重启。

## 接口契约

主题只使用极简探针官方同源接口：

| 接口 | 用途 |
|---|---|
| `GET /api/me` | 站点名、登录状态、公开页开关 |
| `GET /api/nodes` | 节点列表、实时指标、今日/月度/累计流量 |
| `GET /api/nodes/{id}/metrics` | 历史指标和延迟记录 |
| `GET /api/ws` | 每 2 秒推送节点快照 |

`/node/{id}` 使用客户端路由；如果 hub 前有路径白名单代理或 WAF，需要允许该路径刷新时回落到主题的 `dist/index.html`。

## 许可

MIT
