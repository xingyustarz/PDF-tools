/* ==========================================================================
   app.js — 主应用逻辑
   负责：状态管理、pdf.js 渲染、事件绑定、UI 渲染、弹窗 / Toast / 进度提示
   ========================================================================== */
(function (global) {
  'use strict';

  /* ---------------------------------------------------------------------
     全局状态（按需求约定挂在 window 上）
     --------------------------------------------------------------------- */
  window.pdfDoc = null;           // pdf-lib PDFDocument（可编辑）
  window.pdfjsDoc = null;         // pdf.js PDFDocumentProxy（用于渲染 / 取文本）
  window.currentPage = 1;         // 当前页码（1 基）
  window.selectedPages = new Set(); // 选中页面集合（1 基页码）
  window.pageRotation = {};       // 页面旋转状态记录 { [pageNo]: degrees }
  window.clipboardPages = null;   // 剪贴板：{ bytes:Uint8Array, indices:number[] }
  window.zoomLevel = 1;           // 当前缩放比例
  window.readMode = 'page';       // 阅读模式：'page' 逐页 | 'continuous' 连续

  /* 内部状态 */
  var state = {
    fileName: '',
    fileSize: 0,
    fileBytes: null,          // 原始 ArrayBuffer（用于"重置"）
    pendingEdits: [],         // 待应用的编辑 [{type:'text'|'image', page, ...}]
    renderToken: 0,           // 渲染竞态令牌
    thumbToken: 0,            // 缩略图渲染令牌
    dragSource: null,         // 缩略图拖拽源
    continuousPages: null,    // 连续模式下的页面元素列表
    continuousScale: 1        // 连续模式下的渲染缩放
  };

  /* DOM 快捷引用 */
  var $ = function (id) { return document.getElementById(id); };
  var el = {};

  /* ---------------------------------------------------------------------
     初始化
     --------------------------------------------------------------------- */
  function init() {
    cacheDom();
    setupPdfJs();
    bindToolbar();
    bindViewer();
    bindContinuousScroll();
    bindSidebar();
    bindModal();
    bindDragDrop();
    bindKeyboard();
    updateUiState();
    setStatus('就绪，请打开一个 PDF 文件');
  }

  function cacheDom() {
    el.fileInput = $('fileInput');
    el.imageInput = $('imageInput');
    el.thumbList = $('thumbList');
    el.thumbEmpty = $('thumbEmpty');
    el.sidebar = $('sidebar');
    el.canvas = $('pdfCanvas');
    el.editLayer = $('editLayer');
    el.canvasHolder = $('canvasHolder');
    el.canvasScroll = $('canvasScroll');
    el.canvasStage = $('canvasStage');
    el.continuousContainer = $('continuousContainer');
    el.readModeBtn = $('readModeBtn');
    el.placeholder = $('viewerPlaceholder');
    el.pageInput = $('pageInput');
    el.pageCount = $('pageCount');
    el.zoomSelect = $('zoomSelect');
    el.modalMask = $('modalMask');
    el.modalBox = $('modalBox');
    el.modalTitle = $('modalTitle');
    el.modalBody = $('modalBody');
    el.modalFoot = $('modalFoot');
    el.modalCancel = $('modalCancel');
    el.modalConfirm = $('modalConfirm');
    el.loadingMask = $('loadingMask');
    el.loadingText = $('loadingText');
    el.progressBar = $('progressBar');
    el.toastWrap = $('toastWrap');
    el.applyEdits = $('applyEdits');
    el.clearEdits = $('clearEdits');
  }

  /** 配置 pdf.js worker 及可选资源（cMap / 标准字体） */
  function setupPdfJs() {
    if (!global.pdfjsLib) return;
    var CDN = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174';
    global.pdfjsLib.GlobalWorkerOptions.workerSrc = CDN + '/build/pdf.worker.min.js';
    // 中文 PDF 的 CMap 与标准字体（部分 PDF 未内嵌字体，需要回退数据）
    state.pdfjsAssets = {
      cMapUrl: CDN + '/cmaps/',
      cMapPacked: true,
      standardFontDataUrl: CDN + '/standard_fonts/'
    };
  }

  /* =====================================================================
     Toast 提示
     ===================================================================== */
  var TOAST_ICONS = {
    success: '<path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/>',
    error:   '<path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z"/>',
    warn:    '<path d="M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2v-4h2v4z"/>',
    info:    '<path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm1 15h-2v-6h2v6zm0-8h-2V7h2v2z"/>'
  };

  /**
   * 显示 Toast
   * @param {string} msg
   * @param {'success'|'error'|'warn'|'info'} type
   * @param {number} [duration]
   */
  function toast(msg, type, duration) {
    type = type || 'info';
    var node = document.createElement('div');
    node.className = 'toast ' + type;
    node.innerHTML =
      '<span class="ico"><svg viewBox="0 0 24 24">' + (TOAST_ICONS[type] || TOAST_ICONS.info) + '</svg></span>' +
      '<span class="txt"></span>';
    node.querySelector('.txt').textContent = String(msg);
    el.toastWrap.appendChild(node);

    var t = setTimeout(remove, duration || (type === 'error' ? 5200 : 2800));
    node.addEventListener('click', function () { clearTimeout(t); remove(); });

    function remove() {
      if (!node.parentNode) return;
      node.classList.add('out');
      setTimeout(function () {
        if (node.parentNode) node.parentNode.removeChild(node);
      }, 220);
    }
  }

  /* =====================================================================
     状态栏 / 加载遮罩
     ===================================================================== */
  function setStatus(text, kind) {
    $('statusText').textContent = text;
    var dot = $('statusDot');
    dot.className = 'status-dot' + (kind ? ' ' + kind : '');
  }

  function showLoading(text, showProgress) {
    el.loadingText.textContent = text || '处理中…';
    el.progressBar.style.width = '0%';
    el.progressBar.parentNode.style.display = showProgress ? '' : 'none';
    el.loadingMask.hidden = false;
  }

  function setProgress(done, total) {
    if (!total) return;
    var pct = Math.max(0, Math.min(100, (done / total) * 100));
    el.progressBar.style.width = pct.toFixed(1) + '%';
  }

  function hideLoading() {
    el.loadingMask.hidden = true;
  }

  /**
   * 统一包装异步操作：显示 loading、捕获错误、恢复状态
   * @param {string} loadingText
   * @param {function} fn (report) => Promise
   * @param {object} [opts] { progress:boolean, successMsg:string }
   */
  function run(loadingText, fn, opts) {
    opts = opts || {};
    showLoading(loadingText, !!opts.progress);
    setStatus(loadingText, 'busy');

    var report = function (done, total) { setProgress(done, total); };

    return Promise.resolve()
      .then(function () { return fn(report); })
      .then(function (res) {
        hideLoading();
        setStatus('就绪', 'ok');
        if (opts.successMsg) toast(opts.successMsg, 'success');
        return res;
      })
      .catch(function (err) {
        hideLoading();
        var msg = (err && err.message) ? err.message : String(err);
        setStatus('操作失败', 'err');
        toast(msg, 'error');
        console.error('[PDF 工具箱]', err);
        throw err;
      });
  }

  /* =====================================================================
     弹窗系统
     ===================================================================== */

  /**
   * 打开弹窗
   * @param {object} cfg
   *   { title, html, wide, confirmText, cancelText, onConfirm, onOpen, hideFooter }
   *   onConfirm(modalBodyEl) 返回 false 可阻止关闭；返回 Promise 时自动等待
   */
  var modalCfg = null;

  /** 打开弹窗 */
  function openModal(cfg) {
    modalCfg = cfg || {};
    el.modalTitle.textContent = modalCfg.title || '';
    el.modalBody.innerHTML = modalCfg.html || '';
    el.modalBox.className = 'modal' + (modalCfg.wide ? ' wide' : '');
    el.modalConfirm.textContent = modalCfg.confirmText || '确定';
    el.modalCancel.textContent = modalCfg.cancelText || '取消';
    el.modalFoot.hidden = !!modalCfg.hideFooter;
    // 复位确认按钮样式（危险操作会另行切换）
    el.modalConfirm.classList.add('btn-primary');
    el.modalConfirm.classList.remove('btn-danger');
    el.modalMask.hidden = false;

    if (typeof modalCfg.onOpen === 'function') modalCfg.onOpen(el.modalBody);
    // 聚焦第一个输入框
    var first = el.modalBody.querySelector('input:not([type=hidden]), select, textarea');
    if (first) setTimeout(function () { first.focus(); }, 30);
  }

  function closeModal() {
    el.modalMask.hidden = true;
    el.modalBody.innerHTML = '';
    modalCfg = null;
  }

  function bindModal() {
    $('modalClose').addEventListener('click', closeModal);
    el.modalCancel.addEventListener('click', closeModal);
    el.modalMask.addEventListener('mousedown', function (e) {
      if (e.target === el.modalMask) closeModal();
    });
    el.modalConfirm.addEventListener('click', function () {
      if (!modalCfg || typeof modalCfg.onConfirm !== 'function') { closeModal(); return; }
      var btn = el.modalConfirm;
      var res;
      try {
        res = modalCfg.onConfirm(el.modalBody);
      } catch (err) {
        toast(err.message || String(err), 'error');
        return;
      }
      if (res === false) return;                       // 校验未通过，保持弹窗
      if (res && typeof res.then === 'function') {
        btn.disabled = true;
        var oldText = btn.textContent;
        btn.textContent = '处理中…';
        res.then(function (ok) {
          btn.disabled = false;
          btn.textContent = oldText;
          if (ok !== false) closeModal();
        }).catch(function () {
          btn.disabled = false;
          btn.textContent = oldText;
        });
        return;
      }
      closeModal();
    });
    // 弹窗内 Enter 确认（textarea 除外）
    el.modalBody.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && e.target.tagName !== 'TEXTAREA' && !e.shiftKey) {
        e.preventDefault();
        el.modalConfirm.click();
      }
    });
  }

  /** 确认对话框 */
  function confirmDialog(title, message, onOk, danger) {
    openModal({
      title: title,
      html: '<div class="note' + (danger ? ' warn' : '') + '">' +
            escapeHtml(message) + '</div>',
      confirmText: danger ? '确认执行' : '确定',
      cancelText: '取消',
      onConfirm: function () {
        if (typeof onOk === 'function') onOk();
      }
    });
    if (danger) {
      el.modalConfirm.classList.remove('btn-primary');
      el.modalConfirm.classList.add('btn-danger');
    }
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  /** 构建单选 chip 组 HTML */
  function chipGroup(name, options, selected) {
    return '<div class="radio-row">' + options.map(function (o) {
      var checked = String(o.value) === String(selected);
      return '<label class="radio-chip' + (checked ? ' checked' : '') + '">' +
        '<input type="radio" name="' + name + '" value="' + escapeHtml(o.value) + '"' +
        (checked ? ' checked' : '') + '>' + escapeHtml(o.label) + '</label>';
    }).join('') + '</div>';
  }

  /** 绑定 chip 组的选中样式（radio 按 name 分组互斥，checkbox 只切换自身） */
  function bindChips(root) {
    root.querySelectorAll('.radio-chip input').forEach(function (input) {
      input.addEventListener('change', function () {
        if (input.type === 'radio') {
          root.querySelectorAll('.radio-chip input[name="' + input.name + '"]').forEach(function (i) {
            i.closest('.radio-chip').classList.toggle('checked', i.checked);
          });
        } else {
          // checkbox：无 name，只切换自身，避免同组内互相影响
          input.closest('.radio-chip').classList.toggle('checked', input.checked);
        }
      });
    });
  }

  /** 读取 chip 组的选中值 */
  function chipValue(root, name, fallback) {
    var checked = root.querySelector('input[name="' + name + '"]:checked');
    return checked ? checked.value : fallback;
  }

  /* =====================================================================
     文件加载
     ===================================================================== */
  function bindDragDrop() {
    var ph = el.placeholder;
    ['dragenter', 'dragover'].forEach(function (ev) {
      ph.addEventListener(ev, function (e) {
        e.preventDefault(); e.stopPropagation();
        ph.classList.add('dragover');
      });
    });
    ['dragleave', 'drop'].forEach(function (ev) {
      ph.addEventListener(ev, function (e) {
        e.preventDefault(); e.stopPropagation();
        if (ev === 'dragleave' && ph.contains(e.relatedTarget)) return;
        ph.classList.remove('dragover');
      });
    });
    ph.addEventListener('drop', function (e) {
      var files = e.dataTransfer && e.dataTransfer.files;
      if (files && files.length) loadFile(files[0]);
    });

    // 阻止浏览器默认打开文件行为
    ['dragover', 'drop'].forEach(function (ev) {
      window.addEventListener(ev, function (e) {
        if (e.target === ph) return;
        e.preventDefault();
      });
    });
  }

  function pickFile() { el.fileInput.click(); }

  function loadFile(file) {
    if (!file) return;
    if (!/\.pdf$/i.test(file.name) && file.type !== 'application/pdf') {
      toast('请选择 PDF 格式的文件', 'error');
      return;
    }
    // 先读取并校验，全部成功后再更新状态，避免失败时残留半成品状态
    run('正在加载 ' + file.name + ' …', function () {
      return PdfOps.readAsArrayBuffer(file).then(function (buf) {
        // 校验用独立副本（pdf-lib 的 load 会消费传入数据）
        return PdfOps.loadDocument(new Uint8Array(buf.slice(0))).then(function () {
          state.fileName = file.name;
          state.fileSize = file.size;
          state.fileBytes = buf.slice(0);          // 保留原始副本
          state.pendingEdits = [];
          window.selectedPages.clear();
          window.pageRotation = {};
          window.currentPage = 1;
          window.clipboardPages = null;
          return rebuildFromBuffer(buf, true);
        });
      });
    }, { successMsg: '文件加载成功' }).catch(function () {
      // 加载失败：清理未完成的编辑态，保持原有文档可用
      state.pendingEdits = [];
      updateUiState();
    });
  }

  /**
   * 用新的字节流重建编辑文档 + pdf.js 文档，并刷新 UI
   *
   * 注意：pdf.js 的 getDocument 会「转移」（detach）传入的 ArrayBuffer，
   * 而 pdf-lib 需要保有自己的一份数据。因此必须为两者提供**独立副本**，
   * 否则后续写入会因底层数据被转移而静默失效。
   *
   * @param {ArrayBuffer|Uint8Array} bytes
   * @param {boolean} resetZoom 是否重置缩放
   */
  function rebuildFromBuffer(bytes, resetZoom) {
    var data = bytes instanceof Uint8Array ? bytes.slice(0) : new Uint8Array(bytes.slice(0));
    // 两份互不影响的副本
    var forPdfLib = data.slice(0);
    var forPdfJs = data.slice(0);

    return PdfOps.loadDocument(forPdfLib)
      .then(function (doc) {
        window.pdfDoc = doc;
        return loadPdfJs(forPdfJs);
      })
      .then(function () {
        if (resetZoom) {
          window.zoomLevel = 1;
          el.zoomSelect.value = '1';
        }
        // 同步旋转状态
        syncRotationState();
        // 修正当前页
        var total = window.pdfDoc.getPageCount();
        if (window.currentPage > total) window.currentPage = total;
        if (window.currentPage < 1) window.currentPage = 1;
        // 清理越界的选中页
        Array.from(window.selectedPages).forEach(function (p) {
          if (p < 1 || p > total) window.selectedPages.delete(p);
        });
        syncZoomSelect();
        return renderThumbnails();
      })
      .then(function () {
        return renderPage();
      })
      .then(function () {
        updateUiState();
      });
  }

  /** 加载 pdf.js 文档 */
  function loadPdfJs(data) {
    var lib = global.pdfjsLib;
    if (!lib) return Promise.reject(new Error('pdf.js 未加载完成，请刷新页面'));
    var copy = data.slice(0);
    var params = {
      data: copy,
      cMapUrl: (state.pdfjsAssets && state.pdfjsAssets.cMapUrl) || undefined,
      cMapPacked: true,
      standardFontDataUrl: (state.pdfjsAssets && state.pdfjsAssets.standardFontDataUrl) || undefined
    };
    return lib.getDocument(params).promise.then(function (d) {
      window.pdfjsDoc = d;
      return d;
    });
  }

  /** 从 pdf-lib 文档当前旋转状态同步到 window.pageRotation */
  function syncRotationState() {
    window.pageRotation = {};
    if (!window.pdfDoc) return;
    window.pdfDoc.getPages().forEach(function (p, i) {
      var a = ((p.getRotation().angle || 0) % 360 + 360) % 360;
      if (a) window.pageRotation[i + 1] = a;
    });
  }

  /**
   * 把当前 pdf-lib 文档保存为字节流，并重建渲染层
   * 所有"修改文档结构"的操作都走这里，保证预览与数据一致。
   * 注意：PdfOps.saveDocument 返回的是 Promise，必须 await。
   */
  function commitAndRefresh(successMsg, resetZoom) {
    if (!window.pdfDoc) return Promise.reject(new Error('尚未打开任何 PDF 文件'));
    return Promise.resolve(PdfOps.saveDocument(window.pdfDoc)).then(function (bytes) {
      return rebuildFromBuffer(bytes, !!resetZoom).then(function () {
        if (successMsg) toast(successMsg, 'success');
        return bytes;
      });
    });
  }

  /* =====================================================================
     渲染：缩略图
     ===================================================================== */
  function renderThumbnails() {
    if (!window.pdfjsDoc) return Promise.resolve();
    var token = ++state.thumbToken;
    var total = window.pdfjsDoc.numPages;

    // 清空列表（保留 thumbEmpty 节点以便复用）
    Array.prototype.slice.call(el.thumbList.children).forEach(function (n) {
      if (n !== el.thumbEmpty) el.thumbList.removeChild(n);
    });
    el.thumbEmpty.hidden = true;

    // 先创建占位骨架，避免长时间空白
    var nodes = [];
    var frag = document.createDocumentFragment();
    for (var i = 1; i <= total; i++) {
      var node = document.createElement('div');
      node.className = 'thumb';
      node.dataset.page = String(i);
      node.draggable = true;
      node.innerHTML =
        '<div style="padding-top:141.4%;background:#f6f8fb"></div>' +
        '<span class="thumb-no">' + i + '</span>' +
        '<span class="thumb-check"></span>';
      frag.appendChild(node);
      nodes.push(node);
    }
    el.thumbList.insertBefore(frag, el.thumbEmpty);
    refreshThumbSelection();

    // 串行渲染，避免并发过多导致卡顿
    var THUMB_W = 150;
    var chain = Promise.resolve();
    for (var n = 1; n <= total; n++) {
      (function (pageNo, node) {
        chain = chain.then(function () {
          if (token !== state.thumbToken) return;      // 已被新的渲染取代
          return renderThumb(pageNo, node, THUMB_W);
        });
      })(n, nodes[n - 1]);
    }
    return chain.catch(function (err) {
      console.warn('缩略图渲染中断', err);
    });
  }

  function renderThumb(pageNo, node, targetW) {
    return window.pdfjsDoc.getPage(pageNo).then(function (page) {
      var base = page.getViewport({ scale: 1 });
      var scale = targetW / base.width;
      var vp = page.getViewport({ scale: scale });
      var canvas = document.createElement('canvas');
      // 使用 devicePixelRatio 提升清晰度
      var dpr = Math.min(2, global.devicePixelRatio || 1);
      canvas.width = Math.max(1, Math.floor(vp.width * dpr));
      canvas.height = Math.max(1, Math.floor(vp.height * dpr));
      canvas.style.width = '100%';
      canvas.style.height = 'auto';
      var ctx = canvas.getContext('2d');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.scale(dpr, dpr);

      return page.render({ canvasContext: ctx, viewport: vp }).promise.then(function () {
        // 替换占位
        var ph = node.firstElementChild;
        if (ph) node.replaceChild(canvas, ph);
        // 旋转标记
        var rot = window.pageRotation[pageNo] || 0;
        var old = node.querySelector('.thumb-rot');
        if (old) old.remove();
        if (rot) {
          var badge = document.createElement('span');
          badge.className = 'thumb-rot';
          badge.textContent = rot + '°';
          node.appendChild(badge);
        }
      });
    });
  }

  /* =====================================================================
     渲染：主预览页
     ===================================================================== */
  function renderPage() {
    if (!window.pdfjsDoc || !window.pdfDoc) return Promise.resolve();
    var pageNo = window.currentPage;
    var token = ++state.renderToken;

    el.placeholder.classList.add('hidden');

    return window.pdfjsDoc.getPage(pageNo).then(function (page) {
      if (token !== state.renderToken) return;

      var scale = window.zoomLevel;
      if (scale === 'fit') {
        var base0 = page.getViewport({ scale: 1 });
        var avail = el.canvasScroll.clientWidth - 60;
        scale = Math.max(0.1, avail / base0.width);
      }
      scale = Number(scale) || 1;

      var vp = page.getViewport({ scale: scale });
      var dpr = Math.min(2, global.devicePixelRatio || 1);

      el.canvas.width = Math.max(1, Math.floor(vp.width * dpr));
      el.canvas.height = Math.max(1, Math.floor(vp.height * dpr));
      el.canvas.style.width = Math.floor(vp.width) + 'px';
      el.canvas.style.height = Math.floor(vp.height) + 'px';

      el.canvasHolder.style.width = Math.floor(vp.width) + 'px';
      el.canvasHolder.style.height = Math.floor(vp.height) + 'px';

      var ctx = el.canvas.getContext('2d');
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, el.canvas.width, el.canvas.height);
      ctx.scale(dpr, dpr);

      return page.render({ canvasContext: ctx, viewport: vp }).promise.then(function () {
        if (token !== state.renderToken) return;
        // 记录本次渲染缩放，供编辑层坐标换算使用
        state.renderScale = scale;
        renderEditLayer();
      });
    });
  }

  /* =====================================================================
     页面导航 / 缩放
     ===================================================================== */
  function gotoPage(n) {
    if (!window.pdfDoc) return;
    var total = window.pdfDoc.getPageCount();
    n = Math.max(1, Math.min(total, n | 0));
    if (n === window.currentPage) {
      updateUiState();
      return;
    }
    window.currentPage = n;
    updateUiState();
    renderPage();
  }

  function setZoom(z) {
    window.zoomLevel = z;
    updateUiState();
    renderPage();
  }

  function bindViewer() {
    $('prevPage').addEventListener('click', function () { gotoPage(window.currentPage - 1); });
    $('nextPage').addEventListener('click', function () { gotoPage(window.currentPage + 1); });
    el.pageInput.addEventListener('change', function () { gotoPage(parseInt(el.pageInput.value, 10)); });
    el.pageInput.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); gotoPage(parseInt(el.pageInput.value, 10)); }
    });
    el.zoomSelect.addEventListener('change', function () {
      var v = el.zoomSelect.value;
      setZoom(v === 'fit' ? 'fit' : parseFloat(v));
    });
    $('zoomIn').addEventListener('click', function () {
      var cur = typeof window.zoomLevel === 'number' ? window.zoomLevel : 1;
      setZoom(Math.min(5, Math.round((cur + 0.25) * 100) / 100));
      syncZoomSelect();
    });
    $('zoomOut').addEventListener('click', function () {
      var cur = typeof window.zoomLevel === 'number' ? window.zoomLevel : 1;
      setZoom(Math.max(0.2, Math.round((cur - 0.25) * 100) / 100));
      syncZoomSelect();
    });
    $('toggleSidebar').addEventListener('click', function () {
      el.sidebar.classList.toggle('collapsed');
      setTimeout(function () { if (window.pdfjsDoc) renderPage(); }, 240);
    });

    // 阅读模式切换
    if (el.readModeBtn) {
      el.readModeBtn.addEventListener('click', function () {
        var mode = window.readMode === 'continuous' ? 'page' : 'continuous';
        setReadMode(mode);
      });
    }

    // Ctrl + 滚轮缩放；逐页模式下普通滚轮按阈值翻页
    var wheelAccum = 0;
    el.canvasScroll.addEventListener('wheel', function (e) {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        var cur = typeof window.zoomLevel === 'number' ? window.zoomLevel : 1;
        var next = e.deltaY < 0 ? cur + 0.15 : cur - 0.15;
        next = Math.max(0.2, Math.min(5, Math.round(next * 100) / 100));
        setZoom(next);
        syncZoomSelect();
        return;
      }
      // 逐页模式：普通滚轮按阈值翻页
      if (window.readMode !== 'page') return;
      e.preventDefault();
      wheelAccum += e.deltaY;
      var THRESHOLD = 80;
      if (Math.abs(wheelAccum) >= THRESHOLD) {
        var delta = wheelAccum > 0 ? 1 : -1;
        wheelAccum = 0;
        gotoPage(window.currentPage + delta);
      }
    }, { passive: false });

    // 窗口尺寸变化时若为适应宽度则重渲染
    var resizeTimer = null;
    window.addEventListener('resize', function () {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(function () {
        if (window.zoomLevel === 'fit' && window.pdfjsDoc) renderPage();
      }, 180);
    });

    // 编辑模式按钮
    el.applyEdits.addEventListener('click', applyPendingEdits);
    el.clearEdits.addEventListener('click', function () {
      if (!state.pendingEdits.length) return;
      confirmDialog('放弃编辑', '确定要放弃所有尚未应用的文字 / 图片编辑吗？', function () {
        state.pendingEdits = [];
        renderEditLayer();
        updateUiState();
        toast('已放弃全部待定编辑', 'info');
      }, true);
    });
  }

  function syncZoomSelect() {
    // zoomLevel 为数字时同步下拉框；'fit' 时选中"适应宽度"
    var v = window.zoomLevel === 'fit' ? 'fit' : String(window.zoomLevel);
    var has = Array.prototype.some.call(el.zoomSelect.options, function (o) { return o.value === v; });
    el.zoomSelect.value = has ? v : '1';
  }

  /* =====================================================================
     阅读模式：逐页 / 连续
     ===================================================================== */

  /**
   * 切换阅读模式
   * @param {'page'|'continuous'} mode
   */
  function setReadMode(mode) {
    if (!window.pdfjsDoc) { toast('请先打开一个 PDF 文件', 'warn'); return; }
    window.readMode = mode;

    var isContinuous = mode === 'continuous';
    el.readModeBtn.textContent = isContinuous ? '连续' : '逐页';
    el.readModeBtn.classList.toggle('continuous', isContinuous);
    el.canvasStage.classList.toggle('continuous-mode', isContinuous);

    if (isContinuous) {
      renderContinuousPages();
    } else {
      el.continuousContainer.style.display = 'none';
      el.canvasHolder.style.display = '';
      renderPage();
    }
  }

  /**
   * 连续阅读模式：渲染所有页面到连续容器
   */
  function renderContinuousPages() {
    if (!window.pdfjsDoc || window.readMode !== 'continuous') return Promise.resolve();
    var token = ++state.renderToken;
    var total = window.pdfjsDoc.numPages;

    el.canvasHolder.style.display = 'none';
    el.continuousContainer.style.display = '';
    el.continuousContainer.innerHTML = '';
    el.placeholder.classList.add('hidden');

    // 计算渲染缩放
    var avail = el.canvasScroll.clientWidth - 60;
    var scale = window.zoomLevel === 'fit' ? null : (Number(window.zoomLevel) || 1);

    state.continuousPages = [];
    var chain = Promise.resolve();

    for (var n = 1; n <= total; n++) {
      (function (pageNo) {
        chain = chain.then(function () {
          if (token !== state.renderToken) return;
          return window.pdfjsDoc.getPage(pageNo).then(function (page) {
            if (token !== state.renderToken) return;
            var s = scale;
            if (s === null) {
              var base = page.getViewport({ scale: 1 });
              s = Math.max(0.1, avail / base.width);
            }
            state.continuousScale = s;
            var vp = page.getViewport({ scale: s });
            var dpr = Math.min(2, global.devicePixelRatio || 1);

            var holder = document.createElement('div');
            holder.className = 'canvas-holder';
            holder.style.width = Math.floor(vp.width) + 'px';
            holder.style.height = Math.floor(vp.height) + 'px';
            holder.style.margin = '0 auto 16px';

            var canvas = document.createElement('canvas');
            canvas.width = Math.max(1, Math.floor(vp.width * dpr));
            canvas.height = Math.max(1, Math.floor(vp.height * dpr));
            canvas.style.width = Math.floor(vp.width) + 'px';
            canvas.style.height = Math.floor(vp.height) + 'px';

            var ctx = canvas.getContext('2d');
            ctx.setTransform(1, 0, 0, 1, 0, 0);
            ctx.fillStyle = '#ffffff';
            ctx.fillRect(0, 0, canvas.width, canvas.height);
            ctx.scale(dpr, dpr);

            holder.appendChild(canvas);
            holder.dataset.page = String(pageNo);
            el.continuousContainer.appendChild(holder);
            state.continuousPages.push(holder);

            return page.render({ canvasContext: ctx, viewport: vp }).promise.then(function () {
              if (token !== state.renderToken) return;
              // 滚动到当前页
              if (pageNo === window.currentPage) {
                holder.scrollIntoView({ block: 'start' });
              }
            });
          });
        });
      })(n);
    }

    return chain.catch(function (err) {
      console.warn('连续渲染中断', err);
    });
  }

  /**
   * 连续模式下：滚动监听，更新当前页码
   */
  function bindContinuousScroll() {
    var ticking = false;
    el.canvasScroll.addEventListener('scroll', function () {
      if (window.readMode !== 'continuous' || !state.continuousPages) return;
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(function () {
        ticking = false;
        var scrollTop = el.canvasScroll.scrollTop;
        var center = scrollTop + el.canvasScroll.clientHeight / 2;
        var pages = state.continuousPages;
        for (var i = 0; i < pages.length; i++) {
          var top = pages[i].offsetTop;
          var bottom = top + pages[i].offsetHeight;
          if (center >= top && center < bottom) {
            var pageNo = i + 1;
            if (pageNo !== window.currentPage) {
              window.currentPage = pageNo;
              updateUiState();
            }
            break;
          }
        }
      });
    });
  }

  /* =====================================================================
     侧栏：缩略图选择 / 拖拽排序
     ===================================================================== */
  function bindSidebar() {
    $('selectAllPages').addEventListener('click', function () {
      if (!window.pdfDoc) return;
      var total = window.pdfDoc.getPageCount();
      window.selectedPages.clear();
      for (var i = 1; i <= total; i++) window.selectedPages.add(i);
      refreshThumbSelection();
      updateUiState();
    });
    $('clearSelection').addEventListener('click', function () {
      window.selectedPages.clear();
      refreshThumbSelection();
      updateUiState();
    });

    // 点击选择（支持 Ctrl / Shift）
    var lastClicked = null;
    el.thumbList.addEventListener('click', function (e) {
      var node = e.target.closest('.thumb');
      if (!node) return;
      var page = parseInt(node.dataset.page, 10);

      if (e.shiftKey && lastClicked) {
        var a = Math.min(lastClicked, page), b = Math.max(lastClicked, page);
        if (!e.ctrlKey && !e.metaKey) window.selectedPages.clear();
        for (var i = a; i <= b; i++) window.selectedPages.add(i);
      } else if (e.ctrlKey || e.metaKey) {
        if (window.selectedPages.has(page)) window.selectedPages.delete(page);
        else window.selectedPages.add(page);
      } else {
        window.selectedPages.clear();
        window.selectedPages.add(page);
      }
      lastClicked = page;

      refreshThumbSelection();
      updateUiState();
      if (page !== window.currentPage) gotoPage(page);
    });

    // 双击：仅选中并跳转
    el.thumbList.addEventListener('dblclick', function (e) {
      var node = e.target.closest('.thumb');
      if (!node) return;
      gotoPage(parseInt(node.dataset.page, 10));
    });

    // 拖拽排序
    el.thumbList.addEventListener('dragstart', function (e) {
      var node = e.target.closest('.thumb');
      if (!node) return;
      state.dragSource = parseInt(node.dataset.page, 10);
      node.classList.add('dragging');
      if (e.dataTransfer) {
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', node.dataset.page);
      }
    });
    el.thumbList.addEventListener('dragend', function () {
      state.dragSource = null;
      el.thumbList.querySelectorAll('.thumb').forEach(function (n) {
        n.classList.remove('dragging', 'drag-over');
      });
    });
    el.thumbList.addEventListener('dragover', function (e) {
      var node = e.target.closest('.thumb');
      if (!node || state.dragSource === null) return;
      e.preventDefault();
      el.thumbList.querySelectorAll('.thumb.drag-over').forEach(function (n) { n.classList.remove('drag-over'); });
      node.classList.add('drag-over');
    });
    el.thumbList.addEventListener('drop', function (e) {
      var node = e.target.closest('.thumb');
      if (!node || state.dragSource === null) return;
      e.preventDefault();
      var from = state.dragSource;
      var to = parseInt(node.dataset.page, 10);
      state.dragSource = null;
      if (from === to) return;

      run('正在调整页面顺序…', function () {
        // 计算新的顺序：把 from 移到 to 的位置
        var total = window.pdfDoc.getPageCount();
        var order = [];
        for (var i = 1; i <= total; i++) order.push(i);
        order.splice(from - 1, 1);
        order.splice(to - 1, 0, from);
        var zero = order.map(function (p) { return p - 1; });
        return PdfOps.reorderPages(window.pdfDoc, zero).then(function (nd) {
          window.pdfDoc = nd;
          window.currentPage = to;
          window.selectedPages.clear();
          window.selectedPages.add(to);
          return commitAndRefresh(null, false);
        });
      }, { successMsg: '页面顺序已更新' });
    });
  }

  function refreshThumbSelection() {
    el.thumbList.querySelectorAll('.thumb').forEach(function (n) {
      var p = parseInt(n.dataset.page, 10);
      n.classList.toggle('selected', window.selectedPages.has(p));
      n.classList.toggle('current', p === window.currentPage);
    });
  }

  /* =====================================================================
     UI 状态刷新
     ===================================================================== */
  function updateUiState() {
    var has = !!window.pdfDoc;
    var total = has ? window.pdfDoc.getPageCount() : 0;

    // 工具栏按钮启用状态
    document.querySelectorAll('[data-action]').forEach(function (btn) {
      var a = btn.dataset.action;
      if (a === 'open' || a === 'mergePdf') { btn.disabled = false; return; }
      btn.disabled = !has;
    });

    // 页码 / 计数
    el.pageInput.value = window.currentPage || 1;
    el.pageInput.max = total || 1;
    el.pageCount.textContent = total;
    $('statusPage').textContent = (has ? window.currentPage : 0) + ' / ' + total;

    // 缩放
    var zText = typeof window.zoomLevel === 'number'
      ? Math.round(window.zoomLevel * 100) + '%'
      : '适应宽度';
    $('statusZoom').textContent = zText;

    // 文件信息
    $('fileNameLabel').textContent = has ? state.fileName : '未打开文件';
    $('infoName').textContent = has ? state.fileName : '—';
    $('infoPages').textContent = has ? total + ' 页' : '—';
    $('statusSize').textContent = has ? PdfOps.formatBytes(state.fileSize) : '—';
    $('infoSize').textContent = has ? PdfOps.formatBytes(state.fileSize) : '—';

    // 页面尺寸（当前页）
    if (has && total > 0) {
      var info = PdfOps.getPageInfos(window.pdfDoc)[window.currentPage - 1];
      $('infoDimension').textContent = info ? info.sizeText : '—';
      $('infoRotation').textContent = (window.pageRotation[window.currentPage] || 0) + '°';
    } else {
      $('infoDimension').textContent = '—';
      $('infoRotation').textContent = '0°';
    }

    // 选中页面
    var sel = Array.from(window.selectedPages).sort(function (a, b) { return a - b; });
    $('infoSelected').textContent = sel.length
      ? sel.length + ' 页（' + PdfOps.formatPageRanges(sel.map(function (p) { return p - 1; })) + '）'
      : '未选中';

    // 占位图
    el.placeholder.classList.toggle('hidden', has);

    // 编辑按钮
    var hasEdits = state.pendingEdits.length > 0;
    el.applyEdits.hidden = !hasEdits;
    el.clearEdits.hidden = !hasEdits;
    if (hasEdits) {
      el.applyEdits.textContent = '应用编辑（' + state.pendingEdits.length + '）';
    }

    refreshThumbSelection();
  }

  /* =====================================================================
     选区辅助
     ===================================================================== */

  /** 获取目标页（选中页优先，否则当前页），返回 1 基页码数组 */
  function targetPages() {
    if (!window.pdfDoc) return [];
    var total = window.pdfDoc.getPageCount();
    var sel = Array.from(window.selectedPages).filter(function (p) { return p >= 1 && p <= total; });
    if (sel.length) return sel.sort(function (a, b) { return a - b; });
    return [window.currentPage];
  }

  function requireDoc() {
    if (!window.pdfDoc) {
      toast('请先打开一个 PDF 文件', 'warn');
      return false;
    }
    return true;
  }

  /* =====================================================================
     工具栏事件分发
     ===================================================================== */
  var ACTIONS = {
    /* --- 文件 --- */
    open: function () { pickFile(); },
    save: actExportPdf,
    print: actPrint,

    /* --- 页面 --- */
    addPage: actAddPage,
    deletePage: actDeletePage,
    importPages: actImportPages,
    copyPage: actCopyPage,
    pastePage: actPastePage,
    replacePage: actReplacePage,
    extractPages: actExtractPages,
    splitByRange: actSplitByRange,
    reorderPages: actReorderPages,
    resizePage: actResizePage,
    rotateLeft: function () { actRotate(-90); },
    rotateRight: function () { actRotate(90); },

    /* --- 编辑 --- */
    addText: actAddText,
    addImage: actAddImage,

    /* --- 其他 --- */
    mergePdf: actMergePdf,
    splitPdf: actSplitPdf,
    compressPdf: actCompressPdf,
    addBookmark: actAddBookmark
  };

  function bindToolbar() {
    document.querySelectorAll('[data-action]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var a = btn.dataset.action;
        var fn = ACTIONS[a];
        if (!fn) { toast('功能未实现：' + a, 'warn'); return; }
        try { fn(); } catch (err) {
          toast(err.message || String(err), 'error');
          console.error(err);
        }
      });
    });

    el.fileInput.addEventListener('change', function () {
      if (el.fileInput.files && el.fileInput.files[0]) loadFile(el.fileInput.files[0]);
      el.fileInput.value = '';
    });
    el.imageInput.addEventListener('change', function () {
      if (el.imageInput.files && el.imageInput.files[0]) {
        state._pendingImageFile = el.imageInput.files[0];
        openImageEditor(state._pendingImageFile);
      }
      el.imageInput.value = '';
    });
  }

  /* =====================================================================
     功能 1：添加页面
     ===================================================================== */
  function actAddPage() {
    if (!requireDoc()) return;
    var total = window.pdfDoc.getPageCount();
    var at = targetPages()[0] || total;

    openModal({
      title: '添加空白页面',
      html:
        '<div class="note">新页面将插入到指定位置之前。</div>' +
        '<div class="field"><label>插入位置 <span class="sub">1 表示插入到最前面</span></label>' +
          '<input type="number" id="apPos" min="1" max="' + (total + 1) + '" value="' + at + '"></div>' +
        '<div class="field"><label>页面尺寸</label>' +
          chipGroup('apSize', [
            { value: 'same', label: '与当前页相同' },
            { value: 'A4', label: 'A4' },
            { value: 'A3', label: 'A3' },
            { value: 'A5', label: 'A5' },
            { value: 'B5', label: 'B5' },
            { value: 'Letter', label: 'Letter' },
            { value: 'Legal', label: 'Legal' },
            { value: 'custom', label: '自定义' }
          ], 'A4') + '</div>' +
        '<div class="field" id="apCustom" style="display:none">' +
          '<div class="field-row field-row-3">' +
            '<div><label>宽度</label><input type="number" id="apW" value="210" step="0.1"></div>' +
            '<div><label>高度</label><input type="number" id="apH" value="297" step="0.1"></div>' +
            '<div><label>单位</label><select id="apUnit">' +
              '<option value="mm">毫米 mm</option><option value="pt">点 pt</option>' +
              '<option value="in">英寸 in</option><option value="cm">厘米 cm</option>' +
            '</select></div>' +
          '</div></div>' +
        '<div class="field"><label>方向</label>' +
          chipGroup('apOrient', [
            { value: 'portrait', label: '纵向' },
            { value: 'landscape', label: '横向' }
          ], 'portrait') + '</div>' +
        '<div class="field"><label>插入数量</label>' +
          '<input type="number" id="apCount" min="1" max="200" value="1"></div>',
      confirmText: '插入',
      onOpen: function (root) {
        bindChips(root);
        root.querySelectorAll('input[name=apSize]').forEach(function (i) {
          i.addEventListener('change', function () {
            $('apCustom').style.display = i.value === 'custom' ? '' : 'none';
          });
        });
      },
      onConfirm: function (root) {
        var pos = parseInt($('apPos').value, 10);
        var count = Math.max(1, Math.min(200, parseInt($('apCount').value, 10) || 1));
        if (isNaN(pos) || pos < 1 || pos > total + 1) {
          toast('插入位置需在 1 ~ ' + (total + 1) + ' 之间', 'warn');
          return false;
        }
        var preset = chipValue(root, 'apSize', 'A4');
        var orient = chipValue(root, 'apOrient', 'portrait');
        var opts = { preset: preset, orientation: orient };
        if (preset === 'custom') {
          opts.width = parseFloat($('apW').value);
          opts.height = parseFloat($('apH').value);
          opts.unit = $('apUnit').value;
          if (!(opts.width > 0) || !(opts.height > 0)) {
            toast('自定义宽高必须大于 0', 'warn');
            return false;
          }
        }
        return run('正在插入空白页…', function () {
          for (var k = 0; k < count; k++) {
            PdfOps.insertBlankPage(window.pdfDoc, pos - 1 + k, opts);
          }
          window.currentPage = pos;
          window.selectedPages.clear();
          window.selectedPages.add(pos);
          return commitAndRefresh(null, false);
        }, { successMsg: '已插入 ' + count + ' 个空白页' });
      }
    });
  }

  /* =====================================================================
     功能 2：删除页面
     ===================================================================== */
  function actDeletePage() {
    if (!requireDoc()) return;
    var pages = targetPages();
    var total = window.pdfDoc.getPageCount();
    if (pages.length >= total) {
      toast('不能删除全部页面，请至少保留 1 页', 'error');
      return;
    }
    var desc = PdfOps.formatPageRanges(pages.map(function (p) { return p - 1; }));
    confirmDialog(
      '删除页面',
      '即将删除 ' + pages.length + ' 个页面（第 ' + desc + ' 页）。此操作会立即生效，但您仍可通过"重新打开原文件"恢复。确定继续吗？',
      function () {
        run('正在删除页面…', function () {
          PdfOps.deletePages(window.pdfDoc, pages.map(function (p) { return p - 1; }));
          window.selectedPages.clear();
          window.currentPage = Math.min(pages[0], window.pdfDoc.getPageCount());
          return commitAndRefresh(null, false);
        }, { successMsg: '已删除 ' + pages.length + ' 个页面' });
      },
      true
    );
  }

  /* =====================================================================
     功能 3：从文件导入页面
     ===================================================================== */
  function actImportPages() {
    if (!requireDoc()) return;
    var total = window.pdfDoc.getPageCount();
    var at = targetPages()[0] || total;

    openModal({
      title: '从文件导入页面',
      wide: true,
      html:
        '<div class="note">选择另一个 PDF 文件，把它的指定页面插入到当前文档中。</div>' +
        '<div class="field"><label>源 PDF 文件</label>' +
          '<input type="file" id="ipFile" accept="application/pdf,.pdf"></div>' +
        '<div class="field"><label>要导入的页码范围 <span class="sub">如 1-3, 5, 8-10；留空或填 all 表示全部</span></label>' +
          '<input type="text" id="ipRange" placeholder="1-3, 5"></div>' +
        '<div class="field"><label>插入位置 <span class="sub">当前文档共 ' + total + ' 页</span></label>' +
          '<input type="number" id="ipPos" min="1" max="' + (total + 1) + '" value="' + at + '"></div>' +
        '<div id="ipInfo"></div>',
      confirmText: '导入',
      onOpen: function (root) {
        $('ipFile').addEventListener('change', function () {
          var f = this.files && this.files[0];
          if (!f) { $('ipInfo').innerHTML = ''; return; }
          PdfOps.readAsArrayBuffer(f).then(function (buf) {
            return PdfOps.loadDocument(buf);
          }).then(function (doc) {
            var n = doc.getPageCount();
            $('ipInfo').innerHTML = '<div class="note">源文件《' + escapeHtml(f.name) + '》共 ' + n + ' 页。</div>';
            if (!$('ipRange').value) $('ipRange').value = '1-' + n;
            $('ipFile').dataset.pages = String(n);
            $('ipFile').__buf = buf;
          }).catch(function (err) {
            $('ipInfo').innerHTML = '<div class="note warn">' + escapeHtml(err.message) + '</div>';
          });
        });
      },
      onConfirm: function () {
        var fileEl = $('ipFile');
        if (!fileEl.__buf) { toast('请先选择一个 PDF 文件', 'warn'); return false; }
        var srcCount = parseInt(fileEl.dataset.pages, 10) || 0;
        var indices = PdfOps.parsePageRanges($('ipRange').value || 'all', srcCount);
        if (!indices.length) { toast('页码范围无效或为空', 'warn'); return false; }
        var pos = parseInt($('ipPos').value, 10);
        if (isNaN(pos) || pos < 1 || pos > total + 1) {
          toast('插入位置需在 1 ~ ' + (total + 1) + ' 之间', 'warn');
          return false;
        }
        var buf = fileEl.__buf;
        return run('正在导入页面…', function () {
          return PdfOps.importPages(window.pdfDoc, buf, indices, pos - 1).then(function (n) {
            window.selectedPages.clear();
            window.currentPage = pos;
            window.selectedPages.add(pos);
            return commitAndRefresh(null, false).then(function () {
              toast('已导入 ' + n + ' 个页面', 'success');
            });
          });
        });
      }
    });
  }

  /* =====================================================================
     功能 4：复制 / 粘贴页面
     ===================================================================== */
  function actCopyPage() {
    if (!requireDoc()) return;
    var pages = targetPages();
    run('正在复制页面…', function () {
      return PdfOps.extractPages(window.pdfDoc, pages.map(function (p) { return p - 1; }))
        .then(function (tmp) {
          return PdfOps.saveDocument(tmp).then(function (bytes) {
            window.clipboardPages = {
              bytes: bytes,
              indices: pages.map(function (p) { return p - 1; }),
              count: pages.length,
              sourceName: state.fileName
            };
            toast('已复制 ' + pages.length + ' 个页面到剪贴板', 'success');
          });
        });
    }, { progress: false });
  }

  function actPastePage() {
    if (!requireDoc()) return;
    if (!window.clipboardPages) {
      toast('剪贴板为空，请先使用"复制页面"', 'warn');
      return;
    }
    var total = window.pdfDoc.getPageCount();
    var at = targetPages()[0] || total;
    var cb = window.clipboardPages;

    openModal({
      title: '粘贴页面',
      html:
        '<div class="note">剪贴板中有 <b>' + cb.count + '</b> 个页面（来自《' + escapeHtml(cb.sourceName) + '》）。</div>' +
        '<div class="field"><label>粘贴位置 <span class="sub">当前文档共 ' + total + ' 页</span></label>' +
          '<input type="number" id="ppPos" min="1" max="' + (total + 1) + '" value="' + at + '"></div>' +
        '<div class="field"><label>粘贴份数</label>' +
          '<input type="number" id="ppTimes" min="1" max="100" value="1"></div>',
      confirmText: '粘贴',
      onConfirm: function () {
        var pos = parseInt($('ppPos').value, 10);
        var times = Math.max(1, Math.min(100, parseInt($('ppTimes').value, 10) || 1));
        if (isNaN(pos) || pos < 1 || pos > total + 1) {
          toast('粘贴位置需在 1 ~ ' + (total + 1) + ' 之间', 'warn');
          return false;
        }
        return run('正在粘贴页面…', function () {
          var idxs = [];
          for (var i = 0; i < cb.count; i++) idxs.push(i);
          var chain = Promise.resolve();
          var insertAt = pos - 1;
          for (var t = 0; t < times; t++) {
            (function (atIdx) {
              chain = chain.then(function () {
                return PdfOps.importPages(window.pdfDoc, cb.bytes, idxs, atIdx)
                  .then(function (n) { insertAt += n; });
              });
            })(insertAt);
          }
          return chain.then(function () {
            window.selectedPages.clear();
            window.currentPage = pos;
            window.selectedPages.add(pos);
            return commitAndRefresh(null, false);
          });
        }, { successMsg: '已粘贴 ' + (cb.count * times) + ' 个页面' });
      }
    });
  }

  /* =====================================================================
     功能 5：替换页面
     ===================================================================== */
  function actReplacePage() {
    if (!requireDoc()) return;
    var pages = targetPages();
    var total = window.pdfDoc.getPageCount();

    openModal({
      title: '替换页面',
      wide: true,
      html:
        '<div class="note">用源 PDF 中的一页替换当前文档中选中的 ' + pages.length +
          ' 个页面（第 ' + PdfOps.formatPageRanges(pages.map(function (p) { return p - 1; })) + ' 页）。</div>' +
        '<div class="field"><label>源 PDF 文件</label>' +
          '<input type="file" id="rpFile" accept="application/pdf,.pdf"></div>' +
        '<div class="field"><label>使用源文件中的第几页</label>' +
          '<input type="number" id="rpSrcPage" min="1" value="1"></div>' +
        '<div id="rpInfo"></div>',
      confirmText: '替换',
      onOpen: function () {
        $('rpFile').addEventListener('change', function () {
          var f = this.files && this.files[0];
          if (!f) { $('rpInfo').innerHTML = ''; return; }
          PdfOps.readAsArrayBuffer(f).then(function (buf) {
            return PdfOps.loadDocument(buf).then(function (doc) {
              $('rpInfo').innerHTML = '<div class="note">源文件《' + escapeHtml(f.name) +
                '》共 ' + doc.getPageCount() + ' 页。</div>';
              $('rpSrcPage').max = doc.getPageCount();
              $('rpFile').__buf = buf;
              $('rpFile').dataset.pages = String(doc.getPageCount());
            });
          }).catch(function (err) {
            $('rpInfo').innerHTML = '<div class="note warn">' + escapeHtml(err.message) + '</div>';
          });
        });
      },
      onConfirm: function () {
        var fileEl = $('rpFile');
        if (!fileEl.__buf) { toast('请先选择一个 PDF 文件', 'warn'); return false; }
        var srcCount = parseInt(fileEl.dataset.pages, 10) || 1;
        var srcPage = parseInt($('rpSrcPage').value, 10);
        if (isNaN(srcPage) || srcPage < 1 || srcPage > srcCount) {
          toast('源页码需在 1 ~ ' + srcCount + ' 之间', 'warn');
          return false;
        }
        var buf = fileEl.__buf;
        return run('正在替换页面…', function () {
          return PdfOps.replacePages(window.pdfDoc, buf, srcPage - 1, pages.map(function (p) { return p - 1; }))
            .then(function () {
              return commitAndRefresh(null, false);
            });
        }, { successMsg: '已替换 ' + pages.length + ' 个页面' });
      }
    });
  }

  /* =====================================================================
     功能 6：提取页面
     ===================================================================== */
  function actExtractPages() {
    if (!requireDoc()) return;
    var pages = targetPages();
    openModal({
      title: '提取页面为新 PDF',
      html:
        '<div class="note">将选中的 ' + pages.length + ' 个页面导出为独立的 PDF 文件。</div>' +
        '<div class="field"><label>页码范围 <span class="sub">可修改，如 1-3, 5</span></label>' +
          '<input type="text" id="epRange" value="' + PdfOps.formatPageRanges(pages.map(function (p) { return p - 1; })) + '"></div>' +
        '<div class="field"><label>输出文件名</label>' +
          '<input type="text" id="epName" value="' + escapeHtml(defaultName('_提取')) + '"></div>' +
        '<div class="field"><label>提取后处理</label>' +
          chipGroup('epMode', [
            { value: 'download', label: '下载新文件' },
            { value: 'open', label: '下载并载入为当前文档' }
          ], 'download') + '</div>',
      confirmText: '提取',
      onOpen: function (root) { bindChips(root); },
      onConfirm: function (root) {
        var total = window.pdfDoc.getPageCount();
        var indices = PdfOps.parsePageRanges($('epRange').value, total);
        if (!indices.length) { toast('页码范围无效', 'warn'); return false; }
        var name = $('epName').value.trim() || 'extract.pdf';
        if (!/\.pdf$/i.test(name)) name += '.pdf';
        var mode = chipValue(root, 'epMode', 'download');

        return run('正在提取页面…', function () {
          return PdfOps.extractPages(window.pdfDoc, indices).then(function (out) {
            return PdfOps.saveDocument(out).then(function (bytes) {
              saveBlob(new Blob([bytes], { type: 'application/pdf' }), name);
              if (mode === 'open') {
                state.fileName = name;
                state.fileSize = bytes.length;
                state.fileBytes = bytes.slice(0).buffer;
                return rebuildFromBuffer(bytes, true);
              }
              return null;
            });
          });
        }, { successMsg: '已提取 ' + indices.length + ' 页并下载' });
      }
    });
  }

  /* =====================================================================
     功能 7：分割 PDF（按范围）
     ===================================================================== */
  function actSplitByRange() {
    if (!requireDoc()) return;
    var total = window.pdfDoc.getPageCount();

    openModal({
      title: '按页码范围分割',
      wide: true,
      html:
        '<div class="note">每个范围生成一个独立的 PDF 文件。<b>用分号分隔不同的输出文件</b>，' +
          '例如 <code>1-3; 4-6; 7-10</code> 会生成 3 个文件。当前文档共 ' + total + ' 页。</div>' +
        '<div class="field"><label>范围表达式</label>' +
          '<textarea id="srText" placeholder="1-3; 4-6; 7-10">' + defaultSplitRanges(total) + '</textarea></div>' +
        '<div class="field"><label>快捷模板</label>' +
          '<div class="radio-row">' +
            '<button class="mini-btn" type="button" id="srT1">每页一个</button>' +
            '<button class="mini-btn" type="button" id="srT2">两半</button>' +
            '<button class="mini-btn" type="button" id="srT3">每 5 页</button>' +
            '<button class="mini-btn" type="button" id="srT4">前 1 页 / 其余</button>' +
          '</div></div>' +
        '<div class="field"><label>输出方式</label>' +
          chipGroup('srOut', [
            { value: 'zip', label: '打包为 ZIP 下载（推荐）' },
            { value: 'each', label: '逐个下载' }
          ], 'zip') + '</div>',
      confirmText: '开始分割',
      onOpen: function (root) {
        bindChips(root);
        $('srT1').addEventListener('click', function () {
          $('srText').value = rangeList(1, total, 1);
        });
        $('srT2').addEventListener('click', function () {
          var mid = Math.ceil(total / 2);
          $('srText').value = '1-' + mid + '; ' + (mid + 1) + '-' + total;
        });
        $('srT3').addEventListener('click', function () {
          $('srText').value = rangeList(1, total, 5);
        });
        $('srT4').addEventListener('click', function () {
          $('srText').value = '1; 2-' + total;
        });
      },
      onConfirm: function (root) {
        var text = $('srText').value;
        var outMode = chipValue(root, 'srOut', 'zip');
        return run('正在分割文档…', function () {
          return PdfOps.splitByRanges(window.pdfDoc, text).then(function (parts) {
            if (!parts.length) throw new Error('未生成任何文件，请检查范围表达式');
            return outputParts(parts, defaultName('_分割'), outMode);
          });
        }, { successMsg: '分割完成' });
      }
    });
  }

  /* =====================================================================
     功能 12：拆分 PDF（每 N 页 / 按范围）
     ===================================================================== */
  function actSplitPdf() {
    if (!requireDoc()) return;
    var total = window.pdfDoc.getPageCount();

    openModal({
      title: '拆分 PDF 文件',
      wide: true,
      html:
        '<div class="note">把当前文档拆分成多个独立文件。当前文档共 ' + total + ' 页。</div>' +
        '<div class="field"><label>拆分方式</label>' +
          chipGroup('spMode', [
            { value: 'everyN', label: '每 N 页一个文件' },
            { value: 'ranges', label: '按自定义范围' }
          ], 'everyN') + '</div>' +
        '<div class="field" id="spEveryN"><label>每份页数</label>' +
          '<input type="number" id="spN" min="1" max="' + total + '" value="1">' +
          '<div style="margin-top:6px" class="radio-row">' +
            '<button class="mini-btn" type="button" data-n="1">1 页</button>' +
            '<button class="mini-btn" type="button" data-n="2">2 页</button>' +
            '<button class="mini-btn" type="button" data-n="5">5 页</button>' +
            '<button class="mini-btn" type="button" data-n="10">10 页</button>' +
          '</div></div>' +
        '<div class="field" id="spRanges" style="display:none"><label>范围表达式 ' +
          '<span class="sub">分号分隔不同文件</span></label>' +
          '<textarea id="spRangeText">' + defaultSplitRanges(total) + '</textarea></div>' +
        '<div class="field"><label>输出方式</label>' +
          chipGroup('spOut', [
            { value: 'zip', label: '打包为 ZIP 下载（推荐）' },
            { value: 'each', label: '逐个下载' }
          ], 'zip') + '</div>',
      confirmText: '开始拆分',
      onOpen: function (root) {
        bindChips(root);
        root.querySelectorAll('input[name=spMode]').forEach(function (i) {
          i.addEventListener('change', function () {
            $('spEveryN').style.display = i.value === 'everyN' ? '' : 'none';
            $('spRanges').style.display = i.value === 'ranges' ? '' : 'none';
          });
        });
        root.querySelectorAll('[data-n]').forEach(function (b) {
          b.addEventListener('click', function () { $('spN').value = b.dataset.n; });
        });
      },
      onConfirm: function (root) {
        var mode = chipValue(root, 'spMode', 'everyN');
        var outMode = chipValue(root, 'spOut', 'zip');
        var n = parseInt($('spN').value, 10) || 1;
        var rangeText = $('spRangeText').value;
        return run('正在拆分文档…', function (report) {
          var p = mode === 'everyN'
            ? PdfOps.splitEveryN(window.pdfDoc, n)
            : PdfOps.splitByRanges(window.pdfDoc, rangeText);
          return p.then(function (parts) {
            if (!parts.length) throw new Error('未生成任何文件');
            return outputParts(parts, defaultName('_拆分'), outMode, report);
          });
        }, { successMsg: '拆分完成', progress: true });
      }
    });
  }

  /** 输出分割结果（ZIP 或逐个下载） */
  function outputParts(parts, baseName, mode, report) {
    var base = baseName.replace(/\.pdf$/i, '');
    if (mode === 'each') {
      parts.forEach(function (p, i) {
        setTimeout(function () {
          saveBlob(new Blob([p.bytes], { type: 'application/pdf' }), base + '_' + p.name);
          if (report) report(i + 1, parts.length);
        }, i * 260);
      });
      toast('共 ' + parts.length + ' 个文件，浏览器可能会询问是否允许批量下载', 'info', 5000);
      return Promise.resolve();
    }
    var zip = new JSZip();
    parts.forEach(function (p) { zip.file(p.name, p.bytes); });
    return zip.generateAsync({ type: 'blob', compression: 'DEFLATE' }, function (meta) {
      if (report) report(meta.percent, 100);
    }).then(function (blob) {
      saveBlob(blob, base + '.zip');
    });
  }

  /* =====================================================================
     功能 8：页面拼接 / 重新排序
     ===================================================================== */
  function actReorderPages() {
    if (!requireDoc()) return;
    var total = window.pdfDoc.getPageCount();
    // 当前顺序（1 基）
    var order = [];
    for (var i = 1; i <= total; i++) order.push(i);

    openModal({
      title: '页面拼接 / 重新排序',
      wide: true,
      html:
        '<div class="note">通过拖拽调整页面顺序，或使用右侧按钮把页面移动 / 复制到指定位置。' +
          '点击"生成新文档"后按新顺序重建文档。</div>' +
        '<div class="field-row" style="grid-template-columns: 1fr 150px">' +
          '<div><label>页面顺序（可拖拽排序）</label>' +
            '<div class="pick-list" id="roList"></div></div>' +
          '<div><label>操作</label>' +
            '<div style="display:flex;flex-direction:column;gap:6px">' +
              '<button class="mini-btn" type="button" id="roReverse">整体反转</button>' +
              '<button class="mini-btn" type="button" id="roReset">恢复原始顺序</button>' +
              '<button class="mini-btn" type="button" id="roInterleave">奇偶交错</button>' +
              '<button class="mini-btn" type="button" id="roDupAll">末尾复制全部</button>' +
            '</div>' +
            '<div style="margin-top:10px"><label>追加指定页 <span class="sub">如 1,3,5</span></label>' +
              '<input type="text" id="roAppend" placeholder="1,3,5">' +
              '<button class="mini-btn" type="button" id="roAppendBtn" style="margin-top:6px;width:100%">追加到末尾</button>' +
            '</div>' +
          '</div>' +
        '</div>',
      confirmText: '生成新文档',
      onOpen: function () {
        renderOrderList(order);

        $('roReverse').addEventListener('click', function () {
          order = order.slice().reverse();
          renderOrderList(order);
        });
        $('roReset').addEventListener('click', function () {
          order = [];
          for (var i = 1; i <= total; i++) order.push(i);
          renderOrderList(order);
        });
        $('roInterleave').addEventListener('click', function () {
          var evens = order.filter(function (p) { return p % 2 === 0; });
          var odds = order.filter(function (p) { return p % 2 === 1; });
          order = odds.concat(evens);
          renderOrderList(order);
        });
        $('roDupAll').addEventListener('click', function () {
          order = order.concat(order.slice());
          renderOrderList(order);
        });
        $('roAppendBtn').addEventListener('click', function () {
          var idx = PdfOps.parsePageRanges($('roAppend').value, total);
          if (!idx.length) { toast('请输入有效的页码，如 1,3,5', 'warn'); return; }
          order = order.concat(idx.map(function (i) { return i + 1; }));
          renderOrderList(order);
        });
      },
      onConfirm: function () {
        if (!order.length) { toast('新的页面顺序为空', 'warn'); return false; }
        var zero = order.map(function (p) { return p - 1; });
        return run('正在重建文档…', function () {
          return PdfOps.reorderPages(window.pdfDoc, zero).then(function (nd) {
            window.pdfDoc = nd;
            window.currentPage = 1;
            window.selectedPages.clear();
            return commitAndRefresh(null, false);
          });
        }, { successMsg: '已按新顺序生成文档（共 ' + order.length + ' 页）' });
      }
    });
  }

  /** 渲染可拖拽的排序列表 */
  function renderOrderList(order) {
    var list = $('roList');
    if (!list) return;
    list.innerHTML = order.map(function (p, i) {
      return '<div class="pick-item" draggable="true" data-pos="' + i + '">' +
        '<span class="idx">' + (i + 1) + '</span>' +
        '<span class="thumb-preview" data-page="' + p + '" style="width:48px;height:64px;background:#f6f8fb;border:1px solid #e2e6ec;border-radius:3px;flex:0 0 auto;overflow:hidden;"></span>' +
        '<span class="nm">原第 ' + p + ' 页</span>' +
        '<span class="ops">' +
          '<button type="button" data-op="up" title="上移">↑</button>' +
          '<button type="button" data-op="down" title="下移">↓</button>' +
          '<button type="button" data-op="dup" title="复制一份">⧉</button>' +
          '<button type="button" data-op="rm" class="rm" title="移除">×</button>' +
        '</span></div>';
    }).join('');

    // 渲染缩略图
    order.forEach(function (p) {
      var preview = list.querySelector('.thumb-preview[data-page="' + p + '"]');
      if (!preview) return;
      window.pdfjsDoc.getPage(p).then(function (page) {
        var base = page.getViewport({ scale: 1 });
        var scale = 48 / base.width;
        var vp = page.getViewport({ scale: scale });
        var canvas = document.createElement('canvas');
        var dpr = Math.min(2, global.devicePixelRatio || 1);
        canvas.width = Math.max(1, Math.floor(vp.width * dpr));
        canvas.height = Math.max(1, Math.floor(vp.height * dpr));
        canvas.style.width = '100%';
        canvas.style.height = '100%';
        var ctx = canvas.getContext('2d');
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.scale(dpr, dpr);
        page.render({ canvasContext: ctx, viewport: vp }).promise.then(function () {
          preview.innerHTML = '';
          preview.appendChild(canvas);
        });
      });
    });

    list.querySelectorAll('[data-op]').forEach(function (btn) {
      btn.addEventListener('click', function (e) {
        e.stopPropagation();
        var row = btn.closest('.pick-item');
        var pos = parseInt(row.dataset.pos, 10);
        var op = btn.dataset.op;
        if (op === 'up' && pos > 0) {
          var t = order[pos - 1]; order[pos - 1] = order[pos]; order[pos] = t;
        } else if (op === 'down' && pos < order.length - 1) {
          var t2 = order[pos + 1]; order[pos + 1] = order[pos]; order[pos] = t2;
        } else if (op === 'dup') {
          order.splice(pos + 1, 0, order[pos]);
        } else if (op === 'rm') {
          if (order.length <= 1) { toast('至少要保留一页', 'warn'); return; }
          order.splice(pos, 1);
        }
        renderOrderList(order);
      });
    });

    // 拖拽排序
    var dragPos = null;
    list.querySelectorAll('.pick-item').forEach(function (row) {
      row.addEventListener('dragstart', function (e) {
        dragPos = parseInt(row.dataset.pos, 10);
        row.classList.add('dragging');
        if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
      });
      row.addEventListener('dragend', function () {
        row.classList.remove('dragging');
        list.querySelectorAll('.pick-item').forEach(function (r) { r.classList.remove('drag-over'); });
      });
      row.addEventListener('dragover', function (e) {
        if (dragPos === null) return;
        e.preventDefault();
        row.classList.add('drag-over');
      });
      row.addEventListener('dragleave', function () { row.classList.remove('drag-over'); });
      row.addEventListener('drop', function (e) {
        e.preventDefault();
        row.classList.remove('drag-over');
        if (dragPos === null) return;
        var to = parseInt(row.dataset.pos, 10);
        if (dragPos === to) { dragPos = null; return; }
        var moved = order.splice(dragPos, 1)[0];
        order.splice(to, 0, moved);
        dragPos = null;
        renderOrderList(order);
      });
    });
  }

  /* =====================================================================
     功能 9：页面大小调整
     ===================================================================== */
  function actResizePage() {
    if (!requireDoc()) return;
    var pages = targetPages();
    var total = window.pdfDoc.getPageCount();
    var infos = PdfOps.getPageInfos(window.pdfDoc);
    var cur = infos[window.currentPage - 1] || { width: 595.28, height: 841.89 };

    openModal({
      title: '调整页面大小',
      wide: true,
      html:
        '<div class="note">将作用于选中的 ' + pages.length + ' 个页面（第 ' +
          PdfOps.formatPageRanges(pages.map(function (p) { return p - 1; })) + ' 页）。</div>' +
        '<div class="field"><label>目标页面范围 <span class="sub">可修改</span></label>' +
          '<input type="text" id="rzRange" value="' + PdfOps.formatPageRanges(pages.map(function (p) { return p - 1; })) + '"></div>' +
        '<div class="field"><label>预设尺寸</label>' +
          chipGroup('rzPreset', [
            { value: 'A4', label: 'A4' },
            { value: 'A3', label: 'A3' },
            { value: 'A5', label: 'A5' },
            { value: 'B5', label: 'B5' },
            { value: 'Letter', label: 'Letter' },
            { value: 'Legal', label: 'Legal' },
            { value: 'Tabloid', label: 'Tabloid' },
            { value: 'custom', label: '自定义' }
          ], 'A4') + '</div>' +
        '<div class="field-row field-row-3">' +
          '<div><label>宽度</label><input type="number" id="rzW" value="210" step="0.1"></div>' +
          '<div><label>高度</label><input type="number" id="rzH" value="297" step="0.1"></div>' +
          '<div><label>单位</label><select id="rzUnit">' +
            '<option value="mm" selected>毫米 mm</option><option value="pt">点 pt</option>' +
            '<option value="in">英寸 in</option><option value="cm">厘米 cm</option>' +
          '</select></div>' +
        '</div>' +
        '<div class="field"><label>方向</label>' +
          chipGroup('rzOrient', [
            { value: 'auto', label: '按预设' },
            { value: 'portrait', label: '纵向' },
            { value: 'landscape', label: '横向' }
          ], 'auto') + '</div>' +
        '<div class="field"><label>内容处理方式</label>' +
          chipGroup('rzMode', [
            { value: 'center', label: '居中保留原大小' },
            { value: 'scale', label: '等比缩放铺满' },
            { value: 'crop', label: '只改页面框（可能裁切）' }
          ], 'center') + '</div>' +
        '<div class="note">当前页尺寸：' + escapeHtml(PdfOps.describeSize(cur.width, cur.height)) + '</div>',
      confirmText: '应用',
      onOpen: function (root) {
        bindChips(root);
        var presetSizes = PdfOps.PAGE_SIZES;
        function applyPreset(v) {
          if (v === 'custom') return;
          var s = presetSizes[v];
          if (!s) return;
          var orient = chipValue(root, 'rzOrient', 'auto');
          var w = s[0], h = s[1];
          if (orient === 'landscape' && h > w) { var t = w; w = h; h = t; }
          if (orient === 'portrait' && w > h) { var t2 = w; w = h; h = t2; }
          // 换算到当前单位
          var unit = $('rzUnit').value;
          $('rzW').value = PdfOps.fromPt(w, unit).toFixed(2);
          $('rzH').value = PdfOps.fromPt(h, unit).toFixed(2);
        }
        root.querySelectorAll('input[name=rzPreset]').forEach(function (i) {
          i.addEventListener('change', function () { applyPreset(i.value); });
        });
        root.querySelectorAll('input[name=rzOrient]').forEach(function (i) {
          i.addEventListener('change', function () {
            applyPreset(chipValue(root, 'rzPreset', 'A4'));
          });
        });
        $('rzUnit').addEventListener('change', function () {
          applyPreset(chipValue(root, 'rzPreset', 'A4'));
        });
        applyPreset('A4');
      },
      onConfirm: function (root) {
        var total2 = window.pdfDoc.getPageCount();
        var idxs = PdfOps.parsePageRanges($('rzRange').value, total2);
        if (!idxs.length) { toast('页码范围无效', 'warn'); return false; }
        var w = parseFloat($('rzW').value);
        var h = parseFloat($('rzH').value);
        if (!(w > 0) || !(h > 0)) { toast('宽高必须大于 0', 'warn'); return false; }
        var unit = $('rzUnit').value;
        var mode = chipValue(root, 'rzMode', 'center');
        return run('正在调整页面大小…', function () {
          PdfOps.resizePages(window.pdfDoc, idxs, { width: w, height: h, unit: unit, mode: mode });
          return commitAndRefresh(null, false);
        }, { successMsg: '已调整 ' + idxs.length + ' 个页面的尺寸' });
      }
    });
  }

  /* =====================================================================
     功能 10：旋转页面
     ===================================================================== */
  function actRotate(delta) {
    if (!requireDoc()) return;
    var pages = targetPages();
    run('正在旋转页面…', function () {
      PdfOps.rotatePages(window.pdfDoc, pages.map(function (p) { return p - 1; }), delta);
      syncRotationState();
      return commitAndRefresh(null, false);
    }, { successMsg: '已' + (delta > 0 ? '顺时针' : '逆时针') + '旋转 ' + pages.length + ' 个页面 90°' });
  }

  /* =====================================================================
     功能 11：合并 PDF
     ===================================================================== */
  function actMergePdf() {
    openModal({
      title: '合并多个 PDF',
      wide: true,
      html:
        '<div class="note">选择多个 PDF 文件，拖拽调整顺序后合并为一个文档。' +
          '合并结果会载入当前工作区并自动下载。</div>' +
        '<div class="field"><label>选择文件 <span class="sub">可多选</span></label>' +
          '<input type="file" id="mgFiles" accept="application/pdf,.pdf" multiple></div>' +
        '<div class="pick-list-head"><span>待合并文件（可拖拽排序）</span>' +
          '<span id="mgCount">0 个文件</span></div>' +
        '<div class="pick-list" id="mgList" style="min-height:60px">' +
          '<div style="padding:16px;text-align:center;color:#97a0af;font-size:12px">尚未选择文件</div>' +
        '</div>' +
        '<div class="field" style="margin-top:12px"><label>合并后文件名</label>' +
          '<input type="text" id="mgName" value="merged.pdf"></div>',
      confirmText: '开始合并',
      onOpen: function () {
        var files = [];

        function render() {
          var list = $('mgList');
          if (!files.length) {
            list.innerHTML = '<div style="padding:16px;text-align:center;color:#97a0af;font-size:12px">尚未选择文件</div>';
          } else {
            list.innerHTML = files.map(function (f, i) {
              return '<div class="pick-item" draggable="true" data-pos="' + i + '">' +
                '<span class="idx">' + (i + 1) + '</span>' +
                '<span class="nm">' + escapeHtml(f.name) + '</span>' +
                '<span class="sz">' + (f.pages ? f.pages + ' 页 · ' : '') + PdfOps.formatBytes(f.size) + '</span>' +
                '<span class="ops">' +
                  '<button type="button" data-op="up" title="上移">↑</button>' +
                  '<button type="button" data-op="down" title="下移">↓</button>' +
                  '<button type="button" data-op="rm" class="rm" title="移除">×</button>' +
                '</span></div>';
            }).join('');
          }
          $('mgCount').textContent = files.length + ' 个文件';
          bindOps();
        }

        function bindOps() {
          var list = $('mgList');
          list.querySelectorAll('[data-op]').forEach(function (b) {
            b.addEventListener('click', function (e) {
              e.stopPropagation();
              var pos = parseInt(b.closest('.pick-item').dataset.pos, 10);
              if (b.dataset.op === 'up' && pos > 0) {
                var t = files[pos - 1]; files[pos - 1] = files[pos]; files[pos] = t;
              } else if (b.dataset.op === 'down' && pos < files.length - 1) {
                var t2 = files[pos + 1]; files[pos + 1] = files[pos]; files[pos] = t2;
              } else if (b.dataset.op === 'rm') {
                files.splice(pos, 1);
              }
              render();
            });
          });
          var dragPos = null;
          list.querySelectorAll('.pick-item').forEach(function (row) {
            row.addEventListener('dragstart', function (e) {
              dragPos = parseInt(row.dataset.pos, 10);
              row.classList.add('dragging');
              if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
            });
            row.addEventListener('dragend', function () {
              row.classList.remove('dragging');
              list.querySelectorAll('.pick-item').forEach(function (r) { r.classList.remove('drag-over'); });
            });
            row.addEventListener('dragover', function (e) {
              if (dragPos === null) return;
              e.preventDefault();
              row.classList.add('drag-over');
            });
            row.addEventListener('dragleave', function () { row.classList.remove('drag-over'); });
            row.addEventListener('drop', function (e) {
              e.preventDefault();
              row.classList.remove('drag-over');
              if (dragPos === null) return;
              var to = parseInt(row.dataset.pos, 10);
              if (dragPos === to) { dragPos = null; return; }
              var moved = files.splice(dragPos, 1)[0];
              files.splice(to, 0, moved);
              dragPos = null;
              render();
            });
          });
        }

        $('mgFiles').addEventListener('change', function () {
          var picked = Array.prototype.slice.call(this.files || []);
          this.value = '';
          if (!picked.length) return;
          run('正在读取文件信息…', function () {
            return picked.reduce(function (chain, f) {
              return chain.then(function () {
                return PdfOps.readAsArrayBuffer(f).then(function (buf) {
                  return PdfOps.loadDocument(buf).then(function (doc) {
                    files.push({ name: f.name, size: f.size, bytes: buf, pages: doc.getPageCount() });
                  }).catch(function () {
                    files.push({ name: f.name, size: f.size, bytes: buf, pages: 0 });
                  });
                });
              });
            }, Promise.resolve());
          }, { progress: false }).then(render).catch(function () { render(); });
        });

        // 供 onConfirm 使用（闭包内数组）
        $('mgList').__getFiles = function () { return files; };
        render();
      },
      onConfirm: function () {
        var files = $('mgList').__getFiles ? $('mgList').__getFiles() : [];
        if (!files.length) { toast('请先选择至少一个 PDF 文件', 'warn'); return false; }
        var totalPages = files.reduce(function (s, f) { return s + (f.pages || 0); }, 0);

        var name = ($('mgName').value || 'merged.pdf').trim();
        if (!/\.pdf$/i.test(name)) name += '.pdf';

        return run('正在合并文档…', function (report) {
          return PdfOps.mergeDocuments(files, function (done, total) {
            report(done, total);
            setStatus('正在合并：' + done + ' / ' + total + ' 个文件', 'busy');
          }).then(function (doc) {
            return PdfOps.saveDocument(doc).then(function (bytes) {
              state.fileName = name;
              state.fileSize = bytes.length;
              state.fileBytes = bytes.slice(0).buffer;
              state.pendingEdits = [];
              window.selectedPages.clear();
              window.currentPage = 1;
              return rebuildFromBuffer(bytes, true).then(function () {
                saveBlob(new Blob([bytes], { type: 'application/pdf' }), name);
              });
            });
          });
        }, { successMsg: '合并完成，共 ' + totalPages + ' 页', progress: true });
      }
    });
  }

  /* =====================================================================
     功能 13：压缩 PDF
     ===================================================================== */
  function actCompressPdf() {
    if (!requireDoc()) return;
    var total = window.pdfDoc.getPageCount();

    openModal({
      title: '压缩 PDF',
      wide: true,
      html:
        '<div class="note">当前文件大小：<b>' + PdfOps.formatBytes(state.fileSize) + '</b>，共 ' + total + ' 页。</div>' +
        '<div class="field"><label>压缩级别</label>' +
          chipGroup('cpLevel', [
            { value: 'low', label: '低（仅优化结构，无损）' },
            { value: 'medium', label: '中（推荐，明显减小）' },
            { value: 'high', label: '高（体积最小，画质下降）' }
          ], 'medium') + '</div>' +
        '<div class="note warn">说明：<br>' +
          '· <b>低</b>：重建 PDF 结构、启用对象流压缩，文字保持矢量不失真，压缩幅度通常较小。<br>' +
          '· <b>中 / 高</b>：把每页栅格化为 JPEG 图片后重建，对扫描件 / 图片型 PDF 效果显著；' +
          '但页面文字会变成图片，<b>不再可选中复制</b>，请谨慎使用。<br>' +
          '· 压缩结果会替换当前工作区，原文件不会被修改。</div>',
      confirmText: '开始压缩',
      onOpen: function (root) { bindChips(root); },
      onConfirm: function (root) {
        var level = chipValue(root, 'cpLevel', 'medium');
        return run('正在压缩文档…', function (report) {
          var before = state.fileSize;
          var task;
          if (level === 'low') {
            task = PdfOps.compressStructural(window.pdfDoc);
          } else {
            if (!window.pdfjsDoc) throw new Error('预览文档尚未就绪，请稍后重试');
            task = PdfOps.compressRaster(window.pdfjsDoc, level, function (d, t) {
              report(d, t);
              setStatus('正在压缩第 ' + d + ' / ' + t + ' 页', 'busy');
            });
          }
          return task.then(function (bytes) {
            var after = bytes.length;
            var ratio = before > 0 ? (1 - after / before) * 100 : 0;
            state.fileSize = after;
            state.fileBytes = bytes.slice(0).buffer;
            state.pendingEdits = [];
            return rebuildFromBuffer(bytes, false).then(function () {
              var msg = ratio > 0
                ? '压缩完成：' + PdfOps.formatBytes(before) + ' → ' + PdfOps.formatBytes(after) +
                  '（减少 ' + ratio.toFixed(1) + '%）'
                : '压缩完成：' + PdfOps.formatBytes(before) + ' → ' + PdfOps.formatBytes(after) +
                  '（该文件已较紧凑，体积略有变化）';
              toast(msg, ratio > 0 ? 'success' : 'info', 6000);
            });
          });
        }, { progress: true });
      }
    });
  }

  /* =====================================================================
     功能 14：插入书签 / 目录
     ===================================================================== */
  function actAddBookmark() {
    if (!requireDoc()) return;
    var total = window.pdfDoc.getPageCount();
    var existing = PdfOps.getBookmarks(window.pdfDoc);
    var rows = existing.length ? existing.slice(0, 60) : [
      { title: '第一章', page: 1, level: 1 },
      { title: '第一节', page: Math.min(2, total), level: 2 }
    ];

    openModal({
      title: '添加书签 / 目录',
      wide: true,
      html:
        '<div class="note">书签会写入 PDF 的 Outline（大纲），在 Adobe Reader、WPS、' +
          'Chrome 等阅读器的书签面板中可见。文档共 ' + total + ' 页。' +
          (existing.length ? '<br>已检测到 ' + existing.length + ' 个现有书签，已载入下方供编辑。' : '') +
        '</div>' +
        '<div class="field"><label>书签列表</label>' +
          '<div id="bmList"></div>' +
          '<div style="display:flex;gap:6px;margin-top:8px;flex-wrap:wrap">' +
            '<button class="mini-btn" type="button" id="bmAdd1">＋ 一级书签</button>' +
            '<button class="mini-btn" type="button" id="bmAdd2">＋ 二级书签</button>' +
            '<button class="mini-btn" type="button" id="bmAuto">按每页自动生成</button>' +
            '<button class="mini-btn" type="button" id="bmClear">清空</button>' +
          '</div>' +
        '</div>' +
        '<div class="field"><label>预设模板</label>' +
          '<div class="radio-row">' +
            '<button class="mini-btn" type="button" id="bmTpl1">封面 + 目录 + 正文</button>' +
            '<button class="mini-btn" type="button" id="bmTpl2">第一部分 / 第二部分</button>' +
          '</div></div>' +
        '<div class="note">提示：页码填 1 表示跳转到第 1 页；级别 2 的书签会归入上方最近的一级书签之下。</div>',
      confirmText: '写入书签',
      onOpen: function () {
        renderBmRows(rows);

        $('bmAdd1').addEventListener('click', function () {
          rows.push({ title: '新书签', page: 1, level: 1 });
          renderBmRows(rows);
        });
        $('bmAdd2').addEventListener('click', function () {
          rows.push({ title: '新子书签', page: 1, level: 2 });
          renderBmRows(rows);
        });
        $('bmClear').addEventListener('click', function () {
          rows.length = 0;
          renderBmRows(rows);
        });
        $('bmAuto').addEventListener('click', function () {
          rows.length = 0;
          for (var i = 1; i <= Math.min(total, 80); i++) {
            rows.push({ title: '第 ' + i + ' 页', page: i, level: 1 });
          }
          renderBmRows(rows);
          if (total > 80) toast('文档页数较多，已生成前 80 页的书签', 'info');
        });
        $('bmTpl1').addEventListener('click', function () {
          rows.length = 0;
          rows.push({ title: '封面', page: 1, level: 1 });
          if (total >= 2) rows.push({ title: '目录', page: 2, level: 1 });
          if (total >= 3) rows.push({ title: '正文', page: 3, level: 1 });
          renderBmRows(rows);
        });
        $('bmTpl2').addEventListener('click', function () {
          var mid = Math.ceil(total / 2);
          rows.length = 0;
          rows.push({ title: '第一部分', page: 1, level: 1 });
          rows.push({ title: '第二部分', page: mid, level: 1 });
          renderBmRows(rows);
        });
      },
      onConfirm: function () {
        var collected = collectBmRows();
        if (!collected.length) { toast('请至少添加一个书签', 'warn'); return false; }
        for (var i = 0; i < collected.length; i++) {
          if (!collected[i].title.trim()) { toast('第 ' + (i + 1) + ' 个书签标题不能为空', 'warn'); return false; }
          if (collected[i].page < 1 || collected[i].page > total) {
            toast('第 ' + (i + 1) + ' 个书签页码需在 1 ~ ' + total + ' 之间', 'warn');
            return false;
          }
        }
        return run('正在写入书签…', function () {
          var n = PdfOps.setBookmarks(window.pdfDoc, collected);
          return commitAndRefresh(null, false).then(function () {
            toast('已写入 ' + n + ' 个书签', 'success');
          });
        });
      }
    });
  }

  function renderBmRows(rows) {
    var box = $('bmList');
    if (!box) return;
    box.innerHTML = rows.map(function (r, i) {
      return '<div class="bm-row" data-i="' + i + '">' +
        '<span class="lvl">' + (r.level >= 2 ? '└ 二级' : '一级') + '</span>' +
        '<input class="bm-title" type="text" value="' + escapeHtml(r.title) + '" placeholder="书签标题">' +
        '<input class="bm-page" type="number" min="1" value="' + (r.page || 1) + '" title="跳转页码">' +
        '<span class="ops">' +
          '<button type="button" data-op="up">↑</button>' +
          '<button type="button" data-op="down">↓</button>' +
          '<button type="button" data-op="lvl" title="切换级别">⇄</button>' +
          '<button type="button" data-op="rm" class="rm">×</button>' +
        '</span></div>';
    }).join('');

    box.querySelectorAll('[data-op]').forEach(function (b) {
      b.addEventListener('click', function () {
        var i = parseInt(b.closest('.bm-row').dataset.i, 10);
        var op = b.dataset.op;
        syncBmRows(rows);
        if (op === 'up' && i > 0) {
          var t = rows[i - 1]; rows[i - 1] = rows[i]; rows[i] = t;
        } else if (op === 'down' && i < rows.length - 1) {
          var t2 = rows[i + 1]; rows[i + 1] = rows[i]; rows[i] = t2;
        } else if (op === 'lvl') {
          rows[i].level = rows[i].level >= 2 ? 1 : 2;
        } else if (op === 'rm') {
          rows.splice(i, 1);
        }
        renderBmRows(rows);
      });
    });
  }

  /** 把 DOM 中的编辑同步回 rows */
  function syncBmRows(rows) {
    var box = $('bmList');
    if (!box) return;
    box.querySelectorAll('.bm-row').forEach(function (row) {
      var i = parseInt(row.dataset.i, 10);
      if (!rows[i]) return;
      rows[i].title = row.querySelector('.bm-title').value;
      rows[i].page = parseInt(row.querySelector('.bm-page').value, 10) || 1;
    });
  }

  function collectBmRows() {
    var box = $('bmList');
    if (!box) return [];
    return Array.prototype.map.call(box.querySelectorAll('.bm-row'), function (row) {
      return {
        title: row.querySelector('.bm-title').value,
        page: parseInt(row.querySelector('.bm-page').value, 10) || 1,
        level: /二级/.test(row.querySelector('.lvl').textContent) ? 2 : 1
      };
    });
  }

  /* =====================================================================
     功能 15：编辑页面内容（添加文字）
     ===================================================================== */
  function actAddText() {
    if (!requireDoc()) return;
    var page = window.currentPage;
    var infos = PdfOps.getPageInfos(window.pdfDoc);
    var info = infos[page - 1];

    openModal({
      title: '添加文字 · 第 ' + page + ' 页',
      wide: true,
      html:
        '<div class="note">先设置文字样式并点击"开始放置"，然后在预览区 <b>点击目标位置</b> 即可落点。' +
          '页面尺寸：' + escapeHtml(info ? info.sizeText : '') + '</div>' +
        '<div class="field"><label>文字内容 <span class="sub">支持多行</span></label>' +
          '<textarea id="txText" placeholder="请输入要添加的文字…">精算说明</textarea></div>' +
        '<div class="field-row">' +
          '<div><label>字体</label><select id="txFont">' +
            '<option value="Helvetica">Helvetica</option>' +
            '<option value="HelveticaBold">Helvetica Bold</option>' +
            '<option value="TimesRoman">Times Roman</option>' +
            '<option value="TimesBold">Times Bold</option>' +
            '<option value="Courier">Courier</option>' +
            '<option value="CourierBold">Courier Bold</option>' +
          '</select></div>' +
          '<div><label>字号 <span class="sub">pt</span></label>' +
            '<input type="number" id="txSize" min="4" max="200" value="16"></div>' +
        '</div>' +
        '<div class="field-row">' +
          '<div><label>颜色</label><input type="color" id="txColor" value="#1f2430"></div>' +
          '<div><label>不透明度 <span class="sub" id="txOpVal">100%</span></label>' +
            '<input type="range" id="txOpacity" min="5" max="100" value="100"></div>' +
        '</div>' +
        '<div class="field-row">' +
          '<div><label>旋转角度 <span class="sub">度</span></label>' +
            '<input type="number" id="txRotate" min="-180" max="180" step="1" value="0"></div>' +
          '<div><label>行高倍数</label>' +
            '<input type="number" id="txLineHeight" min="1" max="3" step="0.05" value="1.35"></div>' +
        '</div>' +
        '<div class="field"><label>换行宽度 <span class="sub">pt，超出自动换行</span></label>' +
          '<input type="number" id="txMaxWidth" min="20" value="' +
            Math.round((info ? info.width : 595) - 80) + '"></div>' +
        '<div class="field"><label>放置方式</label>' +
          chipGroup('txMode', [
            { value: 'click', label: '点击页面落点（推荐）' },
            { value: 'center', label: '直接居中放置' }
          ], 'click') + '</div>' +
        '<div class="note warn" id="txCJKHint" style="display:none">' +
          '检测到中文内容：需要嵌入中文字体（首次使用会从 CDN 下载约 1.5 MB 字体文件，请稍候）。</div>',
      confirmText: '开始放置',
      onOpen: function (root) {
        bindChips(root);
        var ta = $('txText');
        var hint = $('txCJKHint');
        var preloaded = false;

        function check() {
          var need = PdfOps.needsCJK(ta.value);
          hint.style.display = need ? '' : 'none';
          // 首次检测到中文时后台预加载字体，缩短后续"应用编辑"的等待
          if (need && !preloaded) {
            preloaded = true;
            hint.textContent = '正在下载中文字体（约 1.5 MB，仅首次需要）…';
            PdfOps.ensureFontkit();
            PdfOps.preloadCJKFont()
              .then(function () {
                hint.textContent = '中文字体已就绪，可以直接使用中文。';
                hint.className = 'note';
              })
              .catch(function () {
                hint.textContent = '中文字体下载失败，请检查网络后重试（或改用英文文字）。';
              });
          }
        }
        ta.addEventListener('input', check);
        check();
        $('txOpacity').addEventListener('input', function () {
          $('txOpVal').textContent = this.value + '%';
        });
      },
      onConfirm: function (root) {
        var text = $('txText').value;
        if (!text.trim()) { toast('文字内容不能为空', 'warn'); return false; }
        var style = {
          text: text,
          fontName: $('txFont').value,
          size: parseFloat($('txSize').value) || 16,
          color: hexToRgb($('txColor').value),
          opacity: (parseFloat($('txOpacity').value) || 100) / 100,
          rotate: parseFloat($('txRotate').value) || 0,
          lineHeight: parseFloat($('txLineHeight').value) || 1.35,
          maxWidth: parseFloat($('txMaxWidth').value) || undefined
        };
        var mode = chipValue(root, 'txMode', 'click');
        if (mode === 'center') {
          style.x = Math.max(20, ((info ? info.width : 595) - (style.maxWidth || 300)) / 2);
          style.y = (info ? info.height : 842) / 2;
          style.coordFromTop = true;
          addPendingText(page, style);
        } else {
          startPlacement('text', page, style);
        }
      }
    });
  }

  /** 进入"点击落点"模式 */
  function startPlacement(kind, page, payload) {
    state.placing = { kind: kind, page: page, payload: payload };
    el.editLayer.classList.add('active');
    toast('请在预览区点击要放置的位置（按 Esc 取消）', 'info', 4000);
    setStatus('放置模式：点击页面确定位置', 'busy');
  }

  function cancelPlacement() {
    if (!state.placing) return;
    state.placing = null;
    el.editLayer.classList.remove('active');
    setStatus('就绪', 'ok');
  }

  /* 点击预览区落点 */
  function bindEditLayerClick() {
    el.canvasHolder.addEventListener('click', function (e) {
      if (!state.placing) return;
      var p = state.placing;
      if (p.page !== window.currentPage) {
        toast('已跳转到第 ' + p.page + ' 页，请再次点击', 'info');
        gotoPage(p.page);
        return;
      }
      var rect = el.canvas.getBoundingClientRect();
      var cx = e.clientX - rect.left;
      var cy = e.clientY - rect.top;

      // 视口坐标 → PDF 坐标（考虑旋转）
      var info = PdfOps.getPageInfos(window.pdfDoc)[window.currentPage - 1];
      var rot = info ? info.rotation : 0;
      var scale = state.renderScale || 1;
      var pt = viewportToPdf(cx, cy, info.width, info.height, rot, scale);

      if (p.kind === 'text') {
        var style = {};
        for (var k in p.payload) style[k] = p.payload[k];
        style.x = pt.x;
        style.y = pt.y;               // 已是 PDF 坐标（自底向上）
        style.coordFromTop = false;
        addPendingText(p.page, style);
      } else if (p.kind === 'image') {
        var img = {};
        for (var k2 in p.payload) img[k2] = p.payload[k2];
        img.x = pt.x;
        img.y = pt.y;
        img.coordFromTop = false;
        addPendingImage(p.page, img);
      }
      cancelPlacement();
    });
  }

  /**
   * 视口坐标（相对 canvas 左上，已含缩放）→ PDF 坐标（pt，自底向上）
   *
   * 推导依据 pdf.js PageViewport 的变换矩阵：设页面 MediaBox 为 (0,0,pw,ph)，
   * 显示旋转角为 rot（顺时针），则：
   *   rot=0   : deviceX = s*px            deviceY = s*(ph - py)
   *   rot=90  : deviceX = s*py            deviceY = s*px
   *   rot=180 : deviceX = s*(pw - px)     deviceY = s*py
   *   rot=270 : deviceX = s*(ph - py)     deviceY = s*(pw - px)
   * 其中 s 为缩放比例。下面即为上式的逆变换。
   *
   * @param {number} cx 视口 x（px，相对 canvas 左上）
   * @param {number} cy 视口 y（px，相对 canvas 左上）
   * @param {number} pw 未旋转页面宽度（pt）
   * @param {number} ph 未旋转页面高度（pt）
   * @param {number} rot 显示旋转角 0/90/180/270
   * @param {number} scale 渲染缩放
   * @returns {{x:number, y:number}} PDF 坐标（pt）
   */
  function viewportToPdf(cx, cy, pw, ph, rot, scale) {
    var vx = cx / scale;
    var vy = cy / scale;
    rot = ((rot % 360) + 360) % 360;
    switch (rot) {
      case 90:  return { x: vy,        y: vx };
      case 180: return { x: pw - vx,   y: vy };
      case 270: return { x: ph - vy,   y: pw - vx };
      default:  return { x: vx,        y: ph - vy };
    }
  }

  /**
   * PDF 坐标（pt，自底向上）→ 视口坐标（px，相对 canvas 左上）
   * 为上面 viewportToPdf 的逆函数。
   */
  function pdfToViewport(px, py, pw, ph, rot, scale) {
    rot = ((rot % 360) + 360) % 360;
    switch (rot) {
      case 90:  return { x: py * scale,           y: px * scale };
      case 180: return { x: (pw - px) * scale,    y: py * scale };
      case 270: return { x: (pw - py) * scale,    y: (ph - px) * scale };
      default:  return { x: px * scale,           y: (ph - py) * scale };
    }
  }

  /** 记录一条待应用的文字编辑 */
  function addPendingText(page, style) {
    state.pendingEdits.push({ type: 'text', page: page, style: style });
    renderEditLayer();
    updateUiState();
    toast('文字已加入待应用列表，点击"应用编辑"写入 PDF', 'info', 3600);
  }

  /* =====================================================================
     功能 16：添加图片
     ===================================================================== */
  function actAddImage() {
    if (!requireDoc()) return;
    el.imageInput.click();
  }

  function openImageEditor(file) {
    var page = window.currentPage;
    var infos = PdfOps.getPageInfos(window.pdfDoc);
    var info = infos[page - 1];

    PdfOps.readAsDataURL(file).then(function (dataUrl) {
      return new Promise(function (resolve) {
        var img = new Image();
        img.onload = function () { resolve(img); };
        img.onerror = function () { resolve(null); };
        img.src = dataUrl;
      }).then(function (img) {
        if (!img) { toast('图片读取失败', 'error'); return; }
        var naturalW = img.naturalWidth || img.width;
        var naturalH = img.naturalHeight || img.height;

        openModal({
          title: '插入图片 · 第 ' + page + ' 页',
          wide: true,
          html:
            '<div class="note">图片：' + escapeHtml(file.name) + '（' +
              naturalW + ' × ' + naturalH + ' px，' + PdfOps.formatBytes(file.size) + '）<br>' +
              '页面尺寸：' + escapeHtml(info ? info.sizeText : '') + '</div>' +
            '<div style="text-align:center;margin-bottom:12px">' +
              '<img src="' + dataUrl + '" style="max-width:100%;max-height:180px;border:1px solid #e2e6ec;border-radius:4px">' +
            '</div>' +
            '<div class="field"><label>尺寸模式</label>' +
              chipGroup('imSizeMode', [
                { value: 'preset', label: '按预设尺寸' },
                { value: 'custom', label: '自定义宽高（pt）' }
              ], 'preset') + '</div>' +
            '<div class="field" id="imPresetBox"><label>预设尺寸 <span class="sub">宽度 pt</span></label>' +
              chipGroup('imPreset', [
                { value: '100', label: '小 100' },
                { value: '200', label: '中 200' },
                { value: '320', label: '大 320' },
                { value: '450', label: '特大 450' },
                { value: 'full', label: '适应页宽' }
              ], '200') + '</div>' +
            '<div class="field-row" id="imCustomBox" style="display:none">' +
              '<div><label>宽度 pt</label><input type="number" id="imW" value="200" min="1"></div>' +
              '<div><label>高度 pt</label><input type="number" id="imH" value="200" min="1"></div>' +
            '</div>' +
            '<div class="field"><label>锁定宽高比</label>' +
              chipGroup('imRatio', [
                { value: '1', label: '保持原始比例' },
                { value: '0', label: '自由拉伸' }
              ], '1') + '</div>' +
            '<div class="field-row">' +
              '<div><label>不透明度 <span class="sub" id="imOpVal">100%</span></label>' +
                '<input type="range" id="imOpacity" min="5" max="100" value="100"></div>' +
              '<div><label>旋转角度 <span class="sub">度</span></label>' +
                '<input type="number" id="imRotate" min="-180" max="180" value="0"></div>' +
            '</div>' +
            '<div class="field"><label>放置方式</label>' +
              chipGroup('imMode', [
                { value: 'click', label: '点击页面落点（推荐）' },
                { value: 'center', label: '居中放置' }
              ], 'click') + '</div>',
          confirmText: '开始放置',
          onOpen: function (root) {
            bindChips(root);
            $('imOpacity').addEventListener('input', function () {
              $('imOpVal').textContent = this.value + '%';
            });
            root.querySelectorAll('input[name=imSizeMode]').forEach(function (i) {
              i.addEventListener('change', function () {
                $('imPresetBox').style.display = i.value === 'preset' ? '' : 'none';
                $('imCustomBox').style.display = i.value === 'custom' ? '' : 'none';
              });
            });
            // 预设变化时同步自定义框
            root.querySelectorAll('input[name=imPreset]').forEach(function (i) {
              i.addEventListener('change', function () {
                var v = i.value;
                var w = v === 'full' ? (info ? info.width - 60 : 480) : parseFloat(v);
                var h = w * naturalH / naturalW;
                $('imW').value = Math.round(w);
                $('imH').value = Math.round(h);
              });
            });
            $('imW').value = 200;
            $('imH').value = Math.round(200 * naturalH / naturalW);
          },
          onConfirm: function (root) {
            var sizeMode = chipValue(root, 'imSizeMode', 'preset');
            var keepRatio = chipValue(root, 'imRatio', '1') === '1';
            var w, h;
            if (sizeMode === 'preset') {
              var pv = chipValue(root, 'imPreset', '200');
              w = pv === 'full' ? (info ? info.width - 60 : 480) : parseFloat(pv);
              h = w * naturalH / naturalW;
            } else {
              w = parseFloat($('imW').value) || 200;
              h = parseFloat($('imH').value) || 200;
              if (keepRatio) h = w * naturalH / naturalW;
            }
            if (!(w > 0) || !(h > 0)) { toast('图片宽高必须大于 0', 'warn'); return false; }

            var payload = {
              dataUrl: dataUrl,
              width: w,
              height: h,
              opacity: (parseFloat($('imOpacity').value) || 100) / 100,
              rotate: parseFloat($('imRotate').value) || 0,
              naturalW: naturalW,
              naturalH: naturalH,
              name: file.name
            };
            var mode = chipValue(root, 'imMode', 'click');
            if (mode === 'center') {
              payload.x = (info ? info.width - w : 300) / 2;
              payload.y = (info ? info.height - h : 400) / 2;
              payload.coordFromTop = false;
              addPendingImage(page, payload);
            } else {
              startPlacement('image', page, payload);
            }
          }
        });
      });
    }).catch(function (err) {
      toast('读取图片失败：' + err.message, 'error');
    });
  }

  /** 记录一条待应用的图片编辑 */
  function addPendingImage(page, payload) {
    state.pendingEdits.push({ type: 'image', page: page, style: payload });
    renderEditLayer();
    updateUiState();
    toast('图片已加入待应用列表，点击"应用编辑"写入 PDF', 'info', 3600);
  }

  /* =====================================================================
     待定编辑：覆盖层渲染 + 应用
     ===================================================================== */
  /**
   * 页面显示旋转角对应的"屏幕基向量"
   * 用于把 PDF 中的旋转角换算成 CSS 的旋转角。
   * ex = PDF 的 +x 轴在屏幕上的单位方向；ey = PDF 的 +y 轴在屏幕上的单位方向
   */
  function screenBasis(rot) {
    switch (((rot % 360) + 360) % 360) {
      case 90:  return { ex: { x: 0, y: 1 },  ey: { x: 1, y: 0 } };
      case 180: return { ex: { x: -1, y: 0 }, ey: { x: 0, y: 1 } };
      case 270: return { ex: { x: 0, y: -1 }, ey: { x: -1, y: 0 } };
      default:  return { ex: { x: 1, y: 0 },  ey: { x: 0, y: -1 } };
    }
  }

  /** PDF 中的逆时针角度 → CSS 屏幕上的旋转角（度） */
  function pdfAngleToCss(deg, rot) {
    var b = screenBasis(rot);
    var t = (deg || 0) * Math.PI / 180;
    var dx = Math.cos(t) * b.ex.x + Math.sin(t) * b.ey.x;
    var dy = Math.cos(t) * b.ex.y + Math.sin(t) * b.ey.y;
    return Math.atan2(dy, dx) * 180 / Math.PI;
  }

  /** 把待定编辑绘制为预览覆盖层 */
  function renderEditLayer() {
    el.editLayer.innerHTML = '';
    if (!state.pendingEdits.length || !window.pdfDoc) return;

    var page = window.currentPage;
    var info = PdfOps.getPageInfos(window.pdfDoc)[page - 1];
    if (!info) return;
    var scale = state.renderScale || 1;
    var rot = info.rotation || 0;
    var pw = info.width, ph = info.height;

    state.pendingEdits.forEach(function (edit, index) {
      if (edit.page !== page) return;
      var s = edit.style;
      var node = document.createElement('div');
      node.className = 'edit-item';
      node.dataset.index = String(index);

      if (edit.type === 'text') {
        // 锚点：PDF 中文字基线的左端
        var a = pdfToViewport(s.x, s.y, pw, ph, rot, scale);
        var sizePx = (s.size || 14) * scale;
        var cssAngle = pdfAngleToCss(s.rotate || 0, rot);

        node.style.left = a.x + 'px';
        node.style.top = a.y + 'px';
        // 绕"基线左端"旋转：基线距元素顶部约为字号的 0.82 倍
        node.style.transformOrigin = '0 ' + (sizePx * 0.82) + 'px';
        node.style.transform = 'rotate(' + cssAngle + 'deg)';
        node.style.fontSize = sizePx + 'px';
        node.style.lineHeight = String(s.lineHeight || 1.35);
        node.style.color = rgbToHex(s.color);
        node.style.opacity = s.opacity == null ? 1 : s.opacity;
        node.style.fontFamily = fontFamilyCss(s.fontName);
        node.style.whiteSpace = 'pre';
        node.style.position = 'absolute';
        if (s.maxWidth) node.style.maxWidth = (s.maxWidth * scale) + 'px';
        // 元素内部文字从顶部开始，需要上移一个字高让基线落在锚点
        node.style.paddingBottom = (sizePx * 0.82) + 'px';
        node.textContent = s.text;
      } else {
        // 图片：把四角映射到屏幕后取包围盒
        var corners = [
          pdfToViewport(s.x, s.y, pw, ph, rot, scale),
          pdfToViewport(s.x + s.width, s.y, pw, ph, rot, scale),
          pdfToViewport(s.x, s.y + s.height, pw, ph, rot, scale),
          pdfToViewport(s.x + s.width, s.y + s.height, pw, ph, rot, scale)
        ];
        var minX = Math.min.apply(null, corners.map(function (c) { return c.x; }));
        var maxX = Math.max.apply(null, corners.map(function (c) { return c.x; }));
        var minY = Math.min.apply(null, corners.map(function (c) { return c.y; }));
        var maxY = Math.max.apply(null, corners.map(function (c) { return c.y; }));

        node.style.left = minX + 'px';
        node.style.top = minY + 'px';
        node.style.width = Math.max(1, maxX - minX) + 'px';
        node.style.height = Math.max(1, maxY - minY) + 'px';
        node.style.opacity = s.opacity == null ? 1 : s.opacity;
        node.style.transform = 'rotate(' + pdfAngleToCss(s.rotate || 0, rot) + 'deg)';
        node.innerHTML = '<img src="' + s.dataUrl + '" alt="">';
      }

      var del = document.createElement('button');
      del.className = 'del';
      del.textContent = '×';
      del.title = '移除这条编辑';
      del.addEventListener('click', function (e) {
        e.stopPropagation();
        state.pendingEdits.splice(index, 1);
        renderEditLayer();
        updateUiState();
      });
      node.appendChild(del);

      el.editLayer.appendChild(node);
    });
  }

  function fontFamilyCss(name) {
    switch (name) {
      case 'TimesRoman': case 'TimesBold': return '"Times New Roman", Times, serif';
      case 'Courier': case 'CourierBold': return '"Courier New", Courier, monospace';
      default: return 'Helvetica, Arial, sans-serif';
    }
  }

  /** 把待定编辑写入 PDF */
  function applyPendingEdits() {
    if (!state.pendingEdits.length) { toast('没有待应用的编辑', 'info'); return; }
    var edits = state.pendingEdits.slice();

    return run('正在写入编辑内容…', function (report) {
      var chain = Promise.resolve();
      var done = 0;
      var total = edits.length;

      edits.forEach(function (edit) {
        chain = chain.then(function () {
          var p = edit.page - 1;
          var s = edit.style;
          if (edit.type === 'text') {
            return PdfOps.drawText(window.pdfDoc, p, s.text, {
              x: s.x, y: s.y, size: s.size, color: s.color,
              fontName: s.fontName, opacity: s.opacity, rotate: s.rotate,
              maxWidth: s.maxWidth, lineHeight: s.lineHeight,
              coordFromTop: !!s.coordFromTop,
              // 首次写入中文时字体需从 CDN 下载，给出明确提示
              onFontLoading: function () {
                setStatus('正在下载中文字体（约 1.5 MB，仅首次需要）…', 'busy');
                el.loadingText.textContent = '正在下载中文字体（约 1.5 MB，仅首次需要）…';
              }
            });
          }
          // 图片：DataURL → 字节
          return dataUrlToBytes(s.dataUrl).then(function (bytes) {
            return PdfOps.drawImage(window.pdfDoc, p, bytes, {
              x: s.x, y: s.y, width: s.width, height: s.height,
              opacity: s.opacity, rotate: s.rotate, coordFromTop: !!s.coordFromTop
            });
          });
        }).then(function () {
          done++;
          report(done, total);
        });
      });

      return chain.then(function () {
        state.pendingEdits = [];
        return commitAndRefresh(null, false).then(function () {
          toast('已写入 ' + total + ' 条编辑内容', 'success');
        });
      });
    }, { progress: true });
  }

  /** DataURL → Uint8Array */
  function dataUrlToBytes(dataUrl) {
    return new Promise(function (resolve, reject) {
      try {
        var b64 = String(dataUrl).split(',')[1];
        var bin = atob(b64);
        var bytes = new Uint8Array(bin.length);
        for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        resolve(bytes);
      } catch (e) {
        reject(new Error('图片数据解析失败'));
      }
    });
  }

  /* =====================================================================
     功能 17：导出 PDF
     ===================================================================== */
  function actExportPdf() {
    if (!requireDoc()) return;
    var name = defaultName('');

    openModal({
      title: '导出 PDF',
      html:
        '<div class="field"><label>文件名</label>' +
          '<input type="text" id="exName" value="' + escapeHtml(name) + '"></div>' +
        '<div class="field"><label>文档标题（元信息）</label>' +
          '<input type="text" id="exTitle" value="' + escapeHtml(name.replace(/\.pdf$/i, '')) + '"></div>' +
        '<div class="field-row">' +
          '<div><label>作者</label><input type="text" id="exAuthor" value="Kindred"></div>' +
          '<div><label>主题</label><input type="text" id="exSubject" value=""></div>' +
        '</div>' +
        '<div class="field"><label>关键词 <span class="sub">逗号分隔</span></label>' +
          '<input type="text" id="exKeywords" value=""></div>' +
        '<div class="note">当前文档共 ' + window.pdfDoc.getPageCount() + ' 页，大小约 ' +
          PdfOps.formatBytes(state.fileSize) + '。</div>',
      confirmText: '导出下载',
      onConfirm: function () {
        var fileName = ($('exName').value || 'output.pdf').trim();
        if (!/\.pdf$/i.test(fileName)) fileName += '.pdf';
        var meta = {
          title: $('exTitle').value,
          author: $('exAuthor').value,
          subject: $('exSubject').value,
          keywords: $('exKeywords').value
        };
        return run('正在生成 PDF…', function () {
          PdfOps.setMetadata(window.pdfDoc, meta);
          // preserveEditable：导出不应污染当前工作实例，
          // 否则用户导出后就无法继续编辑（pdf-lib 的内容流冻结限制）
          return PdfOps.saveDocument(window.pdfDoc, { preserveEditable: true })
            .then(function (bytes) {
              saveBlob(new Blob([bytes], { type: 'application/pdf' }), fileName);
              state.fileName = fileName;
              state.fileSize = bytes.length;
              updateUiState();
            });
        }, { successMsg: '已导出 ' + fileName });
      }
    });
  }

  /* =====================================================================
     功能 18：打印
     ===================================================================== */
  function actPrint() {
    if (!requireDoc()) return;
    var total = window.pdfDoc.getPageCount();

    openModal({
      title: '打印 PDF',
      html:
        '<div class="note">将通过浏览器打印功能输出。为获得最佳效果，请在打印对话框中：<br>' +
          '· 目标选择「另存为 PDF」或您的打印机<br>' +
          '· 边距选择「无」<br>' +
          '· 勾选「背景图形」<br>' +
          '· 缩放选择「默认」或「100%」</div>' +
        '<div class="field"><label>打印范围</label>' +
          chipGroup('prRange', [
            { value: 'all', label: '全部（' + total + ' 页）' },
            { value: 'current', label: '仅当前页（第 ' + window.currentPage + ' 页）' }
          ], 'all') + '</div>' +
        '<div class="field"><label>页面方向</label>' +
          chipGroup('prOrient', [
            { value: 'auto', label: '自动' },
            { value: 'portrait', label: '纵向' },
            { value: 'landscape', label: '横向' }
          ], 'auto') + '</div>',
      confirmText: '打开打印对话框',
      onOpen: function (root) { bindChips(root); },
      onConfirm: function (root) {
        var range = chipValue(root, 'prRange', 'all');
        var orient = chipValue(root, 'prOrient', 'auto');
        doPrint(range === 'current' ? [window.currentPage] : null, orient);
      }
    });
  }

  /**
   * 在隐藏 iframe 中渲染并打印
   * @param {number[]|null} pageList 1 基页码列表；null 表示全部
   * @param {'auto'|'portrait'|'landscape'} orient
   */
  function doPrint(pageList, orient) {
    run('正在准备打印…', function (report) {
      var pages = pageList || (function () {
        var a = [];
        for (var i = 1; i <= window.pdfjsDoc.numPages; i++) a.push(i);
        return a;
      })();

      var PRINT_SCALE = 2;   // 提高打印分辨率
      var images = [];

      return pages.reduce(function (chain, pno) {
        return chain.then(function () {
          return Converters.renderPageDataUrl(window.pdfjsDoc, pno, PRINT_SCALE).then(function (url) {
            images.push({ page: pno, url: url });
            report(images.length, pages.length);
          });
        });
      }, Promise.resolve()).then(function () {
        var infos = PdfOps.getPageInfos(window.pdfDoc);
        var html = '<!DOCTYPE html><html><head><meta charset="utf-8"><title>打印</title><style>' +
          '@page { margin: 0; size: auto; }' +
          'html,body{margin:0;padding:0;background:#fff}' +
          '.pg{display:block;width:100%;page-break-after:always;break-after:page}' +
          '.pg:last-child{page-break-after:auto;break-after:auto}' +
          '.pg img{display:block;width:100%;height:auto}' +
          '</style></head><body>';

        images.forEach(function (im) {
          var info = infos[im.page - 1];
          var cls = 'pg';
          if (orient === 'portrait') cls += ' portrait';
          else if (orient === 'landscape') cls += ' landscape';
          else if (info && info.width > info.height) cls += ' landscape';
          html += '<div class="' + cls + '"><img src="' + im.url + '"></div>';
        });
        html += '</body></html>';

        // 创建隐藏 iframe
        var iframe = document.createElement('iframe');
        iframe.style.position = 'fixed';
        iframe.style.right = '0';
        iframe.style.bottom = '0';
        iframe.style.width = '0';
        iframe.style.height = '0';
        iframe.style.border = '0';
        iframe.style.opacity = '0';
        document.body.appendChild(iframe);

        return new Promise(function (resolve) {
          iframe.onload = function () {
            setTimeout(function () {
              try {
                iframe.contentWindow.focus();
                iframe.contentWindow.print();
              } catch (e) {
                toast('打印失败：' + e.message, 'error');
              }
              // 延迟移除，等待打印对话框完成
              setTimeout(function () {
                if (iframe.parentNode) iframe.parentNode.removeChild(iframe);
              }, 60000);
              resolve();
            }, 350);
          };
          var doc = iframe.contentWindow.document;
          doc.open();
          doc.write(html);
          doc.close();
        });
      });
    }, { successMsg: '已打开打印对话框', progress: true });
  }

  /* =====================================================================
     PDF → Word / Excel / PPT 转换功能 —— 已下线（2026-10-12）
     下线原因（Kindred 实测反馈）：
     1) 图片化方案：内容不可编辑，生成文件无使用价值；
     2) 结构重建方案：可编辑，但表格推断、版式还原达不到实用标准。
     纯前端 PDF→Office 存在天花板：PDF 无段落/表格语义，只有字符坐标流，
     可靠转换需要 LibreOffice / MS Office 级排版引擎，应放服务端。
     恢复路径：index.html 工具栏"转换"分组 + 本文件 ACTIONS 表
     （toWord / toExcel / toPpt 三条目）+ app.js.bak 内有完整弹窗代码。
     注意：converters.js 的 renderPageDataUrl 被打印功能依赖，勿删该文件引用。
     ===================================================================== */

  /* =====================================================================
     键盘快捷键
     ===================================================================== */
  function bindKeyboard() {
    window.addEventListener('keydown', function (e) {
      // 弹窗打开时只响应 Esc
      var modalOpen = !el.modalMask.hidden;
      if (e.key === 'Escape') {
        if (state.placing) { cancelPlacement(); return; }
        if (modalOpen) closeModal();
        return;
      }
      if (modalOpen) return;

      var tag = (e.target.tagName || '').toLowerCase();
      var typing = tag === 'input' || tag === 'textarea' || tag === 'select';
      if (typing) return;

      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'o') {
        e.preventDefault(); pickFile(); return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault(); actExportPdf(); return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'p') {
        e.preventDefault(); actPrint(); return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'c') {
        if (window.pdfDoc) { e.preventDefault(); actCopyPage(); }
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'v') {
        if (window.pdfDoc && window.clipboardPages) { e.preventDefault(); actPastePage(); }
        return;
      }
      if (e.key === 'Delete' || e.key === 'Backspace') {
        if (window.pdfDoc) { e.preventDefault(); actDeletePage(); }
        return;
      }
      if (e.key === 'ArrowLeft' || e.key === 'PageUp') {
        if (window.pdfDoc) { e.preventDefault(); gotoPage(window.currentPage - 1); }
        return;
      }
      if (e.key === 'ArrowRight' || e.key === 'PageDown') {
        if (window.pdfDoc) { e.preventDefault(); gotoPage(window.currentPage + 1); }
        return;
      }
      if ((e.ctrlKey || e.metaKey) && (e.key === '=' || e.key === '+')) {
        e.preventDefault();
        var cur = typeof window.zoomLevel === 'number' ? window.zoomLevel : 1;
        setZoom(Math.min(5, cur + 0.25)); syncZoomSelect(); return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key === '-') {
        e.preventDefault();
        var cur2 = typeof window.zoomLevel === 'number' ? window.zoomLevel : 1;
        setZoom(Math.max(0.2, cur2 - 0.25)); syncZoomSelect(); return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key === '0') {
        e.preventDefault(); setZoom(1); syncZoomSelect(); return;
      }
    });

    // 编辑层点击
    bindEditLayerClick();
  }

  /* =====================================================================
     通用辅助
     ===================================================================== */
  function saveBlob(blob, filename) {
    if (global.saveAs) {
      global.saveAs(blob, filename);
    } else {
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      setTimeout(function () {
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
      }, 1500);
    }
  }

  function defaultName(suffix) {
    var base = (state.fileName || 'document').replace(/\.pdf$/i, '');
    return base + (suffix || '') + '.pdf';
  }

  function rangeList(start, end, step) {
    var out = [];
    for (var i = start; i <= end; i += step) {
      var j = Math.min(i + step - 1, end);
      out.push(i === j ? String(i) : i + '-' + j);
    }
    return out.join('; ');
  }

  function defaultSplitRanges(total) {
    if (total <= 1) return '1';
    var mid = Math.ceil(total / 2);
    return '1-' + mid + '; ' + (mid + 1) + '-' + total;
  }

  function hexToRgb(hex) {
    var m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(String(hex || '').trim());
    if (!m) return { r: 0, g: 0, b: 0 };
    return {
      r: parseInt(m[1], 16) / 255,
      g: parseInt(m[2], 16) / 255,
      b: parseInt(m[3], 16) / 255
    };
  }

  function rgbToHex(c) {
    if (!c) return '#000000';
    var f = function (v) {
      var n = Math.round(Math.max(0, Math.min(1, v)) * 255);
      return (n < 16 ? '0' : '') + n.toString(16);
    };
    return '#' + f(c.r) + f(c.g) + f(c.b);
  }

  /* =====================================================================
     启动
     ===================================================================== */

  /* 先导出调试入口，保证即使初始化异常，控制台仍能访问 PdfTool */
  global.PdfTool = {
    state: state,
    gotoPage: gotoPage,
    setZoom: setZoom,
    toast: toast,
    renderPage: renderPage,
    renderThumbnails: renderThumbnails,
    loadFile: loadFile,
    init: init
  };

  function bootstrap() {
    try {
      init();
    } catch (err) {
      console.error('[PDF 工具箱] 初始化失败：', err);
      try {
        toast('初始化失败：' + (err && err.message ? err.message : err), 'error', 8000);
        setStatus('初始化失败', 'err');
      } catch (e) { /* 忽略 */ }
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bootstrap);
  } else {
    bootstrap();
  }

})(window);
