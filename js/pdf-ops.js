/* ==========================================================================
   pdf-ops.js — PDF 操作模块
   基于 pdf-lib 封装所有 PDF 文档 / 页面级操作。
   本模块只负责"数据"，不直接接触 DOM（压缩时的离屏 canvas 除外）。
   所有函数均通过 window.PdfOps 暴露。
   ========================================================================== */
(function (global) {
  'use strict';

  /* ---------------------------------------------------------------------
     常量：预设页面尺寸（单位：pt，1pt = 1/72 inch）
     --------------------------------------------------------------------- */
  var PAGE_SIZES = {
    A4:     [595.28, 841.89],
    A3:     [841.89, 1190.55],
    A5:     [419.53, 595.28],
    B5:     [498.90, 708.66],
    Letter: [612.00, 792.00],
    Legal:  [612.00, 1008.00],
    Tabloid:[792.00, 1224.00]
  };

  /* 单位换算系数：1 单位 = N pt */
  var UNIT_TO_PT = {
    pt: 1,
    mm: 72 / 25.4,   // 2.8346457
    cm: 72 / 2.54,   // 28.346457
    in: 72
  };

  /* 懒加载的 pdf-lib 命名空间 */
  function lib() {
    if (!global.PDFLib) {
      throw new Error('pdf-lib 尚未加载完成，请检查网络或刷新页面');
    }
    return global.PDFLib;
  }

  /* ---------------------------------------------------------------------
     工具函数
     --------------------------------------------------------------------- */

  /** 单位换算 → pt */
  function toPt(value, unit) {
    var f = UNIT_TO_PT[unit] || 1;
    return Number(value) * f;
  }

  /** pt → 指定单位 */
  function fromPt(value, unit) {
    var f = UNIT_TO_PT[unit] || 1;
    return Number(value) / f;
  }

  /** 格式化字节数 */
  function formatBytes(bytes) {
    if (bytes === null || bytes === undefined || isNaN(bytes)) return '—';
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    if (bytes < 1024 * 1024 * 1024) return (bytes / 1024 / 1024).toFixed(2) + ' MB';
    return (bytes / 1024 / 1024 / 1024).toFixed(2) + ' GB';
  }

  /** 把 PDF 页尺寸描述成人类可读文本（自动识别常见规格） */
  function describeSize(w, h) {
    var w1 = Math.round(w), h1 = Math.round(h);
    var w2 = Math.round(Math.min(w, h)), h2 = Math.round(Math.max(w, h));
    var names = Object.keys(PAGE_SIZES);
    for (var i = 0; i < names.length; i++) {
      var s = PAGE_SIZES[names[i]];
      if (Math.abs(s[0] - w2) <= 2 && Math.abs(s[1] - h2) <= 2) {
        return names[i] + (w > h ? ' 横向' : ' 纵向') + ' · ' + w1 + '×' + h1 + ' pt';
      }
    }
    return w1 + ' × ' + h1 + ' pt';
  }

  /**
   * 解析页码范围字符串，返回 0 基索引数组（升序、去重）
   * 支持："1-3, 5, 7-10"、"all"、"1,2,3"、"3-"（到末页）、"1-3/step"
   * @param {string} str 范围字符串
   * @param {number} max 最大页数（1 基）
   * @returns {number[]} 0 基索引
   */
  function parsePageRanges(str, max) {
    var out = [];
    var seen = {};
    var s = String(str == null ? '' : str).trim();
    if (!s) return out;
    if (/^(all|\*|全部)$/i.test(s)) {
      for (var k = 0; k < max; k++) out.push(k);
      return out;
    }
    s.split(/[,，;；\s]+/).forEach(function (part) {
      if (!part) return;
      var step = 1;
      var stepSplit = part.split('/');
      if (stepSplit.length === 2) {
        part = stepSplit[0];
        var st = parseInt(stepSplit[1], 10);
        if (st > 0) step = st;
      }
      var m = part.match(/^(\d+)\s*[-~—]\s*(\d*)$/);
      if (m) {
        var a = parseInt(m[1], 10);
        var b = m[2] === '' ? max : parseInt(m[2], 10);
        if (a > b) { var t = a; a = b; b = t; }
        for (var i = a; i <= b; i += step) {
          var idx = i - 1;
          if (idx >= 0 && idx < max && !seen[idx]) { seen[idx] = 1; out.push(idx); }
        }
        return;
      }
      var n = parseInt(part, 10);
      if (!isNaN(n)) {
        var ix = n - 1;
        if (ix >= 0 && ix < max && !seen[ix]) { seen[ix] = 1; out.push(ix); }
      }
    });
    out.sort(function (a, b) { return a - b; });
    return out;
  }

  /** 把 0 基索引数组压缩成范围字符串，如 [0,1,2,4] → "1-3, 5" */
  function formatPageRanges(indices) {
    if (!indices || !indices.length) return '';
    var sorted = indices.slice().sort(function (a, b) { return a - b; });
    var parts = [], start = sorted[0], prev = sorted[0];
    for (var i = 1; i <= sorted.length; i++) {
      var cur = sorted[i];
      if (cur === prev + 1) { prev = cur; continue; }
      parts.push(start === prev ? String(start + 1) : (start + 1) + '-' + (prev + 1));
      start = prev = cur;
    }
    return parts.join(', ');
  }

  /** 读取文件为 ArrayBuffer（Promise 包装） */
  function readAsArrayBuffer(file) {
    return new Promise(function (resolve, reject) {
      var fr = new FileReader();
      fr.onload = function () { resolve(fr.result); };
      fr.onerror = function () { reject(new Error('读取文件失败：' + file.name)); };
      fr.readAsArrayBuffer(file);
    });
  }

  /** 读取文件为 DataURL */
  function readAsDataURL(file) {
    return new Promise(function (resolve, reject) {
      var fr = new FileReader();
      fr.onload = function () { resolve(fr.result); };
      fr.onerror = function () { reject(new Error('读取文件失败：' + file.name)); };
      fr.readAsDataURL(file);
    });
  }

  /** 归一化索引数组：过滤越界、去重、升序 */
  function normalizeIndices(indices, pageCount) {
    var seen = {}, out = [];
    (indices || []).forEach(function (i) {
      i = i | 0;
      if (i >= 0 && i < pageCount && !seen[i]) { seen[i] = 1; out.push(i); }
    });
    out.sort(function (a, b) { return a - b; });
    return out;
  }

  /* ---------------------------------------------------------------------
     文档加载 / 保存
     --------------------------------------------------------------------- */

  /**
   * 从 ArrayBuffer 加载 pdf-lib 文档
   * @param {ArrayBuffer|Uint8Array} data
   * @returns {Promise<PDFDocument>}
   */
  function loadDocument(data) {
    var L = lib();
    var bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
    // 快速校验文件头，给出更友好的错误
    var head = String.fromCharCode.apply(null, bytes.subarray(0, 5));
    if (head !== '%PDF-') {
      return Promise.reject(new Error('该文件不是有效的 PDF（缺少 %PDF- 文件头）'));
    }
    return L.PDFDocument.load(bytes, {
      ignoreEncryption: true,
      updateMetadata: false,
      throwOnInvalidObject: false
    }).catch(function (err) {
      if (/encrypt/i.test(String(err && err.message))) {
        throw new Error('该 PDF 已加密，暂不支持处理受密码保护的文件');
      }
      throw new Error('解析 PDF 失败：' + (err && err.message ? err.message : err));
    });
  }

  /**
   * 序列化文档为 Uint8Array
   *
   * 重要：pdf-lib 的 save() 会「冻结」页面内容流——同一个 PDFDocument 实例
   * 在 save() 之后再 drawText / drawImage，新内容不会出现在下一次输出中
   * （内容流对象被复用且不再重写）。因此本工具的统一约定是：
   *   任何修改 → saveDocument() → 用返回的字节重新 loadDocument()
   * 上层 app.js 的 commitAndRefresh() 即遵循该约定。
   *
   * 为兼容"只想拿字节、后续还要继续编辑同一实例"的场景，提供
   * opts.preserveEditable = true：此时会先复制文档再保存，
   * 原实例保持可编辑状态。
   *
   * @param {PDFDocument} doc
   * @param {object} [opts] { useObjectStreams, preserveEditable }
   * @returns {Promise<Uint8Array>}
   */
  function saveDocument(doc, opts) {
    opts = opts || {};

    var target = doc;
    if (opts.preserveEditable) {
      // 复制一份用于序列化，原实例不受影响（副本保留可编辑能力）
      return doc.copy().then(function (copy) {
        return doSave(copy, opts).then(function (bytes) {
          // 副本不标记原实例，调用方仍可继续编辑 doc
          return bytes;
        });
      });
    }
    return doSave(target, opts);
  }

  /** 实际执行序列化并标记状态 */
  function doSave(doc, opts) {
    return doc.save({
      useObjectStreams: opts.useObjectStreams !== false,
      addDefaultPage: false,
      updateFieldAppearances: false
    }).then(function (bytes) {
      // 标记该实例已保存（后续写入会被 checkWritable 拦截）
      doc.__savedAt = Date.now();
      // 子集化后字体对象已失效，清空缓存
      if (doc.__fontCache) doc.__fontCache = {};
      return bytes;
    });
  }

  /**
   * 保存并返回一个「可继续编辑」的新实例
   * 用于需要在保存后继续修改的场景，避免触发 pdf-lib 的内容流冻结问题。
   * @param {PDFDocument} doc
   * @param {object} [opts]
   * @returns {Promise<{doc: PDFDocument, bytes: Uint8Array}>}
   */
  function saveAndReload(doc, opts) {
    return saveDocument(doc, opts).then(function (bytes) {
      return loadDocument(bytes).then(function (fresh) {
        return { doc: fresh, bytes: bytes };
      });
    });
  }

  /** 创建空文档 */
  function createDocument() {
    return lib().PDFDocument.create();
  }

  /* ---------------------------------------------------------------------
     页面信息
     --------------------------------------------------------------------- */

  /**
   * 获取文档所有页面的几何信息
   * @returns {Array<{width,height,rotation,sizeText}>}
   */
  function getPageInfos(doc) {
    return doc.getPages().map(function (p) {
      var mb = p.getMediaBox();
      var rot = p.getRotation().angle || 0;
      return {
        width: mb.width,
        height: mb.height,
        rotation: ((rot % 360) + 360) % 360,
        sizeText: describeSize(mb.width, mb.height)
      };
    });
  }

  /* ---------------------------------------------------------------------
     1. 添加空白页
     --------------------------------------------------------------------- */

  /**
   * 在指定位置插入空白页
   * @param {PDFDocument} doc
   * @param {number} atIndex 插入位置（0 基，= 页数则追加到末尾）
   * @param {object} opts { preset:'A4'|'same'|..., orientation:'portrait'|'landscape', width, height, unit }
   * @returns {number} 实际插入位置
   */
  function insertBlankPage(doc, atIndex, opts) {
    var L = lib();
    opts = opts || {};
    var pages = doc.getPages();
    var idx = Math.max(0, Math.min(atIndex | 0, pages.length));

    var w, h;
    if (opts.preset === 'same' && pages.length) {
      // 与"参考页"（默认插入点前一页，否则第一页）相同
      var ref = pages[Math.max(0, idx - 1)] || pages[0];
      var mb = ref.getMediaBox();
      w = mb.width; h = mb.height;
    } else if (opts.preset && PAGE_SIZES[opts.preset]) {
      w = PAGE_SIZES[opts.preset][0];
      h = PAGE_SIZES[opts.preset][1];
    } else {
      var unit = opts.unit || 'pt';
      w = toPt(opts.width || 595.28, unit);
      h = toPt(opts.height || 841.89, unit);
    }

    // 方向处理
    if (opts.orientation === 'landscape' && h > w) { var t = w; w = h; h = t; }
    if (opts.orientation === 'portrait' && w > h) { var t2 = w; w = h; h = t2; }

    var page = doc.insertPage(idx, [w, h]);
    // 让新页的 MediaBox 从 0,0 开始，避免继承异常
    page.setMediaBox(0, 0, w, h);
    return idx;
  }

  /* ---------------------------------------------------------------------
     2. 删除页面
     --------------------------------------------------------------------- */

  /**
   * 删除指定页面
   * @param {PDFDocument} doc
   * @param {number[]} indices 0 基索引
   * @returns {number} 删除的页数
   */
  function deletePages(doc, indices) {
    var count = doc.getPageCount();
    var list = normalizeIndices(indices, count);
    if (list.length >= count) {
      throw new Error('不能删除全部页面，至少需要保留 1 页');
    }
    // 从后往前删除，避免索引位移
    for (var i = list.length - 1; i >= 0; i--) {
      doc.removePage(list[i]);
    }
    return list.length;
  }

  /* ---------------------------------------------------------------------
     3. 从文件导入页面
     --------------------------------------------------------------------- */

  /**
   * 从另一个 PDF 导入页面并插入到指定位置
   * @param {PDFDocument} doc 目标文档
   * @param {ArrayBuffer|Uint8Array} srcBytes 源 PDF
   * @param {number[]} srcIndices 源页面索引（0 基）
   * @param {number} atIndex 插入位置（0 基）
   * @returns {Promise<number>} 插入页数
   */
  function importPages(doc, srcBytes, srcIndices, atIndex) {
    return loadDocument(srcBytes).then(function (src) {
      var list = normalizeIndices(srcIndices, src.getPageCount());
      if (!list.length) throw new Error('未选择任何要导入的页面');
      return doc.copyPages(src, list).then(function (copied) {
        var idx = Math.max(0, Math.min(atIndex | 0, doc.getPageCount()));
        copied.forEach(function (p, k) {
          doc.insertPage(idx + k, p);
        });
        return copied.length;
      });
    });
  }

  /* ---------------------------------------------------------------------
     4. 复制 / 粘贴页面（页内复制）
     --------------------------------------------------------------------- */

  /**
   * 复制页面到指定位置（在原文档内复制一份）
   * @returns {Promise<number[]>} 新页面的索引
   */
  function duplicatePages(doc, indices, atIndex) {
    var count = doc.getPageCount();
    var list = normalizeIndices(indices, count);
    if (!list.length) throw new Error('未选择任何要复制的页面');
    return doc.copyPages(doc, list).then(function (copied) {
      var idx = Math.max(0, Math.min(atIndex | 0, doc.getPageCount()));
      var created = [];
      copied.forEach(function (p, k) {
        doc.insertPage(idx + k, p);
        created.push(idx + k);
      });
      return created;
    });
  }

  /* ---------------------------------------------------------------------
     5. 替换页面
     --------------------------------------------------------------------- */

  /**
   * 用源 PDF 的页面替换目标文档中的页面
   * @param {PDFDocument} doc
   * @param {ArrayBuffer|Uint8Array} srcBytes
   * @param {number} srcIndex 源页索引
   * @param {number[]} targetIndices 被替换的目标页索引
   * @returns {Promise<number>} 替换页数
   */
  function replacePages(doc, srcBytes, srcIndex, targetIndices) {
    return loadDocument(srcBytes).then(function (src) {
      var sIdx = Math.max(0, Math.min(srcIndex | 0, src.getPageCount() - 1));
      var targets = normalizeIndices(targetIndices, doc.getPageCount());
      if (!targets.length) throw new Error('未选择要替换的页面');

      // 每个目标页都需要一份**独立的**页面副本：
      // 同一个 PDFPage 对象被插入到多个位置会破坏页面树（共享引用），
      // 因此按目标数量重复复制同一源页。
      var plan = targets.map(function () { return sIdx; });
      return doc.copyPages(src, plan).then(function (copies) {
        // 逐个替换：先在该位置插入副本，再删除被顶到后一位的原页
        targets.forEach(function (t, i) {
          doc.insertPage(t, copies[i]);
          doc.removePage(t + 1);
        });
        return targets.length;
      });
    });
  }

  /* ---------------------------------------------------------------------
     6. 提取页面 → 新文档
     --------------------------------------------------------------------- */

  /**
   * 提取指定页面生成新文档
   * @returns {Promise<PDFDocument>}
   */
  function extractPages(doc, indices) {
    var list = normalizeIndices(indices, doc.getPageCount());
    if (!list.length) throw new Error('未选择任何要提取的页面');
    var L = lib();
    return L.PDFDocument.create().then(function (out) {
      // 注意：必须由「目标文档」调用 copyPages，
      // 否则复制出的页面仍归属于源文档，addPage 会抛 foreign page 错误
      return out.copyPages(doc, list).then(function (copied) {
        copied.forEach(function (p) { out.addPage(p); });
        copyMetadata(doc, out);
        return out;
      });
    });
  }

  /* ---------------------------------------------------------------------
     7/12. 分割 & 拆分
     --------------------------------------------------------------------- */

  /**
   * 按每 N 页拆分
   * @returns {Promise<Array<{name:string, bytes:Uint8Array, range:string}>>}
   */
  function splitEveryN(doc, n) {
    n = Math.max(1, n | 0);
    var total = doc.getPageCount();
    var groups = [];
    for (var i = 0; i < total; i += n) {
      var g = [];
      for (var j = i; j < Math.min(i + n, total); j++) g.push(j);
      groups.push(g);
    }
    return buildSplitParts(doc, groups);
  }

  /**
   * 按自定义范围拆分（每个范围生成一个文件）
   * @param {string} rangeText 形如 "1-3; 4-6; 7-10"（分号分组）
   * @returns {Promise<Array<{name:string, bytes:Uint8Array, range:string}>>}
   */
  function splitByRanges(doc, rangeText) {
    var total = doc.getPageCount();
    var groups = String(rangeText || '')
      .split(/[;；\n]+/)
      .map(function (s) { return s.trim(); })
      .filter(function (s) { return s.length > 0; })
      .map(function (s) { return parsePageRanges(s, total); })
      .filter(function (g) { return g.length > 0; });
    if (!groups.length) throw new Error('未解析到有效的页码范围，请使用如 1-3; 4-6 的格式');
    return buildSplitParts(doc, groups);
  }

  /** 按页组批量生成子文档 */
  function buildSplitParts(doc, groups) {
    var L = lib();
    var parts = [];
    return groups.reduce(function (chain, g) {
      return chain.then(function () {
        return L.PDFDocument.create().then(function (out) {
          return out.copyPages(doc, g).then(function (copied) {
            copied.forEach(function (p) { out.addPage(p); });
            copyMetadata(doc, out);
            return saveDocument(out).then(function (bytes) {
              parts.push({
                name: 'part_' + (parts.length + 1) + '_p' + (g[0] + 1) + '-' + (g[g.length - 1] + 1) + '.pdf',
                bytes: bytes,
                range: formatPageRanges(g),
                pages: g.length
              });
            });
          });
        });
      });
    }, Promise.resolve()).then(function () { return parts; });
  }

  /* ---------------------------------------------------------------------
     8. 页面拼接 / 重新排序
     --------------------------------------------------------------------- */

  /**
   * 按新的顺序重建文档
   * @param {PDFDocument} doc
   * @param {number[]} order 原始 0 基索引的新排列（可含重复、可缺省）
   * @returns {Promise<PDFDocument>}
   */
  function reorderPages(doc, order) {
    var total = doc.getPageCount();
    var list = (order || []).map(function (i) { return i | 0; })
      .filter(function (i) { return i >= 0 && i < total; });
    if (!list.length) throw new Error('新的页面顺序为空');
    var L = lib();
    return L.PDFDocument.create().then(function (out) {
      return out.copyPages(doc, list).then(function (copied) {
        copied.forEach(function (p) { out.addPage(p); });
        copyMetadata(doc, out);
        return out;
      });
    });
  }

  /* ---------------------------------------------------------------------
     9. 页面大小调整
     --------------------------------------------------------------------- */

  /**
   * 调整页面尺寸
   * @param {PDFDocument} doc
   * @param {number[]} indices 目标页
   * @param {object} opts { width, height, unit, mode:'scale'|'center'|'crop' }
   * @returns {number} 处理页数
   */
  function resizePages(doc, indices, opts) {
    opts = opts || {};
    var unit = opts.unit || 'pt';
    var newW = toPt(opts.width, unit);
    var newH = toPt(opts.height, unit);
    if (!(newW > 0) || !(newH > 0)) throw new Error('页面宽高必须大于 0');
    var list = normalizeIndices(indices, doc.getPageCount());
    if (!list.length) throw new Error('未选择任何页面');
    var pages = doc.getPages();

    list.forEach(function (i) {
      var page = pages[i];
      var mb = page.getMediaBox();
      var oldW = mb.width, oldH = mb.height;
      page.setSize(newW, newH);
      if (opts.mode === 'scale') {
        var s = Math.min(newW / oldW, newH / oldH);
        page.scaleContent(s, s);
        page.translateContent((newW - oldW * s) / 2, (newH - oldH * s) / 2);
      } else if (opts.mode === 'center') {
        page.translateContent((newW - oldW) / 2, (newH - oldH) / 2);
      }
      // mode === 'crop'：只改 MediaBox，内容保持原点
    });
    return list.length;
  }

  /* ---------------------------------------------------------------------
     10. 旋转页面
     --------------------------------------------------------------------- */

  /**
   * 旋转页面（累加）
   * @param {number} delta 角度增量，如 +90 / -90 / 180
   * @returns {number} 处理页数
   */
  function rotatePages(doc, indices, delta) {
    var list = normalizeIndices(indices, doc.getPageCount());
    if (!list.length) throw new Error('未选择任何页面');
    var pages = doc.getPages();
    list.forEach(function (i) {
      var page = pages[i];
      var cur = page.getRotation().angle || 0;
      var next = ((cur + delta) % 360 + 360) % 360;
      page.setRotation(lib().degrees(next));
    });
    return list.length;
  }

  /** 设置绝对旋转角度 */
  function setPageRotation(doc, index, angle) {
    var pages = doc.getPages();
    if (index < 0 || index >= pages.length) return false;
    pages[index].setRotation(lib().degrees(((angle % 360) + 360) % 360));
    return true;
  }

  /* ---------------------------------------------------------------------
     11. 合并多个 PDF
     --------------------------------------------------------------------- */

  /**
   * 合并多个 PDF 文件
   * @param {Array<{name:string, bytes:ArrayBuffer|Uint8Array}>} files 按目标顺序
   * @param {function} [onProgress] (done, total)
   * @returns {Promise<PDFDocument>}
   */
  function mergeDocuments(files, onProgress) {
    var L = lib();
    return L.PDFDocument.create().then(function (out) {
      var done = 0;
      return files.reduce(function (chain, f) {
        return chain.then(function () {
          return loadDocument(f.bytes).then(function (src) {
            var idxs = [];
            for (var i = 0; i < src.getPageCount(); i++) idxs.push(i);
            return out.copyPages(src, idxs).then(function (copied) {
              copied.forEach(function (p) { out.addPage(p); });
              done++;
              if (onProgress) onProgress(done, files.length, f.name);
            });
          });
        });
      }, Promise.resolve()).then(function () {
        out.setTitle('合并文档');
        out.setProducer('PDF 工具箱');
        return out;
      });
    });
  }

  /* ---------------------------------------------------------------------
     13. 压缩
     --------------------------------------------------------------------- */

  /**
   * 无损结构压缩：重新序列化并启用对象流 / 移除冗余
   * @returns {Promise<Uint8Array>}
   */
  function compressStructural(doc) {
    // 复用 saveDocument 以保证保存后字体缓存被正确清理
    return saveDocument(doc, { useObjectStreams: true });
  }

  /**
   * 有损压缩：将每页栅格化为 JPEG 后重建文档（对扫描件/图片型 PDF 效果显著）
   * @param {PDFDocumentProxy} pdfjsDoc pdf.js 文档对象
   * @param {'medium'|'high'} level
   * @param {function} [onProgress] (done, total)
   * @returns {Promise<Uint8Array>}
   */
  function compressRaster(pdfjsDoc, level, onProgress) {
    var L = lib();
    var cfg = level === 'high'
      ? { scale: 1.0, quality: 0.45 }
      : { scale: 1.5, quality: 0.72 };

    return L.PDFDocument.create().then(function (out) {
      var total = pdfjsDoc.numPages;
      var chain = Promise.resolve();

      for (var n = 1; n <= total; n++) {
        (function (pageNo) {
          chain = chain.then(function () {
            return pdfjsDoc.getPage(pageNo).then(function (page) {
              var vp = page.getViewport({ scale: cfg.scale });
              var canvas = document.createElement('canvas');
              canvas.width = Math.max(1, Math.floor(vp.width));
              canvas.height = Math.max(1, Math.floor(vp.height));
              var ctx = canvas.getContext('2d');
              ctx.fillStyle = '#ffffff';
              ctx.fillRect(0, 0, canvas.width, canvas.height);
              return page.render({ canvasContext: ctx, viewport: vp }).promise.then(function () {
                var dataUrl = canvas.toDataURL('image/jpeg', cfg.quality);
                var b64 = dataUrl.split(',')[1];
                var bin = atob(b64);
                var bytes = new Uint8Array(bin.length);
                for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);

                return out.embedJpg(bytes).then(function (img) {
                  // 页面尺寸使用 scale=1 的视口（单位即 pt），保留原始物理尺寸
                  var vp1 = page.getViewport({ scale: 1 });
                  var np = out.addPage([vp1.width, vp1.height]);
                  np.drawImage(img, { x: 0, y: 0, width: vp1.width, height: vp1.height });
                  if (onProgress) onProgress(pageNo, total);
                });
              });
            });
          });
        })(n);
      }

      return chain.then(function () {
        out.setTitle('压缩文档');
        out.setProducer('PDF 工具箱');
        return out.save({ useObjectStreams: true, addDefaultPage: false });
      });
    });
  }

  /* ---------------------------------------------------------------------
     14. 书签 / 目录（PDF Outline）
     --------------------------------------------------------------------- */

  /**
   * 为文档写入书签大纲（支持多级）
   * @param {PDFDocument} doc
   * @param {Array<{title:string, page:number, level:number}>} bookmarks
   *        page 为 1 基页码；level 为 1 或 2
   * @returns {number} 写入的书签数
   */
  function setBookmarks(doc, bookmarks) {
    var L = lib();
    var ctx = doc.context;
    var PDFDict = L.PDFDict, PDFName = L.PDFName, PDFArray = L.PDFArray;
    var PDFNumber = L.PDFNumber, PDFHexString = L.PDFHexString;
    var pages = doc.getPages();
    if (!pages.length) throw new Error('文档没有页面');

    // 把扁平列表整理成树
    var tree = [];
    var currentTop = null;
    (bookmarks || []).forEach(function (b) {
      var title = String(b.title == null ? '' : b.title).trim();
      if (!title) return;
      var node = { title: title, page: Math.max(1, b.page | 0), children: [] };
      if ((b.level | 0) >= 2 && currentTop) {
        currentTop.children.push(node);
      } else {
        tree.push(node);
        currentTop = node;
      }
    });
    if (!tree.length) throw new Error('请至少填写一个书签标题');

    // 统计后代数量（用于 /Count）
    function countAll(nodes) {
      var c = 0;
      nodes.forEach(function (n) { c += 1 + countAll(n.children); });
      return c;
    }

    var rootDict = PDFDict.withContext(ctx);
    rootDict.set(PDFName.of('Type'), PDFName.of('Outlines'));
    var rootRef = ctx.register(rootDict);

    function build(nodes, parentRef) {
      var created = nodes.map(function (n) {
        var d = PDFDict.withContext(ctx);
        var pi = Math.min(Math.max(0, n.page - 1), pages.length - 1);
        var dest = PDFArray.withContext(ctx);
        dest.push(pages[pi].ref);
        dest.push(PDFName.of('Fit'));
        // 使用 PDFHexString 以正确编码中文
        d.set(PDFName.of('Title'), PDFHexString.fromText(n.title));
        d.set(PDFName.of('Parent'), parentRef);
        d.set(PDFName.of('Dest'), dest);
        return { dict: d, node: n, ref: ctx.register(d) };
      });

      // 同级前后链接
      created.forEach(function (c, i) {
        if (i > 0) c.dict.set(PDFName.of('Prev'), created[i - 1].ref);
        if (i < created.length - 1) c.dict.set(PDFName.of('Next'), created[i + 1].ref);
      });

      // 递归处理子级
      created.forEach(function (c) {
        if (c.node.children.length) {
          var sub = build(c.node.children, c.ref);
          c.dict.set(PDFName.of('First'), sub.first);
          c.dict.set(PDFName.of('Last'), sub.last);
          c.dict.set(PDFName.of('Count'), PDFNumber.of(countAll(c.node.children)));
        }
      });

      return {
        first: created.length ? created[0].ref : null,
        last: created.length ? created[created.length - 1].ref : null
      };
    }

    var top = build(tree, rootRef);
    if (top.first) {
      rootDict.set(PDFName.of('First'), top.first);
      rootDict.set(PDFName.of('Last'), top.last);
      rootDict.set(PDFName.of('Count'), PDFNumber.of(countAll(tree)));
    }
    doc.catalog.set(PDFName.of('Outlines'), rootRef);
    return countAll(tree);
  }

  /** 读取已有书签（尽力而为，仅一层结构） */
  function getBookmarks(doc) {
    var L = lib();
    var PDFName = L.PDFName;
    var out = [];
    try {
      var outlinesRef = doc.catalog.get(PDFName.of('Outlines'));
      if (!outlinesRef) return out;
      var outlines = doc.context.lookup(outlinesRef);
      if (!outlines) return out;
      var pages = doc.getPages();
      var refToIndex = {};
      pages.forEach(function (p, i) { refToIndex[String(p.ref)] = i + 1; });

      function readLevel(dict, level, limit) {
        if (!dict || limit <= 0) return;
        var firstRef = dict.get(PDFName.of('First'));
        if (!firstRef) return;
        var curRef = firstRef;
        var guard = 0;
        while (curRef && guard++ < 500) {
          var item = doc.context.lookup(curRef);
          if (!item) break;
          var titleObj = item.get(PDFName.of('Title'));
          var title = titleObj ? safeDecodeTitle(titleObj) : '未命名';
          var destObj = item.get(PDFName.of('Dest'));
          var pageNo = 1;
          if (destObj) {
            var destArr = doc.context.lookup(destObj);
            if (destArr && destArr.get && destArr.get(0)) {
              var key = String(destArr.get(0));
              if (refToIndex[key]) pageNo = refToIndex[key];
            }
          }
          out.push({ title: title, page: pageNo, level: level });
          readLevel(item, level + 1, limit - 1);
          curRef = item.get(PDFName.of('Next'));
        }
      }
      readLevel(outlines, 1, 6);
    } catch (e) {
      /* 读取失败静默返回空 */
    }
    return out;
  }

  /** 安全解码书签标题 */
  function safeDecodeTitle(obj) {
    try {
      if (obj.decodeText) return obj.decodeText();
      if (obj.asString) return obj.asString();
    } catch (e) { /* ignore */ }
    try { return String(obj); } catch (e) { return '未命名'; }
  }

  /* ---------------------------------------------------------------------
     15. 页面内容编辑：文字
     --------------------------------------------------------------------- */

  /**
   * 标准字体：键名必须与 pdf-lib StandardFonts 枚举一致
   * 值仅用于界面展示
   */
  var STD_FONTS = {
    Helvetica:            'Helvetica',
    HelveticaBold:        'Helvetica Bold',
    HelveticaOblique:     'Helvetica Italic',
    TimesRoman:           'Times Roman',
    TimesRomanBold:       'Times Bold',
    TimesRomanItalic:     'Times Italic',
    Courier:              'Courier',
    CourierBold:          'Courier Bold',
    Symbol:               'Symbol',
    ZapfDingbats:         'ZapfDingbats'
  };

  /* CJK 字体缓存（懒加载） */
  var cjkFontCache = { bytes: null, promise: null };

  /**
   * 候选的 CJK 字体源（按顺序尝试）
   * 优先使用体积较小的 WOFF（fontkit 可直接解析），失败再回退到完整 TTF
   */
  var CJK_FONT_URLS = [
    'https://cdn.jsdelivr.net/npm/@fontsource/noto-sans-sc@5.0.18/files/noto-sans-sc-chinese-simplified-400-normal.woff',
    'https://cdn.jsdelivr.net/npm/@expo-google-fonts/noto-sans-sc@0.2.3/NotoSansSC_400Regular.ttf'
  ];

  /** 是否包含 WinAnsi 无法表示的字符 */
  function needsCJK(text) {
    for (var i = 0; i < text.length; i++) {
      if (text.charCodeAt(i) > 255) return true;
    }
    return false;
  }

  /**
   * 检查 fontkit 是否可用
   * 注意：pdf-lib 的 registerFontkit 是 **PDFDocument 的实例方法**，
   * 并非顶层导出（PDFLib.registerFontkit 在 UMD 构建中为 undefined）。
   */
  function fontkitAvailable() {
    var L = global.PDFLib;
    if (!L || !global.fontkit) return false;
    return !!(L.PDFDocument && L.PDFDocument.prototype &&
              typeof L.PDFDocument.prototype.registerFontkit === 'function');
  }

  /**
   * 为指定文档实例注册 fontkit（必须逐实例注册）
   * @param {PDFDocument} doc
   * @returns {boolean} 是否注册成功
   */
  function registerFontkitOn(doc) {
    if (doc.__fontkitRegistered) return true;
    if (!fontkitAvailable()) return false;
    try {
      doc.registerFontkit(global.fontkit);
      doc.__fontkitRegistered = true;
      return true;
    } catch (e) {
      return false;
    }
  }

  /** 兼容旧调用名（保留，供外部检查字体引擎可用性） */
  function ensureFontkit() {
    return fontkitAvailable();
  }

  /**
   * 预加载中文字体（供 UI 在用户输入中文时提前触发下载，减少等待）
   * @returns {Promise<void>}
   */
  function preloadCJKFont() {
    if (!fontkitAvailable()) {
      return Promise.reject(new Error('中文字体引擎未就绪'));
    }
    return loadCJKFont().then(function () { return undefined; });
  }

  /**
   * 懒加载 CJK 字体字节（带并发去重与失败重试）
   * 首次调用需从 CDN 下载约 1.5 MB 的字体文件，之后全程复用内存缓存。
   * @param {function} [onProgress] 接收 'loading' 阶段回调，便于 UI 提示
   */
  function loadCJKFont(onProgress) {
    if (cjkFontCache.bytes) return Promise.resolve(cjkFontCache.bytes);
    if (cjkFontCache.promise) return cjkFontCache.promise;

    if (typeof onProgress === 'function') onProgress();

    cjkFontCache.promise = (function () {
      var i = 0;
      function tryNext() {
        if (i >= CJK_FONT_URLS.length) {
          cjkFontCache.promise = null;   // 允许后续重试
          return Promise.reject(new Error(
            '中文字体下载失败，请检查网络连接后重试（或改用英文文字）'));
        }
        var url = CJK_FONT_URLS[i++];
        return fetch(url).then(function (r) {
          if (!r.ok) throw new Error('HTTP ' + r.status);
          return r.arrayBuffer();
        }).then(function (buf) {
          cjkFontCache.bytes = buf;
          return buf;
        }).catch(function () {
          return tryNext();
        });
      }
      return tryNext();
    })();

    return cjkFontCache.promise;
  }

  /**
   * 获取字体对象（同一文档内缓存，避免重复嵌入导致体积膨胀）
   * @param {PDFDocument} doc
   * @param {string} fontName 标准字体键名
   * @param {boolean} needCJK 是否需要中文字形
   * @param {function} [onFontLoading] 首次下载中文字体时的回调
   * @returns {Promise<PDFFont>}
   */
  function resolveFont(doc, fontName, needCJK, onFontLoading) {
    var L = lib();
    doc.__fontCache = doc.__fontCache || {};

    if (needCJK) {
      if (doc.__fontCache.__cjk) return Promise.resolve(doc.__fontCache.__cjk);
      // fontkit 必须注册到"当前这个文档实例"上
      if (!registerFontkitOn(doc)) {
        return Promise.reject(new Error(
          '中文字体引擎（fontkit）未就绪。请确认页面已联网并刷新后重试。'));
      }
      return loadCJKFont(onFontLoading).then(function (bytes) {
        return doc.embedFont(bytes, { subset: true });
      }).then(function (font) {
        doc.__fontCache.__cjk = font;
        return font;
      }).catch(function (err) {
        throw new Error('中文字体嵌入失败：' + (err && err.message ? err.message : err));
      });
    }

    var key = STD_FONTS[fontName] ? fontName : 'Helvetica';
    if (doc.__fontCache[key]) return Promise.resolve(doc.__fontCache[key]);
    return doc.embedFont(L.StandardFonts[key]).then(function (font) {
      doc.__fontCache[key] = font;
      return font;
    });
  }

  /**
   * 确保文档处于「可写入」状态
   *
   * pdf-lib 的 save() 会冻结页面内容流：同一实例在保存后继续 drawText /
   * drawImage，新内容不会出现在后续输出中（静默丢失）。这里提供两种应对：
   *   1) 传入 opts.reloadOnDirty = true 时，自动「保存→重新加载」得到干净实例
   *      （通过 opts.__onReloaded 回调把新实例交回调用方）；
   *   2) 否则直接报错，避免用户遇到"操作成功但内容没出现"。
   *
   * @param {PDFDocument} doc
   * @param {object} opts
   * @returns {Error|null}
   */
  function checkWritable(doc, opts) {
    if (!doc || !doc.__savedAt || doc.__allowDirtyWrite === true) return null;
    if (opts && opts.reloadOnDirty) return null;   // 由调用方负责重新加载
    return new Error(
      '当前文档已保存过，pdf-lib 不支持在保存后继续写入内容。' +
      '请先重新加载文档（PdfOps.saveAndReload）再添加文字或图片。');
  }

  /**
   * 在页面上绘制文字（支持多行、自动换行）
   * @param {PDFDocument} doc
   * @param {number} pageIndex 0 基
   * @param {string} text
   * @param {object} opts
   *   { x, y,          // 坐标（pt，pdf 坐标系：左下角为原点）
   *     size,          // 字号
   *     color: {r,g,b} // 0~1
   *     fontName,      // 标准字体键名
   *     opacity,       // 0~1
   *     rotate,        // 角度
   *     maxWidth,      // 自动换行宽度
   *     lineHeight,    // 行高倍数
   *     coordFromTop,  // true 表示 y 从页面顶部算起
   *     onFontLoading }// 首次下载中文字体时的回调
   * @returns {Promise<number>} 绘制的行数
   */
  function drawText(doc, pageIndex, text, opts) {
    var L = lib();
    opts = opts || {};
    var savedErr = checkWritable(doc, opts);
    if (savedErr) return Promise.reject(savedErr);
    var pages = doc.getPages();
    if (pageIndex < 0 || pageIndex >= pages.length) {
      return Promise.reject(new Error('页面索引超出范围'));
    }
    var page = pages[pageIndex];
    var mb = page.getMediaBox();
    var str = String(text == null ? '' : text);
    if (!str.trim()) return Promise.reject(new Error('文字内容不能为空'));

    var size = Number(opts.size) || 14;
    var fontName = opts.fontName || 'Helvetica';
    var needCJK = needsCJK(str);

    return resolveFont(doc, fontName, needCJK, opts.onFontLoading).then(function (font) {
      var col = opts.color || { r: 0, g: 0, b: 0 };
      var color = L.rgb(
        clamp01(col.r), clamp01(col.g), clamp01(col.b)
      );
      var lineH = size * (Number(opts.lineHeight) || 1.35);
      var maxW = Number(opts.maxWidth) || (mb.width - 2 * (Number(opts.x) || 0));

      // 按显式换行 + 宽度自动换行拆行
      var lines = [];
      str.replace(/\r\n/g, '\n').split('\n').forEach(function (para) {
        if (!para) { lines.push(''); return; }
        if (needCJK || font.widthOfTextAtSize(para, size) > maxW) {
          var buf = '';
          for (var i = 0; i < para.length; i++) {
            var ch = para[i];
            var test = buf + ch;
            var w;
            try { w = font.widthOfTextAtSize(test, size); }
            catch (e) { w = test.length * size * 0.5; }
            if (w > maxW && buf) { lines.push(buf); buf = ch; }
            else { buf = test; }
          }
          if (buf) lines.push(buf);
        } else {
          lines.push(para);
        }
      });

      var baseY = Number(opts.y);
      if (isNaN(baseY)) baseY = mb.height - size * 2;
      if (opts.coordFromTop) baseY = mb.height - baseY;

      var baseX = Number(opts.x) || 0;
      var rotDeg = Number(opts.rotate) || 0;
      var rad = rotDeg * Math.PI / 180;

      var drawOpts = {
        x: baseX,
        size: size,
        font: font,
        color: color,
        opacity: clamp01(opts.opacity == null ? 1 : opts.opacity)
      };
      if (rotDeg) drawOpts.rotate = L.degrees(rotDeg);

      lines.forEach(function (line, i) {
        if (!line) return;
        var o = {};
        for (var k in drawOpts) o[k] = drawOpts[k];
        // 计算第 i 行的锚点：
        // 未旋转时沿 y 轴向下偏移；旋转时把偏移量 (0, -d) 反向旋转到 PDF 坐标系，
        // 等价于"整段文字绕锚点旋转"，从而保证多行在旋转页面上仍然整齐。
        var d = i * lineH;
        if (rotDeg) {
          o.x = baseX + d * Math.sin(rad);
          o.y = baseY - d * Math.cos(rad);
        } else {
          o.y = baseY - d;
        }
        try {
          page.drawText(sanitize(line, needCJK), o);
        } catch (e) {
          throw new Error('文字绘制失败：' + (e && e.message ? e.message : e));
        }
      });
      return lines.length;
    });
  }

  /** 用标准字体时剔除 WinAnsi 不支持的字符 */
  function sanitize(text, needCJK) {
    if (needCJK) return text;
    return text.replace(/[^\x00-\xFF]/g, '?');
  }

  function clamp01(v) {
    v = Number(v);
    if (isNaN(v)) return 0;
    return Math.max(0, Math.min(1, v));
  }

  /* ---------------------------------------------------------------------
     16. 页面内容编辑：图片
     --------------------------------------------------------------------- */

  /** 通过魔术字节判断图片类型 */
  function detectImageType(bytes) {
    if (bytes.length >= 8 &&
        bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4E && bytes[3] === 0x47) {
      return 'png';
    }
    if (bytes.length >= 3 && bytes[0] === 0xFF && bytes[1] === 0xD8 && bytes[2] === 0xFF) {
      return 'jpg';
    }
    return null;
  }

  /**
   * 在页面插入图片
   * @param {PDFDocument} doc
   * @param {number} pageIndex
   * @param {ArrayBuffer|Uint8Array} imageBytes
   * @param {object} opts { x, y, width, height, opacity, rotate, coordFromTop }
   * @returns {Promise<{width:number,height:number}>}
   */
  function drawImage(doc, pageIndex, imageBytes, opts) {
    var L = lib();
    opts = opts || {};
    var savedErr = checkWritable(doc, opts);
    if (savedErr) return Promise.reject(savedErr);
    var pages = doc.getPages();
    if (pageIndex < 0 || pageIndex >= pages.length) {
      return Promise.reject(new Error('页面索引超出范围'));
    }
    var page = pages[pageIndex];
    var mb = page.getMediaBox();
    var bytes = imageBytes instanceof Uint8Array ? imageBytes : new Uint8Array(imageBytes);
    var type = detectImageType(bytes);
    if (!type) {
      return Promise.reject(new Error('不支持的图片格式，请使用 PNG 或 JPG'));
    }

    var embed = type === 'png' ? doc.embedPng(bytes) : doc.embedJpg(bytes);

    return embed.then(function (img) {
      var w = Number(opts.width) || img.width;
      var h = Number(opts.height) || img.height;
      var x = Number(opts.x);
      var y = Number(opts.y);
      if (isNaN(x)) x = (mb.width - w) / 2;
      if (isNaN(y)) y = (mb.height - h) / 2;
      if (opts.coordFromTop) y = mb.height - y - h;

      var o = {
        x: x, y: y, width: w, height: h,
        opacity: clamp01(opts.opacity == null ? 1 : opts.opacity)
      };
      if (opts.rotate) o.rotate = L.degrees(Number(opts.rotate) || 0);
      page.drawImage(img, o);
      return { width: w, height: h };
    });
  }

  /* ---------------------------------------------------------------------
     文档属性
     --------------------------------------------------------------------- */

  /** 复制源文档的元信息到目标文档 */
  function copyMetadata(src, dst) {
    try {
      var t = src.getTitle(); if (t) dst.setTitle(t);
      var a = src.getAuthor(); if (a) dst.setAuthor(a);
      var s = src.getSubject(); if (s) dst.setSubject(s);
      var k = src.getKeywords(); if (k) dst.setKeywords([k]);
      dst.setProducer('PDF 工具箱');
      dst.setModificationDate(new Date());
    } catch (e) { /* 元信息读取失败可忽略 */ }
  }

  /**
   * 设置文档元信息
   * @param {object} meta { title, author, subject, keywords, creator }
   */
  function setMetadata(doc, meta) {
    meta = meta || {};
    if (meta.title != null) doc.setTitle(String(meta.title));
    if (meta.author != null) doc.setAuthor(String(meta.author));
    if (meta.subject != null) doc.setSubject(String(meta.subject));
    if (meta.keywords != null) {
      var kw = Array.isArray(meta.keywords)
        ? meta.keywords
        : String(meta.keywords).split(/[,，;；]/).map(function (s) { return s.trim(); }).filter(Boolean);
      doc.setKeywords(kw);
    }
    if (meta.creator != null) doc.setCreator(String(meta.creator));
    doc.setProducer('PDF 工具箱');
    doc.setModificationDate(new Date());
  }

  /** 读取文档元信息 */
  function getMetadata(doc) {
    var out = { title: '', author: '', subject: '', keywords: '', pageCount: 0 };
    try {
      out.title = doc.getTitle() || '';
      out.author = doc.getAuthor() || '';
      out.subject = doc.getSubject() || '';
      out.keywords = doc.getKeywords() || '';
    } catch (e) { /* ignore */ }
    try { out.pageCount = doc.getPageCount(); } catch (e) { out.pageCount = 0; }
    return out;
  }

  /* ---------------------------------------------------------------------
     导出
     --------------------------------------------------------------------- */
  global.PdfOps = {
    /* 常量 */
    PAGE_SIZES: PAGE_SIZES,
    UNIT_TO_PT: UNIT_TO_PT,
    STD_FONTS: STD_FONTS,

    /* 工具 */
    toPt: toPt,
    fromPt: fromPt,
    formatBytes: formatBytes,
    describeSize: describeSize,
    parsePageRanges: parsePageRanges,
    formatPageRanges: formatPageRanges,
    readAsArrayBuffer: readAsArrayBuffer,
    readAsDataURL: readAsDataURL,
    normalizeIndices: normalizeIndices,
    detectImageType: detectImageType,

    /* 文档 */
    loadDocument: loadDocument,
    saveDocument: saveDocument,
    saveAndReload: saveAndReload,
    createDocument: createDocument,
    getPageInfos: getPageInfos,
    getMetadata: getMetadata,
    setMetadata: setMetadata,
    copyMetadata: copyMetadata,

    /* 页面操作 */
    insertBlankPage: insertBlankPage,
    deletePages: deletePages,
    importPages: importPages,
    duplicatePages: duplicatePages,
    replacePages: replacePages,
    extractPages: extractPages,
    splitEveryN: splitEveryN,
    splitByRanges: splitByRanges,
    reorderPages: reorderPages,
    resizePages: resizePages,
    rotatePages: rotatePages,
    setPageRotation: setPageRotation,
    mergeDocuments: mergeDocuments,

    /* 压缩 */
    compressStructural: compressStructural,
    compressRaster: compressRaster,

    /* 书签 */
    setBookmarks: setBookmarks,
    getBookmarks: getBookmarks,

    /* 内容编辑 */
    drawText: drawText,
    drawImage: drawImage,
    needsCJK: needsCJK,
    ensureFontkit: ensureFontkit,
    preloadCJKFont: preloadCJKFont
  };

})(window);
