/* =========================================================================
 * 小学英语语法 · 云端同步 + 在线题库 API（零依赖 Node.js，18+ 可用）
 * -------------------------------------------------------------------------
 * 启动：  node server.js
 *        可选环境变量：PORT=8787  DATA_DIR=./data  TOKEN=你的口令
 * 数据：  每个「空间编号」一个 JSON 文件，存在 DATA_DIR/<space>.json
 *        在线题库缓存存在 DATA_DIR/bank/<topic>.json
 * -------------------------------------------------------------------------
 * 接口：
 *   GET  /api/health                    健康检查
 *   GET  /api/data?space=CODE           读取该空间数据（不存在返回 404）
 *   PUT  /api/data?space=CODE           覆盖写入该空间数据（body: {users,current}）
 *   GET  /api/bank/meta                 在线题库来源与知识点映射
 *   GET  /api/bank/status               各知识点已缓存题量
 *   GET  /api/bank/sync?topics=be,art   抓取并入库（pages=每知识点页数，默认2）
 *   OPTIONS 任意 /api/*                 CORS 预检
 * 安全：设置了 TOKEN 时，所有请求需带请求头 X-Token: <TOKEN>
 * 说明：这是给家庭自用的小型服务，空间编号即"房间钥匙"，请勿放敏感信息。
 * ========================================================================= */
const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const PORT = Number(process.env.PORT || 8787);
const TOKEN = process.env.TOKEN || "";
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, "data"));
const BANK_DIR = path.join(DATA_DIR, "bank");
const PUBLIC_DIR = path.join(__dirname, "public");
const MAX_BODY = 8 * 1024 * 1024; // 8MB 上限

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(BANK_DIR, { recursive: true });

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, PUT, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-Token",
  "Access-Control-Max-Age": "86400",
};

function send(res, code, obj) {
  res.writeHead(code, Object.assign({
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  }, CORS));
  res.end(JSON.stringify(obj));
}

function validSpace(s) {
  return typeof s === "string" && /^[A-Za-z0-9_-]{3,32}$/.test(s);
}

/* =========================================================================
 * 在线题库：从 first-english.org 抓取小学语法练习
 * 该站点练习为 Hot Potatoes 生成的静态页面，题目与答案都在 HTML 里，
 * 服务端抓取不受浏览器 CORS 限制，解析后转成本应用的单选题格式。
 * ========================================================================= */
const FE_DIR = "https://first-english.org/english_learning/";

/* 知识点 ↔ 站点模块目录 映射 */
const TOPIC_MODULES = {
  be:     ["english_beginners/to_be_exercises", "english_beginners/have_got_exercises"],
  pres:   ["english_tenses/simple_present", "english_beginners/adverbs_of_frequency"],
  prog:   ["english_tenses/present_progressive"],
  past:   ["english_tenses/simple_past"],
  futu:   ["english_tenses/future_1", "english_tenses/going_to_future"],
  plural: ["english_beginners/singular_plural_exercises"],
  art:    ["english_beginners/articles_exercises"],
  pron:   ["english_beginners/possessive_pronouns"],
  comp:   ["english_tenses/comparison_tenses"],
  prep:   ["english_beginners/prepositions_exercises", "english_beginners/time_exercises"],
  tb:     ["english_beginners/there_is_there_are"],
  modal:  ["english_beginners/can_can_t_exercises", "english_beginners/must_needn_t"],
  wh:     ["english_beginners/questions_exercises"],
  cnt:    ["english_beginners/much_many_exercises", "english_beginners/a_little_a_few_exercises", "english_beginners/a_lot_of_lots_of"],
};

/* 某知识点答案池不够时的兜底干扰项，保证选项看起来合理 */
const FALLBACK_OPTS = {
  be: ["am", "is", "are"], pres: ["do", "does", "is"], prog: ["am", "is", "are"],
  past: ["was", "were", "did"], futu: ["will", "is", "does"], plural: ["s", "es", "ies"],
  art: ["a", "an", "the"], pron: ["my", "me", "mine"], comp: ["more", "most", "er"],
  prep: ["in", "on", "at"], tb: ["is", "are", "have"], modal: ["can", "must", "may"],
  wh: ["what", "who", "where"], cnt: ["much", "many", "some"],
};

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
           "(KHTML, like Gecko) Chrome/120.0 Safari/537.36";

function allowedUrl(u) {
  try {
    const x = new URL(u);
    return x.protocol === "https:" && /^(www\.)?first-english\.org$/i.test(x.hostname);
  } catch (e) { return false; }
}

function httpGet(url, depth) {
  depth = depth || 0;
  return new Promise((resolve, reject) => {
    if (depth > 4) return reject(new Error("too many redirects"));
    if (!allowedUrl(url)) return reject(new Error("blocked url"));
    const req = https.get(url, {
      headers: {
        "User-Agent": UA,
        "Accept": "text/html,application/xhtml+xml",
        "Accept-Language": "en-US,en;q=0.9",
        "Accept-Encoding": "gzip, deflate, br",
      },
    }, (res) => {
      const code = res.statusCode;
      if ([301, 302, 303, 307, 308].includes(code) && res.headers.location) {
        res.resume();
        return resolve(httpGet(new URL(res.headers.location, url).href, depth + 1));
      }
      if (code !== 200) { res.resume(); return reject(new Error("HTTP " + code)); }
      const chunks = [];
      let size = 0, aborted = false;
      res.on("data", (c) => {
        size += c.length;
        if (size > 3 * 1024 * 1024) { aborted = true; req.destroy(); return; }
        chunks.push(c);
      });
      res.on("end", () => {
        if (aborted) return reject(new Error("too large"));
        let buf = Buffer.concat(chunks);
        const enc = String(res.headers["content-encoding"] || "").toLowerCase();
        try {
          if (enc.includes("br")) buf = zlib.brotliDecompressSync(buf);
          else if (enc.includes("gzip")) buf = zlib.gunzipSync(buf);
          else if (enc.includes("deflate")) buf = zlib.inflateSync(buf);
        } catch (e) { return reject(new Error("decode failed")); }
        resolve(buf);
      });
      res.on("error", reject);
    });
    req.setTimeout(12000, () => req.destroy(new Error("timeout")));
    req.on("error", reject);
  });
}

async function getHtml(url) {
  const buf = await httpGet(url);
  // 该站点声明 iso-8859-1，题目均为英文字符，用 latin1 解码
  return buf.toString("latin1");
}

function unescapeUnicode(s) {
  return String(s).replace(/\\u([0-9a-fA-F]{4})/g, (m, h) =>
    String.fromCharCode(parseInt(h, 16)));
}

function decodeEntities(s) {
  return String(s)
    .replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">").replace(/&quot;/gi, '"').replace(/&#0?39;/gi, "'")
    .replace(/&rsquo;/gi, "'").replace(/&lsquo;/gi, "'")
    .replace(/&[a-z]+;/gi, " ");
}

function stripTags(s) {
  return decodeEntities(String(s).replace(/<[^>]*>/g, " "))
    .replace(/\s+/g, " ").trim();
}

function cleanText(s) {
  // 注意：不能剥 "_"，题干开头的 ____ 空格线必须保留
  return String(s).replace(/^[\s,.;:!?\-—]+/, "").replace(/\s+/g, " ").trim();
}

/* 解析 Hot Potatoes JCloze 页面：题干在表格行里，答案在 I[n][1][0][0] 数组中 */
function parseCloze(html) {
  const answers = {};
  const re = /I\[(\d+)\]\[1\]\[0\]\[0\]\s*=\s*'([^']*)'/g;
  let m;
  while ((m = re.exec(html))) answers[+m[1]] = unescapeUnicode(m[2]);

  const body = html.match(/<div class="ClozeBody">([\s\S]*?)<\/div>\s*<\/form>/i);
  const seg = body ? body[1] : html;
  const rows = seg.match(/<tr[^>]*>[\s\S]*?<\/tr>/gi) || [];
  const items = [];

  rows.forEach((row) => {
    let auto = 0;
    // 把每个输入框换成标记，优先用 id="GapN" 的真实序号
    const marked = row
      .replace(/<input[^>]*\bid=["']?Gap(\d+)["']?[^>]*>/gi, (all, n) => "\u0001" + n + "\u0001")
      .replace(/<input[^>]*>/gi, () => "\u0001" + (auto++) + "\u0001");
    const text = stripTags(marked).replace(/\u0001\s+(\d+)\s+\u0001/g, "\u0001$1\u0001");
    if (text.indexOf("\u0001") < 0) return;

    // 按句子切开，让每道题只对应一个句子，孩子看得懂
    const sents = text.split(/(?<=[.!?])\s+/);
    sents.forEach((sent) => {
      const ids = [];
      const g = /\u0001(\d+)\u0001/g;
      let x;
      while ((x = g.exec(sent))) ids.push(+x[1]);
      if (!ids.length) return;
      ids.forEach((id) => {
        if (answers[id] === undefined || !answers[id].trim()) return;
        let q = sent;
        ids.forEach((o) => {
          const ph = new RegExp("\\u0001" + o + "\\u0001", "g");
          q = q.replace(ph, o === id ? "\u0000GAP\u0000"
            : (answers[o] !== undefined && answers[o].trim() ? answers[o] : "\u0000GAP\u0000"));
        });
        const t = cleanText(q.replace(/\u0000GAP\u0000/g, "____"));
        if (t) items.push({ text: t, answer: answers[id].trim() });
      });
    });
  });
  return items;
}

function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const t = a[i]; a[i] = a[j]; a[j] = t;
  }
  return a;
}

/* 生成 3-4 个选项：正确答案 + 同页其它答案 + 知识点兜底干扰项 */
function makeOptions(correct, pool, topicId) {
  const norm = (s) => String(s).toLowerCase().replace(/[^a-z']/g, "");
  const opts = [correct];
  const seen = new Set([norm(correct)]);
  shuffle(pool.slice()).forEach((c) => {
    if (opts.length >= 4) return;
    const n = norm(c);
    if (!n || seen.has(n)) return;
    opts.push(c); seen.add(n);
  });
  if (opts.length < 4) {
    (FALLBACK_OPTS[topicId] || []).forEach((c) => {
      if (opts.length >= 4) return;
      const n = norm(c);
      if (!n || seen.has(n)) return;
      opts.push(c); seen.add(n);
    });
  }
  return opts.length >= 3 ? shuffle(opts) : [];
}

/* 把解析出的填空项转成单选题 */
function buildQuestions(items, topicId, pageUrl) {
  const pool = [...new Set(items.map((i) => i.answer.trim()))].filter(Boolean);
  // 只保留「答案来自有限小集合」的练习：这类转选择题天然合理；
  // 动词变形等答案发散（went / saw / played…）的练习不适合做选项，直接跳过。
  // 答案池只有 1 种时（如整页只练 a/an）不丢弃，由 FALLBACK_OPTS 补足干扰项。
  if (pool.length < 1 || pool.length > 6) return [];

  const out = [];
  const seenKey = new Set();
  items.forEach((it) => {
    const correct = it.answer.trim();
    const text = it.text;
    if (!correct) return;
    if (text.length < 4 || text.length > 140) return;
    if (!/[a-zA-Z]{2}/.test(text)) return;
    if ((text.match(/____/g) || []).length !== 1) return;
    const key = text.toLowerCase() + "|" + correct.toLowerCase();
    if (seenKey.has(key)) return;
    seenKey.add(key);

    const options = makeOptions(correct, pool, topicId);
    if (!options.length) return;
    const answer = options.indexOf(correct);
    if (answer < 0) return;
    out.push({
      topicId, text, options, answer,
      explain: "正确答案：" + correct + "。本题来自在线题库 first-english.org。",
      origin: "online", src: pageUrl,
    });
  });
  return out;
}

/* 列出某模块目录下的练习页 */
async function listPages(modulePath) {
  const dirUrl = FE_DIR + modulePath + "/";
  const html = await getHtml(dirUrl);
  const hrefs = (html.match(/href="([^"]+\.htm[l]?)"/gi) || [])
    .map((s) => s.replace(/^href="/i, "").replace(/"$/, ""));
  const pages = [];
  hrefs.forEach((h) => {
    if (/^https?:/i.test(h) || h.indexOf("../") === 0 || h[0] === "/" || h[0] === "#") return;
    if (/00_|grammar_rule|_rules|index\.htm/i.test(h)) return;
    try { pages.push(new URL(h, dirUrl).href); } catch (e) {}
  });
  return [...new Set(pages)];
}

async function fetchPageQuestions(pageUrl, topicId) {
  const html = await getHtml(pageUrl);
  let inner = html;
  const ifr = html.match(/<iframe[^>]+src=["']([^"']+)["']/i);
  if (ifr) {
    const target = new URL(ifr[1], pageUrl).href;
    inner = await getHtml(target);
  }
  return buildQuestions(parseCloze(inner), topicId, pageUrl);
}

function cacheFile(topicId) { return path.join(BANK_DIR, topicId + ".json"); }

function readCache(topicId) {
  try {
    const o = JSON.parse(fs.readFileSync(cacheFile(topicId), "utf8"));
    if (o && Array.isArray(o.questions)) return o;
  } catch (e) {}
  return { topic: topicId, pages: [], questions: [], updatedAt: 0 };
}

function writeCache(topicId, obj) {
  try {
    fs.writeFileSync(cacheFile(topicId), JSON.stringify(obj));
  } catch (e) {}
}

async function fetchTopic(topicId, maxPages) {
  const mods = TOPIC_MODULES[topicId];
  if (!mods) return { added: 0, total: 0, pages: 0, error: "unknown topic" };

  let all = [];
  for (const m of mods) {
    try { all = all.concat(await listPages(m)); } catch (e) {}
  }
  if (!all.length) return { added: 0, total: 0, pages: 0, error: "no pages" };

  const cache = readCache(topicId);
  const done = new Set(cache.pages || []);
  let picks = all.filter((u) => !done.has(u));
  if (!picks.length) { picks = all; cache.pages = []; } // 一轮抓完，重新轮转
  picks = picks.slice(0, maxPages);

  const results = await Promise.all(
    picks.map((u) => fetchPageQuestions(u, topicId).catch(() => []))
  );
  const fresh = [].concat.apply([], results);

  const map = new Map();
  (cache.questions || []).forEach((q) => map.set(String(q.text).toLowerCase(), q));
  let added = 0;
  fresh.forEach((q) => {
    const k = String(q.text).toLowerCase();
    if (!map.has(k)) { map.set(k, q); added++; }
  });

  let questions = [...map.values()];
  if (questions.length > 240) questions = questions.slice(questions.length - 240);

  const next = {
    topic: topicId,
    pages: (cache.pages || []).concat(picks),
    questions,
    updatedAt: Date.now(),
  };
  writeCache(topicId, next);
  return { added, total: questions.length, pages: picks.length, questions };
}

function bankStatus() {
  const out = {};
  Object.keys(TOPIC_MODULES).forEach((t) => {
    const c = readCache(t);
    out[t] = { total: c.questions.length, updatedAt: c.updatedAt || 0 };
  });
  return out;
}

/* =========================================================================
 * HTTP 服务
 * ========================================================================= */
http.createServer((req, res) => {
  if (req.method === "OPTIONS") { res.writeHead(204, CORS); return res.end(); }

  const url = new URL(req.url, "http://localhost");
  if (TOKEN && req.headers["x-token"] !== TOKEN) return send(res, 401, { error: "unauthorized" });

  /* 托管前端应用：把 index.html 放进 server/public/ 即可，一个服务同时提供应用 + API */
  if ((url.pathname === "/" || url.pathname === "/index.html") && req.method === "GET") {
    const f = path.join(PUBLIC_DIR, "index.html");
    if (fs.existsSync(f)) {
      res.writeHead(200, Object.assign({ "Content-Type": "text/html; charset=utf-8" }, CORS));
      return fs.createReadStream(f).pipe(res);
    }
  }

  if (url.pathname === "/api/health") return send(res, 200, { ok: true, time: Date.now() });

  /* ---- 在线题库 ---- */
  if (url.pathname === "/api/bank/meta") {
    return send(res, 200, {
      ok: true,
      source: "first-english.org",
      topics: Object.keys(TOPIC_MODULES),
      modules: TOPIC_MODULES,
    });
  }

  if (url.pathname === "/api/bank/status") {
    return send(res, 200, { ok: true, status: bankStatus() });
  }

  if (url.pathname === "/api/bank/sync") {
    const topics = String(url.searchParams.get("topics") || "")
      .split(",").map((s) => s.trim())
      .filter((t) => TOPIC_MODULES[t]);
    const maxPages = Math.min(Math.max(Number(url.searchParams.get("pages") || 2), 1), 4);
    if (!topics.length) return send(res, 400, { error: "no valid topics" });

    const results = {}, questions = {};
    const CONCURRENCY = 3;
    (async () => {
      for (let i = 0; i < topics.length; i += CONCURRENCY) {
        const batch = topics.slice(i, i + CONCURRENCY);
        const got = await Promise.all(batch.map((t) =>
          fetchTopic(t, maxPages).catch((e) => ({ added: 0, total: 0, pages: 0, error: String(e.message || e) }))
        ));
        batch.forEach((t, k) => {
          const r = got[k];
          results[t] = { added: r.added || 0, total: r.total || 0, pages: r.pages || 0, error: r.error };
          questions[t] = (r.questions || []).map((q) => ({
            topicId: q.topicId, text: q.text, options: q.options,
            answer: q.answer, explain: q.explain, origin: "online", src: q.src,
          }));
        });
      }
      send(res, 200, { ok: true, updatedAt: Date.now(), results, questions });
    })().catch((e) => send(res, 500, { error: String(e.message || e) }));
    return;
  }

  /* ---- 云同步数据 ---- */
  if (url.pathname === "/api/data") {
    const space = url.searchParams.get("space") || "";
    if (!validSpace(space)) return send(res, 400, { error: "invalid space code" });
    const file = path.join(DATA_DIR, space + ".json");

    if (req.method === "GET") {
      if (!fs.existsSync(file)) return send(res, 404, { error: "empty" });
      res.writeHead(200, Object.assign({
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
      }, CORS));
      return fs.createReadStream(file).pipe(res);
    }

    if (req.method === "PUT") {
      let size = 0;
      const chunks = [];
      req.on("data", (c) => {
        size += c.length;
        if (size > MAX_BODY) { req.destroy(); return; }
        chunks.push(c);
      });
      req.on("end", () => {
        if (size > MAX_BODY) return send(res, 413, { error: "payload too large" });
        let body;
        try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
        catch (e) { return send(res, 400, { error: "invalid json" }); }
        if (!body || typeof body !== "object" || !body.users || typeof body.users !== "object") {
          return send(res, 400, { error: "missing users" });
        }
        const payload = JSON.stringify({
          users: body.users,
          current: body.current || null,
          updatedAt: Date.now(),
        });
        // 原子写入，避免并发读到半截文件
        const tmp = file + ".tmp";
        fs.writeFile(tmp, payload, (err) => {
          if (err) return send(res, 500, { error: "write failed" });
          fs.rename(tmp, file, (err2) => {
            if (err2) return send(res, 500, { error: "write failed" });
            send(res, 200, { ok: true, savedAt: Date.now() });
          });
        });
      });
      return;
    }

    return send(res, 405, { error: "method not allowed" });
  }

  send(res, 404, { error: "not found" });
}).listen(PORT, () => {
  console.log("语法练习 API 已启动：http://127.0.0.1:" + PORT);
  console.log("数据目录：" + DATA_DIR + (TOKEN ? "（已启用访问口令）" : "（未设置口令，仅建议内网/家庭使用）"));
  console.log("在线题库来源：first-english.org（" + Object.keys(TOPIC_MODULES).length + " 个知识点已映射）");
});
