var http = require('http');
var https = require('https');
var fs = require('fs');
var path = require('path');
var url = require('url');
var { chromium } = require('playwright-core');

var PORT = 8088;
// 高德 REST key：环境变量优先，其次 key.local.js（本机文件，不入库，见 .gitignore）
var AMAP_KEY = (process.env.AMAP_REST_KEY || '').trim();
if (!AMAP_KEY) {
  try { AMAP_KEY = require('./key.local.js').key; } catch (e) {}
}
if (!AMAP_KEY) {
  console.warn('[warn] 未配置高德 REST key：热力图/餐厅接口不可用（请创建 key.local.js，module.exports = { key: "..." }）');
}
var CHROME_PATH = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

// ---- 高德 WebService 全局调度 ----
// 免费版约 3 QPS；超限时连接不会报错，而是被静默挂起 10~16 秒（TLS/数据阶段无响应）。
// 因此所有 restapi.amap.com 请求必须走此队列：全局串行 + 每次间隔 ≥400ms（≈2.5 QPS）。
var amapQueue = Promise.resolve();
var amapLastAt = 0;

function amapGetOnce(query) {
  return new Promise(function(resolve, reject) {
    var apiUrl = 'https://restapi.amap.com/v3/place/around' + query;
    var req = https.get(apiUrl, { timeout: 6000 }, function(apiRes) {
      var body = '';
      apiRes.on('data', function(chunk) { body += chunk; });
      apiRes.on('end', function() {
        try {
          var data = JSON.parse(body);
          if (data.status === '1' && data.pois) { resolve(data.pois); return; }
          var err = new Error(data.info || 'AMAP_BIZ_FAIL');
          err.biz = true;
          reject(err);
        } catch (e) {
          reject(new Error('AMAP_PARSE_FAIL'));
        }
      });
    });
    req.on('error', function(e) { reject(e); });
    req.on('timeout', function() { req.destroy(); });
  });
}

function amapRequest(query) {
  var run = amapQueue.then(function() {
    var wait = Math.max(0, 400 - (Date.now() - amapLastAt));
    return new Promise(function(r) { setTimeout(r, wait); }).then(function() {
      amapLastAt = Date.now();
      return amapGetOnce(query);
    });
  });
  amapQueue = run.catch(function() {}); // 单个失败不阻断队列
  return run;
}

// 解析点赞数（"2.3w" → 23000, "1864" → 1864）
function parseLikes(str) {
  if (!str) return 0;
  str = str.trim();
  if (str.includes('w') || str.includes('万')) {
    return parseFloat(str) * 10000;
  }
  return parseInt(str) || 0;
}

// ===== 相关性筛选：防止把"猜你喜欢"式推荐当搜索结果 =====
// 关键词拆分：店名部分（第1个空格前，再按分隔符切子项）+ 地点部分
function kwTerms(keyword) {
  var parts = keyword.split(/\s+/);
  var store = parts[0] || '';
  var loc = parts.slice(1).join(' ');
  var storeTerms = store.split(/[·•・\-—_()（）【】\[\]、,，.。]+/).filter(function(t) { return t.length >= 2; });
  if (store.length >= 4) storeTerms.push(store.substring(0, 2)); // 如"曹记东北烧烤"→"曹记"
  if (!storeTerms.length && store.length >= 2) storeTerms.push(store);
  var locTerms = [];
  if (loc) {
    locTerms.push(loc);
    if (loc.indexOf('华南农业大学') >= 0) { locTerms.push('华农', 'SCAU', '五山'); }
  }
  return { storeTerms: storeTerms, locTerms: locTerms };
}

// 店名命中在前、地点命中在后；店名 0 命中 = XHS 在推"猜你喜欢"，返回空让上层降级重搜
function pickRelevant(notes, terms) {
  var seen = {};
  var tierA = [], tierB = [];
  notes.forEach(function(n) {
    if (!n.id || seen[n.id]) return;
    seen[n.id] = 1;
    var s = (n.title || '') + ' ' + (n.author || '');
    var storeHit = terms.storeTerms.some(function(t) { return s.indexOf(t) >= 0; });
    if (storeHit) { tierA.push(n); return; }
    if (terms.locTerms.length && terms.locTerms.some(function(t) { return s.indexOf(t) >= 0; })) tierB.push(n);
  });
  if (tierA.length === 0) return [];
  return tierA.concat(tierB);
}

// ===== 小红书持久化浏览器配置（登录态完整保存在 xhs-profile 目录）=====
var PROFILE_DIR = path.join(__dirname, 'xhs-profile');

// 登录态缓存：null=未知（需查 cookie）, true/false=已确认
var xhsLoginCache = null;

// 互斥锁：同一时间只允许一个操作占用 profile
var xhsLock = Promise.resolve();
function withXhsProfile(fn) {
  var run = xhsLock.then(fn, fn);
  xhsLock = run.then(function() {}, function() {});
  return run;
}

function launchProfile(headless) {
  return chromium.launchPersistentContext(PROFILE_DIR, {
    executablePath: CHROME_PATH,
    headless: headless,
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    locale: 'zh-CN',
    viewport: { width: 1920, height: 1080 },
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-blink-features=AutomationControlled']
  });
}

// ===== 常驻浏览器：登录成功后不关闭 =====
// 里面有「地图应用」标签页 + 用户操作；点笔记/搜索都在这个浏览器里开新标签页，保持登录态
var xhsBrowser = null;

function watchBrowserClose(ctx) {
  ctx.on('close', function () {
    if (xhsBrowser === ctx) { xhsBrowser = null; xhsLoginCache = null; }
  });
}

// 读取当前 web_session 值（没有则空串）
async function getWebSession(context) {
  var cookies = await context.cookies('https://www.xiaohongshu.com');
  for (var i = 0; i < cookies.length; i++) {
    if (cookies[i].name === 'web_session' && cookies[i].value) return cookies[i].value;
  }
  return '';
}

// 静默等待 web_session 出现（只读 cookie，绝不导航/新建页面）
async function waitForWebSession(context, timeoutMs) {
  var waited = 0;
  while (waited < timeoutMs) {
    await new Promise(function(r) { setTimeout(r, 2000); });
    waited += 2000;
    if (await getWebSession(context)) return true;
  }
  return false;
}

// 小红书登录：打开常驻浏览器（应用页 + 登录页两个标签），等用户登录
function loginXhs() {
  return withXhsProfile(async function () {
    // 已有常驻浏览器：活着就复用，绝不重复启动（同一 profile 只能一个实例）
    if (xhsBrowser) {
      var alive = true;
      try { await xhsBrowser.cookies('https://www.xiaohongshu.com'); } catch (e) { alive = false; }
      if (alive) {
        if (await getWebSession(xhsBrowser)) {
          xhsLoginCache = true;
          return 'LOGIN_OK';
        }
        // 浏览器开着但 session 没了：在里面再开一个登录标签页等待
        var reLogin = await xhsBrowser.newPage();
        try { await reLogin.goto('https://www.xiaohongshu.com/login', { waitUntil: 'domcontentloaded', timeout: 30000 }); } catch (e) {}
        var ok2 = await waitForWebSession(xhsBrowser, 300000);
        try { await reLogin.close(); } catch (e) {}
        if (ok2) { xhsLoginCache = true; return 'LOGIN_OK'; }
        return 'LOGIN_TIMEOUT';
      }
      // 浏览器已被用户关掉：清引用，走下面重新启动
      xhsBrowser = null;
      xhsLoginCache = null;
    }

    var context = await launchProfile(false);
    try {
      // profile 里已有 session：先用临时页验证是否仍有效，有效则直接打开应用页，免登录
      var existing = await getWebSession(context);
      if (existing) {
        var checkPage = await context.newPage();
        var valid = false;
        try {
          await checkPage.goto('https://www.xiaohongshu.com/', { waitUntil: 'domcontentloaded', timeout: 20000 });
          await checkPage.waitForTimeout(2500);
          valid = !checkPage.url().includes('/login');
        } catch (e) { valid = true; } // 验证页打不开但有 cookie，先信任
        try { await checkPage.close(); } catch (e) {}
        if (valid) {
          var appOnly = await context.newPage();
          try { await appOnly.goto('http://localhost:' + PORT + '/', { waitUntil: 'domcontentloaded', timeout: 30000 }); } catch (e) {}
          xhsBrowser = context;
          watchBrowserClose(context);
          xhsLoginCache = true;
          return 'LOGIN_OK';
        }
        // session 已失效：清掉再让用户重新登录
        try { await context.clearCookies({ name: 'web_session' }); } catch (e) {}
      }

      // 标签1：地图应用（登录后用户继续在这里用）
      var appPage = await context.newPage();
      try { await appPage.goto('http://localhost:' + PORT + '/', { waitUntil: 'domcontentloaded', timeout: 30000 }); } catch (e) {}
      // 标签2：小红书登录页（只有这一个，轮询只读 cookie，绝不再新建页）
      var loginPage = await context.newPage();
      try { await loginPage.goto('https://www.xiaohongshu.com/login', { waitUntil: 'domcontentloaded', timeout: 30000 }); } catch (e) {}

      var ok = await waitForWebSession(context, 300000);
      if (ok) {
        try { await loginPage.close(); } catch (e) {} // 登录完成，关掉登录标签，留下应用页
        xhsBrowser = context; // 常驻不关
        watchBrowserClose(context);
        xhsLoginCache = true;
        return 'LOGIN_OK';
      }
      // 超时：整个关掉
      try { await context.close(); } catch (e) {}
      return 'LOGIN_TIMEOUT';
    } catch (e) {
      try { await context.close(); } catch (e) {}
      throw e;
    }
  });
}

// 小红书搜索：抓取真实笔记数据
async function searchXhs(keyword) {
  // 优先复用常驻浏览器（用户登录后开着的那个窗口）；注意绝不并行启动第二个 profile 实例
  if (xhsBrowser) {
    var alive = true;
    try { await xhsBrowser.cookies('https://www.xiaohongshu.com'); } catch (e) { alive = false; }
    if (alive) {
      if (!(await getWebSession(xhsBrowser))) {
        xhsLoginCache = false;
        var errL = new Error('请先登录小红书');
        errL.code = 'NEED_LOGIN';
        throw errL;
      }
      xhsLoginCache = true;
      var livePage = await xhsBrowser.newPage();
      try {
        return await runSearch(livePage, keyword);
      } finally {
        try { await livePage.close(); } catch (e) {}
      }
    }
    // 浏览器已被用户关掉：清引用，走下面的 headless 单次模式
    xhsBrowser = null;
    xhsLoginCache = null;
  }

  var context = await launchProfile(true);

  // 先查登录态：未登录立刻返回，不进搜索页白等 15 秒
  var sessCookies = await getWebSession(context);
  if (!sessCookies) {
    try { await context.close(); } catch(e) {}
    xhsLoginCache = false;
    var err0 = new Error('请先登录小红书');
    err0.code = 'NEED_LOGIN';
    throw err0;
  }
  xhsLoginCache = true;

  var page = await context.newPage();
  try {
    return await runSearch(page, keyword);
  } finally {
    try { await page.close(); } catch(e) {}
    try { await context.close(); } catch(e) {}
  }
}

// 在给定页面上执行一次完整搜索（不管理页面/浏览器生命周期，由调用方关闭）
async function runSearch(page, keyword) {

  // 拦截 XHS 搜索 API 响应
  var capturedNotes = [];
  page.on('response', async function(response) {
    var respUrl = response.url();
    // 匹配 edith.xiaohongshu.com/api/sns/web/v*/search/notes 等搜索接口
    if (respUrl.includes('xiaohongshu.com') && respUrl.includes('/search')) {
      try {
        var json = await response.json();
        var items = (json.data && (json.data.items || json.data.notes)) || [];
        console.error('[xhs] API hit:', respUrl.split('?')[0], 'items:', items.length);
        items.forEach(function(item) {
          if (!item) return;
          // 兼容新旧结构：v2 接口是下划线命名（note_card/display_title），旧接口是驼峰
          var note = item.note || item.noteCard || item.note_card || item;
          var noteId = note.id || item.id || '';
          if (!noteId) return;
          var cover = '';
          if (note.cover) {
            cover = note.cover.url || note.cover.urlDefault || note.cover.url_default ||
              (note.cover.infoList && note.cover.infoList[0] && note.cover.infoList[0].url) ||
              (note.cover.info_list && note.cover.info_list[0] && note.cover.info_list[0].url) || '';
          }
          // xsec_token 必须带上，否则电脑网页打开提示"仅支持在小红书内查看"
          var token = item.xsecToken || item.xsec_token || note.xsecToken || note.xsec_token || '';
          var rawTitle = note.displayTitle || note.display_title || note.title || note.desc || '';
          var interact = note.interactInfo || note.interact_info || {};
          var userObj = note.user || {};
          capturedNotes.push({
            id: noteId,
            title: String(rawTitle).replace(/\s+/g, ' ').trim().substring(0, 60),
            author: userObj.nickname || userObj.nickName || userObj.nick_name || '',
            likes: interact.likedCount || interact.liked_count || '0',
            cover: cover,
            token: token,
            url: 'https://www.xiaohongshu.com/explore/' + noteId + (token ? '?xsec_token=' + encodeURIComponent(token) + '&xsec_source=pc_search' : '')
          });
        });
      } catch(e) {}
    }
  });

    var searchUrl = 'https://www.xiaohongshu.com/search_result/?keyword=' + encodeURIComponent(keyword) + '&source=web_search_result_notes';
    // 用 domcontentloaded，比 networkidle 快很多
    await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(2500);

    // 登录墙检测：被踢到 /login 或页面提示登录
    if (page.url().includes('/login')) {
      var err = new Error('登录已失效，请重新登录小红书');
      err.code = 'NEED_LOGIN';
      throw err;
    }

    // 关闭弹窗（并行，不阻塞太久）
    try {
      await page.keyboard.press('Escape');
    } catch(e) {}

    // 轮询等待 API 数据返回，最多 20 秒（风控时接口会变慢，早退会漏数据）
    var pollWait = 0;
    while (pollWait < 20000 && capturedNotes.length < 8) {
      await page.waitForTimeout(500);
      pollWait += 500;
    }

    if (capturedNotes.length > 0) {
      return capturedNotes;
    }

    // 轮询后再次检测登录墙（游客会被延迟重定向到 /login）
    if (page.url().includes('/login')) {
      var err3 = new Error('登录已失效，请重新登录小红书');
      err3.code = 'NEED_LOGIN';
      throw err3;
    }

    // 否则从 DOM 提取
    var notes = await page.evaluate(function() {
      var results = [];
      // 尝试多种选择器
      var selectors = [
        'section.note-item',
        '[class*="note-item"]',
        'a[href*="/explore/"]',
        'a[href*="/discovery/item/"]',
        'a[href*="/search_result/"]',
        '.feeds-page .note-item',
        '[data-note-id]',
        '.note-card'
      ];

      var allCards = new Set();
      selectors.forEach(function(sel) {
        try {
          document.querySelectorAll(sel).forEach(function(el) { allCards.add(el); });
        } catch(e) {}
      });

      allCards.forEach(function(card) {
        try {
          var link = card.tagName === 'A' ? card : card.querySelector('a[href*="/explore/"], a[href*="/discovery/item/"]');
          var href = link ? link.getAttribute('href') : '';
          if (!href && card.getAttribute('data-note-id')) {
            href = '/explore/' + card.getAttribute('data-note-id');
          }
          if (!href) return;

          // 提取标题：优先标题类名元素，再退回正文扫描
          var title = '';
          var preferredEls = card.querySelectorAll('[class*="title"], .title, .desc');
          for (var t0 = 0; t0 < preferredEls.length; t0++) {
            var txt0 = preferredEls[t0].textContent.replace(/\s+/g, ' ').trim();
            if (txt0.length > 1) { title = txt0.substring(0, 60); break; }
          }
          if (!title) {
            var titleEls = card.querySelectorAll('span, h3, p');
            for (var t = 0; t < titleEls.length; t++) {
              var txt = titleEls[t].textContent.replace(/\s+/g, ' ').trim();
              if (txt.length > 3 && txt.length < 100) { title = txt.substring(0, 60); break; }
            }
          }

          // 提取作者
          var author = '';
          var authorEls = card.querySelectorAll('[class*="author"], [class*="name"], [class*="user"], .author, .name');
          for (var a = 0; a < authorEls.length; a++) {
            var atxt = authorEls[a].textContent.trim();
            if (atxt.length > 0 && atxt.length < 20) {
              author = atxt;
              break;
            }
          }

          // 提取点赞数
          var likes = '';
          var likeEls = card.querySelectorAll('[class*="like"], [class*="count"], [class*="heart"], .like-wrapper');
          for (var l = 0; l < likeEls.length; l++) {
            var ltxt = likeEls[l].textContent.trim();
            if (ltxt.length > 0 && ltxt.length < 10) {
              likes = ltxt;
              break;
            }
          }

          // 提取封面
          var cover = '';
          var img = card.querySelector('img');
          if (img) cover = img.src || img.getAttribute('data-src') || '';

          // 提取笔记 ID
          var noteId = '';
          var idMatch = href.match(/\/(?:explore|discovery\/item)\/([a-f0-9]+)/);
          if (idMatch) noteId = idMatch[1];
          if (!noteId) {
            var dataId = card.getAttribute('data-note-id');
            if (dataId) noteId = dataId;
          }

          if (noteId) {
            var tokMatch = href.match(/[?&]xsec_token=([^&]+)/);
            results.push({
              id: noteId,
              title: title || '小红书笔记',
              author: author,
              likes: likes,
              cover: cover,
              token: tokMatch ? decodeURIComponent(tokMatch[1]) : '',
              url: href.startsWith('http') ? href : 'https://www.xiaohongshu.com' + href
            });
          }
        } catch(e) {}
      });
      return results;
    });

    // 宽限等待：风控时接口响应可能晚于放弃时刻，DOM 也空时再多等 4 秒兜底
    if (notes.length === 0 && capturedNotes.length === 0) {
      var graceWait = 0;
      while (graceWait < 4000 && capturedNotes.length === 0) {
        await page.waitForTimeout(500);
        graceWait += 500;
      }
    }

    // 调试：如果没有找到笔记，返回页面结构信息
    if (notes.length === 0 && capturedNotes.length === 0) {
      var debug = await page.evaluate(function() {
        var body = document.body;
        var visibleText = body.innerText || body.textContent || '';
        return {
          bodyLength: body.innerHTML.length,
          url: window.location.href,
          title: document.title,
          visibleText: visibleText.substring(0, 300),
          needLogin: visibleText.includes('登录后') || window.location.href.includes('/login')
        };
      });
      console.error('XHS debug:', JSON.stringify(debug));
      // 页面提示"登录后..."或被踢到 /login = 登录态无效
      if (debug.needLogin) {
        var err2 = new Error('登录已失效，请重新登录小红书');
        err2.code = 'NEED_LOGIN';
        throw err2;
      }
    }

    return capturedNotes.length > 0 ? capturedNotes : notes;
}

// ===== 单篇笔记抓取（供 /note.html 预览页用，电脑/手机通用）=====
var noteCache = {}; // id -> { t: 时间戳, data: 笔记数据 }

async function fetchNote(id, token) {
  var cached = noteCache[id];
  if (cached && Date.now() - cached.t < 10 * 60 * 1000) return cached.data;

  var reuseBrowser = null;
  if (xhsBrowser) {
    try { await xhsBrowser.cookies('https://www.xiaohongshu.com'); reuseBrowser = xhsBrowser; }
    catch (e) { xhsBrowser = null; xhsLoginCache = null; }
  }
  var ctx = reuseBrowser || await launchProfile(true);
  var page = await ctx.newPage();

  var noteJson = null;
  page.on('response', async function(response) {
    var u = response.url();
    // 笔记详情接口：/api/sns/web/v2/note/{id}
    if (u.includes('xiaohongshu.com') && u.includes('/note/') && u.includes('/api/')) {
      try {
        var j = await response.json();
        var nd = (j.data && (j.data.data || j.data)) || null;
        if (nd && (nd.title !== undefined || nd.desc !== undefined || nd.user)) noteJson = nd;
      } catch (e) {}
    }
  });

  try {
    var url = 'https://www.xiaohongshu.com/explore/' + id + (token ? '?xsec_token=' + encodeURIComponent(token) + '&xsec_source=pc_search' : '');
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    var w = 0;
    while (w < 6000 && !noteJson) { await page.waitForTimeout(500); w += 500; }

    if (!noteJson) {
      // DOM 兜底提取
      noteJson = await page.evaluate(function() {
        function t(sel) { var el = document.querySelector(sel); return el ? el.textContent.trim() : ''; }
        var imgs = [];
        document.querySelectorAll('img[src*="xhscdn"]').forEach(function(im) {
          var s = im.src;
          if (s && s.indexOf('avatar') === -1 && imgs.length < 20) imgs.push(s);
        });
        return {
          title: t('[id*="detail-title"]') || t('h1') || document.title.replace(/.*[-|]\s*/, ''),
          desc: t('[id*="detail-desc"]') || t('.note-text') || '',
          user: { nickname: t('[class*="author"] [class*="name"]') || t('.author') , avatar: '' },
          interact_info: {},
          image_list: imgs.map(function(u) { return { url_default: u }; })
        };
      });
    }

    // 补充：详情接口可能缺正文/点赞数/类型，从页面 DOM 补齐
    if (noteJson && (!noteJson.type || !noteJson.desc || !(noteJson.interact_info && (noteJson.interact_info.liked_count || noteJson.interact_info.likedCount)))) {
      var domInfo = await page.evaluate(function() {
        function t(sel) { var el = document.querySelector(sel); return el ? el.textContent.trim() : ''; }
        var likes = '';
        var likeEl = document.querySelector('[class*="like"] [class*="count"], [class*="interact"] [class*="count"], .engage-bar .count');
        if (likeEl) likes = likeEl.textContent.trim();
        var hasVideo = !!document.querySelector('video, [class*="video-player"], [class*="player-video"]');
        return { desc: t('[id*="detail-desc"]') || t('.note-text') || '', likes: likes, type: hasVideo ? 'video' : 'normal' };
      });
      if (!noteJson.desc && domInfo.desc) noteJson.desc = domInfo.desc;
      if (!noteJson.type && domInfo.type) noteJson.type = domInfo.type;
      if (domInfo.likes) {
        noteJson.interact_info = noteJson.interact_info || {};
        if (!noteJson.interact_info.liked_count && !noteJson.interact_info.likedCount) noteJson.interact_info.liked_count = domInfo.likes;
      }
    }

    var interact2 = noteJson.interact_info || noteJson.interactInfo || {};
    var user2 = noteJson.user || {};
    var images = [];
    (noteJson.image_list || noteJson.imageList || []).forEach(function(im) {
      var u = im.url_default || im.urlDefault || im.url ||
        (im.info_list && im.info_list[0] && im.info_list[0].url) ||
        (im.infoList && im.infoList[0] && im.infoList[0].url) || '';
      if (u) images.push(u);
    });
    // DOM 兜底时 image_list 可能直接是字符串数组
    if (!images.length && Array.isArray(noteJson.image_list)) {
      noteJson.image_list.forEach(function(x) { if (typeof x === 'string') images.push(x); });
    }
    var ts = noteJson.time || noteJson.timestamp || 0;
    var timeStr = '';
    if (ts) {
      try { timeStr = new Date(ts * 1000).toLocaleDateString('zh-CN'); } catch (e) {}
    }

    var data = {
      id: id,
      type: noteJson.type || '',
      title: noteJson.title || '',
      content: noteJson.desc || noteJson.description || '',
      author: user2.nickname || user2.nick_name || user2.nickName || '',
      avatar: user2.avatar || '',
      likes: interact2.liked_count || interact2.likedCount || '0',
      collects: interact2.collected_count || interact2.collectedCount || '0',
      comments: interact2.comment_count || interact2.commentCount || '0',
      time: timeStr,
      images: images
    };
    noteCache[id] = { t: Date.now(), data: data };
    return data;
  } finally {
    try { await page.close(); } catch (e) {}
    if (!reuseBrowser) { try { await ctx.close(); } catch (e) {} }
  }
}

var server = http.createServer(function(req, res) {
  var parsed = url.parse(req.url, true);

  // 代理：搜索景点（翻页获取100条）——全部经 amapRequest 全局限流队列
  if (parsed.pathname === '/api/poi') {
    var q = parsed.query;
    var lng = q.lng || '116.3972';
    var lat = q.lat || '39.9163';
    var radius = q.radius || '2000';
    var baseQ = '?key=' + AMAP_KEY + '&location=' + lng + ',' + lat +
      '&radius=' + radius + '&offset=25&extensions=base&page=';

    (async function() {
      var pages = [1, 2, 3, 4];
      var allPois = [];
      var anyOk = false;
      for (var i = 0; i < pages.length; i++) {
        var ok = false;
        // 挂起/失败多为超 QPS 被静默丢弃，退避要足够长（2.5s/4s），不要再快打
        for (var attempt = 1; attempt <= 3 && !ok; attempt++) {
          if (attempt > 1) await new Promise(function(r) { setTimeout(r, attempt === 2 ? 2500 : 4000); });
          try {
            var pois = await amapRequest(baseQ + pages[i]);
            allPois = allPois.concat(pois);
            anyOk = true;
            ok = true;
          } catch (e) { /* 重试 */ }
        }
        if (!ok && i === 0) break; // 第一页3次全挂 = 网络/限流严重，立即报错
      }
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      if (!anyOk) {
        res.end(JSON.stringify({ status: '0', info: '高德接口请求失败，请重试' }));
      } else {
        res.end(JSON.stringify({ status: '1', pois: allPois }));
      }
    })().catch(function() {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ status: '0', info: '高德接口请求失败，请重试' }));
    });
    return;
  }

  // 代理：搜索餐厅（按评分排序）
  if (parsed.pathname === '/api/restaurant') {
    var q2 = parsed.query;
    var rlng = q2.lng || '116.3972';
    var rlat = q2.lat || '39.9163';
    var rradius = q2.radius || '2000';

    var rQuery = '?key=' + AMAP_KEY +
      '&location=' + rlng + ',' + rlat +
      '&types=050000' +
      '&radius=' + rradius +
      '&offset=25' +
      '&extensions=all';

    amapRequest(rQuery).then(function(rPois) {
      // 按评分排序，筛选有评分的
      var rated = rPois.filter(function(p) {
        return p.biz_ext && p.biz_ext.rating && p.biz_ext.rating !== '[]';
      });
      rated.sort(function(a, b) {
        return parseFloat(b.biz_ext.rating) - parseFloat(a.biz_ext.rating);
      });
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ status: '1', pois: rated }));
    }).catch(function() {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ status: '0', info: '高德接口请求失败，请重试' }));
    });
    return;
  }

  // 小红书登录接口（打开浏览器让用户登录，保存 session）
  if (parsed.pathname === '/api/xhs/login') {
    loginXhs().then(function(result) {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
      if (result === 'LOGIN_OK') {
        res.end(JSON.stringify({ status: '1', info: '登录成功，登录态已保存' }));
      } else {
        res.end(JSON.stringify({ status: '0', info: '等待超时，请重试' }));
      }
    }).catch(function(err) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ status: '0', info: err.message }));
    });
    return;
  }

  // 小红书搜索接口
  if (parsed.pathname === '/api/xhs') {
    var keyword = parsed.query.keyword || '';
    if (!keyword) {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
      res.end('{"status":"0","info":"missing keyword"}');
      return;
    }

    // 已确认未登录：直接返回，连浏览器都不启动（毫秒级响应）
    if (xhsLoginCache === false) {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ status: '0', info: '请先登录小红书', needLogin: true }));
      return;
    }

    function doSearch(kw) {
      return withXhsProfile(function() { return searchXhs(kw); });
    }

    // 相关性筛选 + 逐级降级：全关键词 → 去括号分店名 → 只搜店名；店名始终 0 命中才返回空
    doSearch(keyword).then(function(notes) {
      var picked = pickRelevant(notes, kwTerms(keyword));
      if (picked.length > 0) return { notes: picked, usedKeyword: keyword };

      var stripped = keyword.replace(/[（(][^）)]*[）)]/g, '').replace(/\s+/g, ' ').trim();
      if (stripped && stripped !== keyword) {
        return doSearch(stripped).then(function(n2) {
          var p2 = pickRelevant(n2, kwTerms(stripped));
          if (p2.length > 0) return { notes: p2, usedKeyword: stripped };
          var storeOnly = stripped.split(/\s+/)[0];
          if (storeOnly && storeOnly !== stripped) {
            return doSearch(storeOnly).then(function(n3) {
              return { notes: pickRelevant(n3, kwTerms(storeOnly)), usedKeyword: storeOnly };
            });
          }
          return { notes: [], usedKeyword: stripped };
        });
      }
      // 无括号可去：直接降级只搜店名
      var storeOnly2 = keyword.split(/\s+/)[0];
      if (storeOnly2 && storeOnly2 !== keyword) {
        return doSearch(storeOnly2).then(function(n2b) {
          return { notes: pickRelevant(n2b, kwTerms(storeOnly2)), usedKeyword: storeOnly2 };
        });
      }
      return { notes: [], usedKeyword: keyword };
    }).then(function(r) {
      var notes = r.notes;
      var usedKeyword = r.usedKeyword;
      // 按笔记 id 去重（多个搜索接口可能重复返回同一篇）
      var seenIds = {};
      notes = notes.filter(function(n) {
        if (!n.id || seenIds[n.id]) return false;
        seenIds[n.id] = 1;
        return true;
      });
      // 全局按热度取前5；若其中没有一条店名命中，用最热的店名命中笔记垫底，保证可见
      var terms2 = kwTerms(usedKeyword);
      function isStoreHit(n) {
        var s = (n.title || '') + ' ' + (n.author || '');
        return terms2.storeTerms.some(function(t) { return s.indexOf(t) >= 0; });
      }
      notes.sort(function(a, b) {
        return parseLikes(b.likes) - parseLikes(a.likes);
      });
      var top5 = notes.slice(0, 5);
      if (top5.length > 0 && !top5.some(isStoreHit)) {
        var bestHit = notes.filter(isStoreHit)[0];
        if (bestHit) top5[top5.length - 1] = bestHit;
      }

      // 附上搜索页链接（单篇笔记电脑打不开，统一跳搜索页）
      var searchUrl = 'https://www.xiaohongshu.com/search_result?keyword=' + encodeURIComponent(usedKeyword) + '&source=web_search_result_notes';
      top5.forEach(function(n) { n.searchUrl = searchUrl; });

      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ status: '1', keyword: usedKeyword, searchUrl: searchUrl, notes: top5, total: notes.length }));
    }).catch(function(err) {
      var needLogin = err.code === 'NEED_LOGIN';
      if (needLogin) xhsLoginCache = false;
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ status: '0', info: err.message, needLogin: needLogin }));
    });
    return;
  }

  // 单篇笔记内容（供 /note.html 预览页，手机/电脑都能看）
  if (parsed.pathname === '/api/note') {
    var noteId = parsed.query.id || '';
    var noteToken = parsed.query.token || '';
    if (!noteId) {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end('{"status":"0","info":"missing id"}');
      return;
    }
    withXhsProfile(function() { return fetchNote(noteId, noteToken); }).then(function(note) {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ status: '1', note: note }));
    }).catch(function(err) {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ status: '0', info: err.message }));
    });
    return;
  }

  // 图片代理（小红书 CDN 图直接引用可能被拒，服务端转发保证手机端也能显示）
  if (parsed.pathname === '/api/img') {
    var imgUrl = parsed.query.u || '';
    if (!/^https:\/\/[a-z0-9.-]*xhscdn\.com\//i.test(imgUrl)) {
      res.writeHead(403); res.end(); return;
    }
    https.get(imgUrl, function(imgRes) {
      if (imgRes.statusCode !== 200) { res.writeHead(502); res.end(); return; }
      res.writeHead(200, {
        'Content-Type': imgRes.headers['content-type'] || 'image/jpeg',
        'Cache-Control': 'public, max-age=86400'
      });
      imgRes.pipe(res);
    }).on('error', function() { res.writeHead(502); res.end(); });
    return;
  }

  // 静态文件（限制在 map-demo 目录内，防止 ../ 路径穿越读取本机其他文件）
  var relPath;
  try { relPath = decodeURIComponent(parsed.pathname); } catch (e) {
    res.writeHead(400); res.end('Bad request'); return;
  }
  var filePath = path.normalize(path.join(__dirname, relPath === '/' ? 'index.html' : relPath));
  if (filePath !== __dirname && filePath.indexOf(__dirname + path.sep) !== 0) {
    res.writeHead(403); res.end('Forbidden'); return;
  }
  var ext = path.extname(filePath).toLowerCase();
  var types = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'application/javascript',
    '.css': 'text/css',
    '.json': 'application/json',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.ico': 'image/x-icon'
  };

  fs.readFile(filePath, function(err, data) {
    if (err) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': types[ext] || 'application/octet-stream' });
    res.end(data);
  });
});

server.listen(PORT, function() {
  console.log('Server running at http://localhost:' + PORT);
});