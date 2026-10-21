# 华农美食地图 Map Demo

基于高德地图的校园周边美食地图：标注真实 POI、热力图（右键选点）、周边餐厅排行，并集成小红书笔记搜索面板。

## 本地运行（完整功能）

```bash
npm install
# 首次运行前：创建 key.local.js（不会被提交），填入你的高德「Web服务」key：
#   module.exports = { key: '你的高德RESTkey' };
node server.js
# 打开 http://localhost:8088/
```

本地版额外功能：

- **小红书笔记面板**：点击餐厅卡片自动搜索相关笔记，按热度排序，本地预览页可直接查看笔记内容（依赖 Playwright 驱动本机 Chrome + 已登录的小红书会话，首次需扫码登录，最长等 5 分钟）。
- **手机访问**：同一 Wi-Fi 下访问 `http://<电脑IP>:8088/`（需放行防火墙 TCP 8088）。

## 公开版（GitHub Pages）

公开版为纯静态托管，自动降级为高德接口浏览器直连。发布前在 [高德控制台](https://console.amap.com) 新建一个**「Web服务」类型的专用 key**（建议绑定 `*.github.io` 域名白名单 + 设置额度告警），填入 `config.js` 的 `window.AMAP_PUBLIC_REST_KEY`。公开版功能对比：

| 功能 | 本地版 | 公开版 |
|---|---|---|
| 地图 / 餐厅标注 | ✅ | ✅ |
| 热力图（右键选点） | ✅ | ✅ |
| 周边热门餐厅 | ✅ | ✅ |
| 小红书笔记面板 | ✅ | ❌（仅提供外链，依赖本地登录环境） |

## 技术栈

- 高德 JS API v2（前端地图）+ 高德 WebService（POI 检索，服务端限流队列 ~2.5 QPS）
- Node.js 原生 `http` 代理服务
- Playwright-core + 本机 Chrome（小红书会话复用）
