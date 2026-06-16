// ════════════════════════════════════════════════════════════
// 即投 — DOM 工具函数
// ════════════════════════════════════════════════════════════

window.$ = function $(sel, ctx) {
  return (ctx || document).querySelector(sel);
};

window.$$ = function $$(sel, ctx) {
  return [].slice.call((ctx || document).querySelectorAll(sel));
};

// ── 原子化 chrome.storage resumeImages 操作 ──
// 避免 upload / remove 之间的 get-then-set 竞态
// 用 Promise 链串行化所有读写，确保一次只执行一个 get-then-set 周期
var _resumeImagesChain = Promise.resolve();

function atomicUpdateResumeImages(transformFn) {
  _resumeImagesChain = _resumeImagesChain.then(function() {
    return new Promise(function(resolve) {
      chrome.storage.local.get('resumeImages', function(r) {
        try {
          var arr = transformFn(r.resumeImages || []);
          chrome.storage.local.set({resumeImages: arr}, resolve);
        } catch (e) {
          resolve(); // 不因异常打断链
        }
      });
    });
  });
  return _resumeImagesChain;
}

window.esc = function esc(str) {
  var d = document.createElement('div');
  d.textContent = str;
  return d.innerHTML;
};

window.tog = function tog(arr, v) {
  var i = arr.indexOf(v);
  if (i >= 0) { arr.splice(i, 1); return false; }
  arr.push(v);
  return true;
};

window.togD = function togD(arr, v, h) {
  if (v === '不限' && h) { arr.length = 0; arr.push('不限'); return; }
  if (h) { var i = arr.indexOf('不限'); if (i >= 0) arr.splice(i, 1); }
  var i = arr.indexOf(v);
  if (i >= 0) arr.splice(i, 1);
  else arr.push(v);
  if (h && arr.length === 0) arr.push('不限');
};

// 收集所有配置的附件简历名称，同步到 chrome.storage 供 ChatMonitor 读取
window.syncResumeFileNames = function syncResumeFileNames() {
  var names = [];
  var groups = Store.get('groups') || [];
  groups.forEach(function(g) {
    if (g.fileName && names.indexOf(g.fileName) < 0) names.push(g.fileName);
  });
  var jc = Store.get('jobCustom') || {};
  for (var id in jc) {
    var n = jc[id].customFileName;
    if (n && names.indexOf(n) < 0) names.push(n);
  }
  chrome.storage.local.set({ resumeFileNames: names });
};
