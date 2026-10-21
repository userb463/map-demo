// ===== 公开版（GitHub Pages）配置 =====
// 在 https://console.amap.com 新建一个「Web服务」类型的 Key 专门给公开版使用
//（注意平台必须选「Web服务」，选成 JS API 会报 USERKEY_PLAT_NOMATCH）。
// 页面内置每日 2000 次/浏览器的配额闸门（次日自动重置），见 index.html QUOTA_DAILY_LIMIT。
// 本地版（node server.js）不读这个文件，用自己的 key（key.local.js，不入库）。
window.AMAP_PUBLIC_REST_KEY = '8a2051ac7b1a1018137de40bcae776ad';
