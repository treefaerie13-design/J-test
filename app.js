/* 日本語復習測験システム
 *
 * 出题设计原则（手编题目时请记住）：
 * - 每道题只考察一个点，挖空/考点唯一，答错归因才清晰。
 * - 选择题干扰项来自同一语义场里最易混淆的结构（如 わけだ/はずだ/べきだ 同放），
 *   考察"语义边界"而非"记不记得这句话"。
 * - expression 类的 explanation 必须写清"为什么是它、为什么不是别的"。
 */

'use strict';

/* ================= 常量与状态 ================= */

const LS = {
  config: 'jq_config',
  theme: 'jq_theme',
  questions: 'jq_questions',
  progressMine: 'jq_progress_mine',
  progressOthers: 'jq_progress_others',
  progressDirty: 'jq_progress_dirty',
  inbox: 'jq_inbox',
  inboxQueue: 'jq_inbox_queue',
};

const state = {
  config: null,            // {owner, repo, token, device}
  questions: [],
  validationErrors: [],
  progressMine: [],        // 本设备答题记录
  progressOthers: [],      // 其他设备记录（GitHub 模式下合并统计用）
  inbox: [],
  shas: { questions: null, inbox: null, progress: null },
  online: false,           // GitHub 连接是否正常
  session: { active: false, q: null, choiceOrder: [], picked: null, answered: false, total: 0, correct: 0, asked: [] },
};

const $ = id => document.getElementById(id);

/* ================= 工具 ================= */

function nowISO() {
  const d = new Date(), p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
function today() { return nowISO().slice(0, 10); }

function b64e(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  bytes.forEach(b => bin += String.fromCharCode(b));
  return btoa(bin);
}
function b64d(b64) {
  const bin = atob(b64.replace(/\s/g, ''));
  return new TextDecoder().decode(Uint8Array.from(bin, c => c.charCodeAt(0)));
}

/* 填空容错：NFKC 归一化（全半角）+ 去所有空白 */
function normalizeAnswer(s) {
  return String(s).normalize('NFKC').replace(/\s+/g, '').trim();
}

function lsGet(key, fallback) {
  try { const v = localStorage.getItem(key); return v === null ? fallback : JSON.parse(v); }
  catch { return fallback; }
}
function lsSet(key, val) {
  try { localStorage.setItem(key, JSON.stringify(val)); } catch { /* 存储满时静默 */ }
}

let toastTimer = null;
function toast(msg, ms = 2200) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), ms);
}

function download(filename, text, mime = 'application/json') {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: mime + ';charset=utf-8' }));
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* ================= GitHub API ================= */

const GH = {
  base: 'https://api.github.com',
  headers() {
    return {
      'Authorization': 'Bearer ' + state.config.token,
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    };
  },
  url(path) { return `${this.base}/repos/${state.config.owner}/${state.config.repo}/contents/${path}`; },
  async getFile(path) {
    const r = await fetch(this.url(path) + '?t=' + Date.now(), { headers: this.headers(), cache: 'no-store' });
    if (r.status === 404) return null;
    if (!r.ok) throw new Error(`读取 ${path} 失败 (${r.status})`);
    const j = await r.json();
    return { text: b64d(j.content), sha: j.sha };
  },
  async putFile(path, text, sha, message) {
    const body = { message, content: b64e(text) };
    if (sha) body.sha = sha;
    const r = await fetch(this.url(path), { method: 'PUT', headers: this.headers(), body: JSON.stringify(body) });
    if (!r.ok) { const e = new Error(`写入 ${path} 失败 (${r.status})`); e.status = r.status; throw e; }
    return (await r.json()).content.sha;
  },
  async listDir(path) {
    const r = await fetch(this.url(path) + '?t=' + Date.now(), { headers: this.headers(), cache: 'no-store' });
    if (r.status === 404) return [];
    if (!r.ok) throw new Error(`列出 ${path} 失败 (${r.status})`);
    const j = await r.json();
    return Array.isArray(j) ? j : [];
  },
};

/* ================= 题库校验 ================= */

function validateQuestion(q, idx) {
  const errs = [];
  const id = q && q.id ? q.id : `（第 ${idx + 1} 条，无 id）`;
  if (!q || typeof q !== 'object') return [`${id}: 不是有效对象`];
  if (!q.id) errs.push(`${id}: 缺少 id`);
  if (!['grammar', 'expression', 'vocab'].includes(q.type)) errs.push(`${id}: type 必须是 grammar/expression/vocab`);
  if (!['choice', 'cloze'].includes(q.format)) errs.push(`${id}: format 必须是 choice/cloze`);
  if (!q.prompt) errs.push(`${id}: 缺少 prompt`);
  if (q.answer === undefined || q.answer === null || q.answer === '') errs.push(`${id}: 缺少 answer`);
  if (q.format === 'choice') {
    if (!Array.isArray(q.choices) || q.choices.length < 2) errs.push(`${id}: choice 题需要至少 2 个选项`);
    else if (!q.choices.includes(q.answer)) errs.push(`${id}: answer 必须与某个选项完全一致`);
  }
  if (!q.explanation) errs.push(`${id}: 缺少 explanation（解析是学习的主体）`);
  return errs;
}

function loadQuestionsFromText(text) {
  let arr;
  try { arr = JSON.parse(text); } catch (e) { throw new Error('题库不是有效 JSON：' + e.message); }
  if (!Array.isArray(arr)) throw new Error('题库顶层必须是数组');
  const valid = [], errors = [];
  const seen = new Set();
  arr.forEach((q, i) => {
    const errs = validateQuestion(q, i);
    if (q && q.id) {
      if (seen.has(q.id)) errs.push(`${q.id}: id 重复`);
      seen.add(q.id);
    }
    if (errs.length) errors.push(...errs);
    else valid.push(q);
  });
  return { valid, errors };
}

function setQuestions(valid, errors) {
  state.questions = valid;
  state.validationErrors = errors;
  lsSet(LS.questions, valid);
  populateFilters();
  renderDataPage();
  updatePoolInfo();
}

/* ================= 数据加载与同步 ================= */

function loadFromCache() {
  state.config = lsGet(LS.config, null);
  state.questions = lsGet(LS.questions, []);
  state.progressMine = lsGet(LS.progressMine, []);
  state.progressOthers = lsGet(LS.progressOthers, []);
  state.inbox = lsGet(LS.inbox, []);
}

function allProgress() { return state.progressMine.concat(state.progressOthers); }

function deviceName() { return (state.config && state.config.device) || 'local'; }

function progressPath() { return `progress/${deviceName()}.json`; }

function setConnStatus(msg, ok) {
  const el = $('conn-status');
  el.textContent = msg;
  el.className = 'status-line ' + (ok === true ? 'ok' : ok === false ? 'ng' : '');
}

/* 从 GitHub 全量拉取；失败时保持缓存数据可用 */
async function ghLoadAll() {
  setConnStatus('连接中……');
  const qf = await GH.getFile('questions.json');
  if (qf) {
    state.shas.questions = qf.sha;
    const { valid, errors } = loadQuestionsFromText(qf.text);
    setQuestions(valid, errors);
  } else {
    setQuestions([], ['仓库中没有 questions.json']);
  }

  const inf = await GH.getFile('inbox.json');
  if (inf) {
    state.shas.inbox = inf.sha;
    try { state.inbox = JSON.parse(inf.text); } catch { state.inbox = []; }
  } else { state.inbox = []; state.shas.inbox = null; }
  lsSet(LS.inbox, state.inbox);

  const files = await GH.listDir('progress');
  const mineName = deviceName() + '.json';
  let others = [];
  state.shas.progress = null;
  for (const f of files) {
    if (!f.name.endsWith('.json')) continue;
    const pf = await GH.getFile('progress/' + f.name);
    if (!pf) continue;
    let recs = [];
    try { recs = JSON.parse(pf.text); } catch { /* 跳过损坏文件 */ }
    if (!Array.isArray(recs)) recs = [];
    if (f.name === mineName) {
      state.shas.progress = pf.sha;
      state.progressMine = mergeRecords(recs, state.progressMine); // 远端 ∪ 本地（本地可能有离线新增）
    } else {
      others = others.concat(recs);
    }
  }
  state.progressOthers = others;
  lsSet(LS.progressMine, state.progressMine);
  lsSet(LS.progressOthers, state.progressOthers);

  state.online = true;
  setConnStatus(`已连接 ${state.config.owner}/${state.config.repo}（设备：${deviceName()}）`, true);
}

function mergeRecords(a, b) {
  const key = r => r.question_id + '|' + r.timestamp;
  const map = new Map();
  a.concat(b).forEach(r => map.set(key(r), r));
  return [...map.values()].sort((x, y) => x.timestamp < y.timestamp ? -1 : 1);
}

/* 推送本设备进度；冲突时拉取合并后重试一次 */
async function pushProgress() {
  if (!state.config) return;
  const path = progressPath();
  const body = JSON.stringify(state.progressMine, null, 2);
  try {
    state.shas.progress = await GH.putFile(path, body, state.shas.progress, `progress: ${deviceName()} ${nowISO()}`);
    lsSet(LS.progressDirty, false);
  } catch (e) {
    if (e.status === 409 || e.status === 422) {
      const pf = await GH.getFile(path);
      if (pf) {
        let remote = [];
        try { remote = JSON.parse(pf.text); } catch { }
        state.progressMine = mergeRecords(remote, state.progressMine);
        lsSet(LS.progressMine, state.progressMine);
        state.shas.progress = await GH.putFile(path, JSON.stringify(state.progressMine, null, 2), pf.sha, `progress: ${deviceName()} ${nowISO()}`);
        lsSet(LS.progressDirty, false);
        return;
      }
    }
    throw e;
  }
}

/* 写回题库（flag 用）；冲突时在最新版本上重放修改 */
async function pushQuestions(applyFn, message) {
  const body = () => JSON.stringify(state.questions, null, 2);
  try {
    state.shas.questions = await GH.putFile('questions.json', body(), state.shas.questions, message);
  } catch (e) {
    if (e.status === 409 || e.status === 422) {
      const qf = await GH.getFile('questions.json');
      if (qf) {
        const { valid, errors } = loadQuestionsFromText(qf.text);
        state.questions = valid;
        state.validationErrors = errors;
        applyFn();
        lsSet(LS.questions, state.questions);
        state.shas.questions = await GH.putFile('questions.json', body(), qf.sha, message);
        return;
      }
    }
    throw e;
  }
}

async function pushInbox() {
  const body = JSON.stringify(state.inbox, null, 2);
  state.shas.inbox = await GH.putFile('inbox.json', body, state.shas.inbox, `inbox: ${nowISO()}`);
}

/* 手动/自动同步：拉取全部 + 冲洗离线队列 */
async function syncNow(silent) {
  if (!state.config) { if (!silent) toast('未配置 GitHub，当前为纯本地模式'); return; }
  try {
    await ghLoadAll();
    const queue = lsGet(LS.inboxQueue, []);
    if (queue.length) {
      state.inbox = state.inbox.concat(queue);
      await pushInbox();
      lsSet(LS.inbox, state.inbox);
      lsSet(LS.inboxQueue, []);
    }
    if (lsGet(LS.progressDirty, false)) await pushProgress();
    renderInbox();
    renderDataPage();
    renderStats();
    if (!silent) toast('同步完成');
  } catch (e) {
    state.online = false;
    setConnStatus('同步失败：' + e.message + '（已用本地缓存，可稍后重试）', false);
    if (!silent) toast('同步失败：' + e.message, 3500);
  }
}

/* ================= 抽题（简化版间隔重复） =================
 * 未来接入真正 SRS（如 SM-2/FSRS）时，替换 weightFor()：
 * 给每题维护 due date + ease，pickNext 改为"优先抽到期题"。
 * 答题记录结构已含 timestamp/correct，足够回放重建调度状态。
 */

function historyMap() {
  const m = new Map();
  for (const r of allProgress()) {
    if (!m.has(r.question_id)) m.set(r.question_id, []);
    m.get(r.question_id).push(r);
  }
  for (const arr of m.values()) arr.sort((a, b) => a.timestamp < b.timestamp ? -1 : 1);
  return m;
}

function weightFor(hist) {
  if (!hist || hist.length === 0) return 3;              // 新题适度优先
  const wrongRate = hist.filter(r => !r.correct).length / hist.length;
  let w = 1 + 4 * wrongRate;                             // 错得越多权重越高
  if (!hist[hist.length - 1].correct) w += 4;            // 最近一次答错，优先重出
  let streak = 0;
  for (let i = hist.length - 1; i >= 0 && hist[i].correct; i--) streak++;
  if (streak >= 2) w *= 0.3;                             // 连对多次的降频
  return w;
}

function activeQuestions() { return state.questions.filter(q => q.status !== 'flagged'); }

function filteredPool() {
  const type = $('f-type').value, tag = $('f-tag').value, gp = $('f-gp').value;
  const wrongOnly = $('f-wrong-only').checked;
  const hm = historyMap();
  return activeQuestions().filter(q => {
    if (type && q.type !== type) return false;
    if (tag && !(q.tags || []).includes(tag)) return false;
    if (gp && q.grammar_point !== gp) return false;
    if (wrongOnly) {
      const h = hm.get(q.id);
      if (!h || !h.some(r => !r.correct) || h[h.length - 1].correct) return false;
    }
    return true;
  });
}

function pickNext() {
  const pool = filteredPool();
  if (!pool.length) return null;
  const hm = historyMap();
  const lastId = state.session.q ? state.session.q.id : null;
  const weighted = pool.map(q => {
    let w = weightFor(hm.get(q.id));
    if (state.session.asked.includes(q.id)) w *= 0.15;   // 本轮出过的先放放
    if (q.id === lastId && pool.length > 1) w = 0;       // 不连续重复
    return { q, w };
  });
  let total = weighted.reduce((s, x) => s + x.w, 0);
  if (total <= 0) return pool[Math.floor(Math.random() * pool.length)];
  let r = Math.random() * total;
  for (const x of weighted) { r -= x.w; if (r <= 0) return x.q; }
  return weighted[weighted.length - 1].q;
}

/* ================= 答题界面 ================= */

const TYPE_LABEL = { grammar: '语法', expression: '表达', vocab: '词汇' };

function updatePoolInfo() {
  const el = $('pool-info');
  const total = activeQuestions().length;
  if (!state.questions.length) {
    el.textContent = '题库为空——在「数据」页配置 GitHub 或载入题库文件。';
    return;
  }
  el.textContent = `题库 ${total} 题，当前筛选可抽 ${filteredPool().length} 题。`;
}

function populateFilters() {
  const tags = new Set(), gps = new Set();
  activeQuestions().forEach(q => {
    (q.tags || []).forEach(t => tags.add(t));
    if (q.grammar_point) gps.add(q.grammar_point);
  });
  const fill = (sel, values) => {
    const cur = sel.value;
    sel.innerHTML = '<option value="">全部</option>' + [...values].sort().map(v => `<option>${escapeHtml(v)}</option>`).join('');
    if ([...sel.options].some(o => o.value === cur)) sel.value = cur;
  };
  fill($('f-tag'), tags);
  fill($('f-gp'), gps);
}

function startSession() {
  const pool = filteredPool();
  if (!pool.length) { toast('当前筛选下没有可抽的题'); return; }
  state.session = { active: true, q: null, choiceOrder: [], picked: null, answered: false, total: 0, correct: 0, asked: [] };
  $('quiz-setup').classList.add('hidden');
  $('quiz-card').classList.remove('hidden');
  showQuestion(pickNext());
}

function stopSession() {
  state.session.active = false;
  $('quiz-card').classList.add('hidden');
  $('quiz-setup').classList.remove('hidden');
  updatePoolInfo();
}

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function showQuestion(q) {
  if (!q) { toast('没有更多题了'); stopSession(); return; }
  const s = state.session;
  s.q = q; s.answered = false; s.picked = null;
  if (!s.asked.includes(q.id)) s.asked.push(q.id);

  $('q-type-badge').textContent = TYPE_LABEL[q.type] || q.type;
  $('session-score').textContent = s.total ? `本次 ${s.correct}/${s.total}` : '';
  $('q-prompt').textContent = q.prompt;
  $('q-translation').textContent = q.context_translation || '';
  $('q-hint').textContent = q.blank_hint ? '提示：' + q.blank_hint : '';
  $('q-result').classList.add('hidden');
  $('answer-actions').classList.remove('hidden');

  if (q.format === 'choice') {
    s.choiceOrder = shuffle(q.choices);
    $('q-cloze').classList.add('hidden');
    const box = $('q-choices');
    box.classList.remove('hidden');
    box.innerHTML = '';
    s.choiceOrder.forEach((c, i) => {
      const b = document.createElement('button');
      b.className = 'choice-btn';
      b.innerHTML = `<span class="key">${i + 1}</span>${escapeHtml(c)}`;
      b.onclick = () => selectChoice(i);
      box.appendChild(b);
    });
  } else {
    $('q-choices').classList.add('hidden');
    $('q-cloze').classList.remove('hidden');
    const inp = $('cloze-input');
    inp.value = '';
    inp.disabled = false;
    setTimeout(() => inp.focus(), 50);
  }
}

function selectChoice(i) {
  if (state.session.answered) return;
  state.session.picked = i;
  [...$('q-choices').children].forEach((b, j) => b.classList.toggle('selected', j === i));
}

function submitAnswer() {
  const s = state.session;
  if (!s.q || s.answered) return;
  const q = s.q;
  let userAnswer, correct;

  if (q.format === 'choice') {
    if (s.picked === null) { toast('先选一个选项'); return; }
    userAnswer = s.choiceOrder[s.picked];
    correct = userAnswer === q.answer;
    [...$('q-choices').children].forEach((b, j) => {
      const text = s.choiceOrder[j];
      if (text === q.answer) b.classList.add('correct');
      else if (j === s.picked) b.classList.add('wrong');
      b.disabled = true;
    });
  } else {
    userAnswer = $('cloze-input').value;
    if (!normalizeAnswer(userAnswer)) { toast('先输入答案'); return; }
    const accepted = Array.isArray(q.answer) ? q.answer : [q.answer];
    correct = accepted.some(a => normalizeAnswer(a) === normalizeAnswer(userAnswer));
    $('cloze-input').disabled = true;
  }

  s.answered = true;
  s.total++;
  if (correct) s.correct++;
  $('session-score').textContent = `本次 ${s.correct}/${s.total}`;

  recordAnswer(q, correct, userAnswer);
  revealResult(correct, correct ? '○ 正解' : '× 不正解');
}

function revealResult(ok, verdictText) {
  const q = state.session.q;
  const verdict = $('result-verdict');
  verdict.textContent = verdictText;
  verdict.className = ok ? 'ok' : 'ng';
  const accepted = Array.isArray(q.answer) ? q.answer.join(' ／ ') : q.answer;
  $('result-answer').textContent = '答案：' + accepted;
  $('result-explanation').textContent = q.explanation || '';
  $('answer-actions').classList.add('hidden');
  $('q-result').classList.remove('hidden');
  setTimeout(() => $('btn-next').focus(), 50);
}

/* 「我不会」：记为答错，直接看解析——比瞎蒙更诚实的主动回忆信号 */
function giveUp() {
  const s = state.session;
  if (!s.q || s.answered) return;
  const q = s.q;
  s.answered = true;
  s.total++;
  $('session-score').textContent = `本次 ${s.correct}/${s.total}`;
  if (q.format === 'choice') {
    [...$('q-choices').children].forEach((b, j) => {
      if (s.choiceOrder[j] === q.answer) b.classList.add('correct');
      b.disabled = true;
    });
  } else {
    $('cloze-input').disabled = true;
  }
  recordAnswer(q, false, '（我不会）');
  revealResult(false, '× 不会——先把解析记一下');
}

/* 「跳过此题」：不留任何记录，换下一题 */
function skipQuestion() {
  const s = state.session;
  if (!s.q || s.answered) return;
  showQuestion(pickNext());
}

function recordAnswer(q, correct, userAnswer) {
  const rec = {
    question_id: q.id,
    timestamp: nowISO(),
    correct,
    user_answer: userAnswer,
    grammar_point: q.grammar_point || null,
    type: q.type,
    tags: q.tags || [],
  };
  state.progressMine.push(rec);
  lsSet(LS.progressMine, state.progressMine);
  if (state.config) {
    lsSet(LS.progressDirty, true);
    pushProgress().catch(() => {
      state.online = false;
      setConnStatus('进度暂存本机，恢复网络后点「立即同步」', false);
    });
  }
}

async function flagCurrent() {
  const q = state.session.q;
  if (!q) return;
  const note = prompt('这题哪里有问题？（可留空）', '') ;
  if (note === null) return;
  const apply = () => {
    const target = state.questions.find(x => x.id === q.id);
    if (target) { target.status = 'flagged'; target.flag_note = note || null; }
  };
  apply();
  lsSet(LS.questions, state.questions);
  toast('已标记，该题移出抽题池');
  if (state.config) {
    try { await pushQuestions(apply, `flag ${q.id}: ${note || '(no note)'}`); }
    catch (e) { toast('标记已存本地，写回仓库失败：' + e.message, 3500); }
  }
  renderDataPage();
  showQuestion(pickNext());
}

/* ================= 弱点报告 ================= */

function computeGroups(records, keyFn) {
  const groups = new Map();
  for (const r of records) {
    for (const k of keyFn(r)) {
      if (!k) continue;
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(r);
    }
  }
  const rows = [];
  for (const [name, recs] of groups) {
    recs.sort((a, b) => a.timestamp < b.timestamp ? -1 : 1);
    const total = recs.length;
    const correct = recs.filter(r => r.correct).length;
    const recent = recs.slice(-5);
    const recentAcc = recent.filter(r => r.correct).length / recent.length;
    const acc = correct / total;
    rows.push({ name, total, acc, recentAcc });
  }
  rows.sort((a, b) => a.acc - b.acc || b.total - a.total);
  return rows;
}

function statsRecords() {
  const flagged = new Set(state.questions.filter(q => q.status === 'flagged').map(q => q.id));
  return allProgress().filter(r => !flagged.has(r.question_id));  // 坏题不污染统计
}

function trendArrow(row) {
  if (row.total < 3) return '·';
  if (row.recentAcc - row.acc > 0.1) return '↑';
  if (row.recentAcc - row.acc < -0.1) return '↓';
  return '→';
}

function renderStats() {
  const el = $('stats-content');
  const records = statsRecords();
  if (!records.length) {
    el.innerHTML = '<p class="muted">还没有答题记录。去答几道题，弱点报告会在这里生长出来。</p>';
    return;
  }
  const sections = [
    { title: '按语法点 / 目标词（最虚的在最前）', rows: computeGroups(records, r => [r.grammar_point]) },
    { title: '按标签（语义场）', rows: computeGroups(records, r => r.tags || []) },
    { title: '按类型', rows: computeGroups(records, r => [TYPE_LABEL[r.type] || r.type]) },
  ];
  el.innerHTML = sections.map(sec => `
    <div class="stat-section">
      <h3>${sec.title}</h3>
      ${sec.rows.map(row => `
        <div class="stat-row">
          <span class="stat-name" title="${escapeHtml(row.name)}">${escapeHtml(row.name)}</span>
          <span class="stat-bar-wrap"><span class="stat-bar" style="width:${Math.round(row.acc * 100)}%"></span></span>
          <span class="stat-num">${Math.round(row.acc * 100)}% · ${row.total} 题</span>
          <span class="stat-trend" title="最近5次趋势">${trendArrow(row)}</span>
        </div>`).join('')}
    </div>`).join('');
}

function reportMarkdown() {
  const records = statsRecords();
  const lines = [`# 日语弱点报告 ${today()}`, '', `共 ${records.length} 条答题记录（多设备合并，已排除坏题）。`, ''];
  const secs = [
    ['按语法点 / 目标词', computeGroups(records, r => [r.grammar_point])],
    ['按标签（语义场）', computeGroups(records, r => r.tags || [])],
    ['按类型', computeGroups(records, r => [TYPE_LABEL[r.type] || r.type])],
  ];
  for (const [title, rows] of secs) {
    lines.push(`## ${title}`, '', '| 项目 | 正确率 | 题数 | 最近趋势 |', '|---|---|---|---|');
    rows.forEach(r => lines.push(`| ${r.name} | ${Math.round(r.acc * 100)}% | ${r.total} | ${trendArrow(r)} |`));
    lines.push('');
  }
  return lines.join('\n');
}

/* ================= 收集（收件箱） ================= */

function renderInbox() {
  const pending = state.inbox.filter(i => i.status === 'pending');
  const queued = lsGet(LS.inboxQueue, []);
  $('inbox-count').textContent = pending.length + queued.length;
  const list = $('inbox-list');
  const items = queued.map(i => ({ ...i, _queued: true })).concat(pending.slice().reverse());
  list.innerHTML = items.length ? '' : '<p class="muted">收件箱是空的。</p>';
  items.forEach(item => {
    const div = document.createElement('div');
    div.className = 'inbox-item';
    div.textContent = item.text;
    const meta = document.createElement('div');
    meta.className = 'meta';
    meta.innerHTML = `<span>${escapeHtml(item.added_at)} · ${escapeHtml(item.device)}${item._queued ? ' · 待上传' : ''}</span>`;
    const del = document.createElement('button');
    del.className = 'link-btn';
    del.textContent = '删除';
    del.onclick = () => removeInboxItem(item);
    meta.appendChild(del);
    div.appendChild(meta);
    list.appendChild(div);
  });
}

async function saveCollect() {
  const text = $('collect-text').value.trim();
  if (!text) { toast('内容是空的'); return; }
  const item = {
    id: 'in-' + Date.now().toString(36),
    text,
    added_at: nowISO(),
    device: deviceName(),
    status: 'pending',
  };
  $('collect-text').value = '';
  if (state.config) {
    try {
      const inf = await GH.getFile('inbox.json');       // 取最新，避免覆盖其他设备刚存的
      if (inf) { try { state.inbox = JSON.parse(inf.text); } catch { } state.shas.inbox = inf.sha; }
      state.inbox.push(item);
      await pushInbox();
      lsSet(LS.inbox, state.inbox);
      $('collect-status').textContent = '已存入仓库收件箱 ✓';
    } catch (e) {
      const queue = lsGet(LS.inboxQueue, []);
      queue.push(item);
      lsSet(LS.inboxQueue, queue);
      $('collect-status').textContent = '离线：已暂存本机，联网同步后会自动上传';
    }
  } else {
    state.inbox.push(item);
    lsSet(LS.inbox, state.inbox);
    $('collect-status').textContent = '已存入本地收件箱（纯本地模式）';
  }
  renderInbox();
}

async function removeInboxItem(item) {
  if (item._queued) {
    lsSet(LS.inboxQueue, lsGet(LS.inboxQueue, []).filter(i => i.id !== item.id));
  } else {
    state.inbox = state.inbox.filter(i => i.id !== item.id);
    lsSet(LS.inbox, state.inbox);
    if (state.config) {
      try { await pushInbox(); } catch (e) { toast('删除已存本地，写回失败：' + e.message); }
    }
  }
  renderInbox();
}

/* ================= 数据页 ================= */

function renderDataPage() {
  const c = state.config;
  $('cfg-owner').value = c ? c.owner : '';
  $('cfg-repo').value = c ? c.repo : '';
  $('cfg-token').value = c ? c.token : '';
  $('cfg-device').value = c ? c.device : '';

  const flagged = state.questions.filter(q => q.status === 'flagged').length;
  const pending = state.inbox.filter(i => i.status === 'pending').length + lsGet(LS.inboxQueue, []).length;
  $('data-summary').textContent =
    `题库 ${state.questions.length} 题（可抽 ${state.questions.length - flagged}，已标记问题 ${flagged}）；` +
    `答题记录 ${allProgress().length} 条（本设备 ${state.progressMine.length}）；收件箱待处理 ${pending} 条。`;
  $('validation-errors').textContent = state.validationErrors.length
    ? '题库格式问题（这些题已被跳过）：\n' + state.validationErrors.join('\n') : '';
}

async function saveConfig() {
  const owner = $('cfg-owner').value.trim();
  const repo = $('cfg-repo').value.trim();
  const token = $('cfg-token').value.trim();
  const device = $('cfg-device').value.trim();
  if (!owner || !repo || !token || !device) { toast('四项都要填'); return; }
  state.config = { owner, repo, token, device };
  lsSet(LS.config, state.config);
  await syncNow();
}

function clearConfig() {
  if (!confirm('清除本机的 GitHub 配置（含 token）？仓库里的数据不受影响。')) return;
  state.config = null;
  localStorage.removeItem(LS.config);
  setConnStatus('未配置，纯本地模式');
  renderDataPage();
}

/* ---- 本地文件导入导出 ---- */

function importQuestionsFile(file) {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const { valid, errors } = loadQuestionsFromText(reader.result);
      setQuestions(valid, errors);
      toast(`载入 ${valid.length} 题` + (errors.length ? `，${errors.length} 个格式问题见「数据」页` : ''));
    } catch (e) { toast(e.message, 4000); }
  };
  reader.readAsText(file, 'utf-8');
}

function importProgressFile(file) {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const arr = JSON.parse(reader.result);
      if (!Array.isArray(arr)) throw new Error('进度文件顶层必须是数组');
      state.progressMine = mergeRecords(state.progressMine, arr);
      lsSet(LS.progressMine, state.progressMine);
      renderStats(); renderDataPage();
      toast(`合并后本设备共 ${state.progressMine.length} 条记录`);
    } catch (e) { toast('载入失败：' + e.message, 4000); }
  };
  reader.readAsText(file, 'utf-8');
}

/* ================= 键盘 ================= */

document.addEventListener('keydown', e => {
  if (!state.session.active || $('quiz-card').classList.contains('hidden')) return;
  const s = state.session;
  const inCloze = document.activeElement === $('cloze-input');
  if (e.key === 'Enter') {
    e.preventDefault();
    if (s.answered) $('btn-next').click();
    else submitAnswer();
    return;
  }
  if (e.key === 'Escape' && !s.answered) { skipQuestion(); return; }
  if (inCloze) return;
  if (e.key === '0' && !s.answered) { giveUp(); return; }
  if (!s.answered && s.q && s.q.format === 'choice' && /^[1-9]$/.test(e.key)) {
    const i = parseInt(e.key, 10) - 1;
    if (i < s.choiceOrder.length) selectChoice(i);
  }
});

/* ================= 主题与导航 ================= */

function applyTheme(t) {
  document.documentElement.dataset.theme = t;
  lsSet(LS.theme, t);
}

function switchView(name) {
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
  $('view-' + name).classList.add('active');
  document.querySelector(`.nav-btn[data-view="${name}"]`).classList.add('active');
  if (name === 'stats') renderStats();
  if (name === 'collect') renderInbox();
  if (name === 'data') renderDataPage();
  if (name === 'quiz') updatePoolInfo();
}

/* ================= 启动 ================= */

function bind() {
  document.querySelectorAll('.nav-btn').forEach(b => b.onclick = () => switchView(b.dataset.view));
  $('theme-toggle').onclick = () => applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');
  $('btn-start').onclick = startSession;
  $('btn-stop').onclick = stopSession;
  $('btn-submit').onclick = submitAnswer;
  $('btn-idk').onclick = giveUp;
  $('btn-skip').onclick = skipQuestion;
  $('btn-next').onclick = () => showQuestion(pickNext());
  $('btn-flag').onclick = flagCurrent;
  ['f-type', 'f-tag', 'f-gp', 'f-wrong-only'].forEach(id => $(id).onchange = updatePoolInfo);
  $('btn-export-report').onclick = () => download(`弱点报告_${today()}.md`, reportMarkdown(), 'text/markdown');
  $('btn-collect-save').onclick = saveCollect;
  $('btn-cfg-save').onclick = saveConfig;
  $('btn-cfg-clear').onclick = clearConfig;
  $('btn-sync').onclick = () => syncNow();
  $('btn-import-questions').onclick = () => $('file-questions').click();
  $('file-questions').onchange = e => { if (e.target.files[0]) importQuestionsFile(e.target.files[0]); e.target.value = ''; };
  $('btn-export-questions').onclick = () => download('questions.json', JSON.stringify(state.questions, null, 2));
  $('btn-import-progress').onclick = () => $('file-progress').click();
  $('file-progress').onchange = e => { if (e.target.files[0]) importProgressFile(e.target.files[0]); e.target.value = ''; };
}

function init() {
  const savedTheme = lsGet(LS.theme, null);
  applyTheme(savedTheme || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'));
  loadFromCache();
  bind();
  populateFilters();
  updatePoolInfo();
  renderDataPage();
  renderInbox();
  if (state.config) {
    setConnStatus('使用缓存数据，后台同步中……');
    syncNow(true);
  } else {
    setConnStatus('未配置 GitHub，纯本地模式（文件导入导出）');
  }
}

init();
