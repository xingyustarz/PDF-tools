/* ==========================================================================
   converters.js — 转换模块（可编辑结构重建版）
   设计原则：
   PDF 内部只有带坐标的字符流，没有"段落 / 表格 / 样式"概念。
   本模块用几何信息（字号、x/y 坐标、行间隙）推断文档结构，
   重建为真正可编辑的 Office 内容：
   - Word：标题层级（字号分级）、真正的 Table 对象（列锚点一致性检测）、
     列表识别、对齐推断、段落智能合并、粗体检测
   - PPT：标题 + 正文 textbox 结构，字号层级映射
   - Excel：坐标聚类推断行列（本身就是可编辑单元格）
   另保留「版式还原（图片）」模式作为备选——视觉一致但不可编辑。
   所有函数通过 window.Converters 暴露。
   ========================================================================== */
(function (global) {
  'use strict';

  /* 依赖懒检查 */
  function need(name, obj) {
    if (!obj) throw new Error(name + ' 库未加载完成，请检查网络后刷新页面');
    return obj;
  }

  /* ---------------------------------------------------------------------
     文本抽取核心
     --------------------------------------------------------------------- */

  /**
   * 从 pdf.js 页面提取文本，并按几何位置重建为"行"
   * @param {PDFPageProxy} page
   * @returns {Promise<Array<{text,x,y,w,h,fontSize,bold,parts[]}>>}
   *          y 为从页面顶部计算的 pt 值
   */
  function extractLines(page) {
    return page.getTextContent({ normalizeWhitespace: false, disableCombineTextItems: false })
      .then(function (content) {
        var items = content.items || [];
        var raw = [];

        items.forEach(function (it) {
          var str = it.str;
          if (str == null) return;
          if (!str.trim() && !/^\s+$/.test(str)) return;
          if (!str.length) return;
          var tr = it.transform || [1, 0, 0, 1, 0, 0];
          var fontSize = Math.abs(tr[3]) || Math.abs(tr[0]) || it.height || 10;
          var fontName = it.fontName || '';
          raw.push({
            text: str,
            x: tr[4],
            y: tr[5],                    // pdf 坐标（自底向上）
            width: it.width || 0,
            height: it.height || fontSize,
            fontSize: fontSize,
            fontName: fontName,
            bold: /bold|black|heavy|semibold/i.test(fontName)
          });
        });

        if (!raw.length) return [];

        // 按 y 坐标聚类成行（容差取平均字号的 60%）
        var avgFont = raw.reduce(function (s, r) { return s + r.fontSize; }, 0) / raw.length;
        var tol = Math.max(2, avgFont * 0.6);

        raw.sort(function (a, b) {
          if (Math.abs(b.y - a.y) > tol) return b.y - a.y;  // y 大者在上
          return a.x - b.x;
        });

        var lines = [];
        raw.forEach(function (r) {
          var last = lines[lines.length - 1];
          if (last && Math.abs(last.y - r.y) <= tol) {
            last.parts.push(r);
            last.y = (last.y * (last.parts.length - 1) + r.y) / last.parts.length;
          } else {
            lines.push({ y: r.y, parts: [r] });
          }
        });

        // 生成行文本：同行的片段按 x 排序，间隙大于阈值时插入空格
        return lines.map(function (ln) {
          ln.parts.sort(function (a, b) { return a.x - b.x; });
          var text = '';
          var prev = null;
          var minX = Infinity, maxX = -Infinity, maxH = 0, maxFont = 0, anyBold = false;
          ln.parts.forEach(function (p) {
            if (prev) {
              var gap = p.x - (prev.x + prev.width);
              if (gap > Math.max(1.2, prev.fontSize * 0.25) && !/\s$/.test(text)) text += ' ';
            }
            text += p.text;
            minX = Math.min(minX, p.x);
            maxX = Math.max(maxX, p.x + p.width);
            maxH = Math.max(maxH, p.height);
            maxFont = Math.max(maxFont, p.fontSize);
            if (p.bold) anyBold = true;
            prev = p;
          });
          return {
            text: text.replace(/\s+$/, ''),
            x: minX,
            y: ln.y,
            w: maxX - minX,
            h: maxH,
            fontSize: maxFont,
            bold: anyBold,
            parts: ln.parts.map(function (p) {
              return { text: p.text, x: p.x, w: p.width };
            })
          };
        }).filter(function (l) { return l.text.length > 0; });
      });
  }

  /**
   * 提取整份文档的文本结构
   * @returns {Promise<Array<{page,width,height,lines[]}>>}
   */
  function extractDocument(pdfjsDoc, onProgress) {
    var pages = [];
    var chain = Promise.resolve();
    for (var n = 1; n <= pdfjsDoc.numPages; n++) {
      (function (pageNo) {
        chain = chain.then(function () {
          return pdfjsDoc.getPage(pageNo).then(function (page) {
            var vp = page.getViewport({ scale: 1 });
            return extractLines(page).then(function (lines) {
              pages.push({
                page: pageNo,
                width: vp.width,
                height: vp.height,
                lines: lines
              });
              if (onProgress) onProgress(pageNo, pdfjsDoc.numPages);
            });
          });
        });
      })(n);
    }
    return chain.then(function () {
      pages.sort(function (a, b) { return a.page - b.page; });
      return pages;
    });
  }

  /* ---------------------------------------------------------------------
     结构推断工具
     --------------------------------------------------------------------- */

  /** 把一行按间隙切成单元格候选 */
  function splitRowIntoCells(l) {
    var segs = (l.parts && l.parts.length)
      ? l.parts.map(function (p) { return { text: p.text, x: p.x, w: p.width }; })
      : [{ text: l.text, x: l.x, w: l.w }];
    var cells = [];
    var cur = null;
    segs.forEach(function (s) {
      if (!s.text || !s.text.trim()) return;
      var gap = cur ? (s.x - (cur.x + cur.w)) : 0;
      // 间隙超过约 1.5 个字符宽度 → 新单元格
      if (!cur || gap > Math.max(3, l.fontSize * 0.45)) {
        cur = { text: s.text, x: s.x, w: s.w || 0 };
        cells.push(cur);
      } else {
        cur.text += s.text;
        cur.w = (s.x + (s.w || 0)) - cur.x;
      }
    });
    return cells.filter(function (c) { return c.text.trim().length > 0; });
  }

  /** 列表前缀检测（• 符号 / 数字编号 / 汉字编号） */
  var LIST_RE = /^\s*(?:[•·▪◦●○◆■□*]\s+|\d+\s*[.、)]\s*|[一二三四五六七八十]+\s*[、.]\s*|\(\d+\)\s*|[（(]\d+[)）]\s*|[a-z]\s*[.)]\s+)/i;
  function isListLine(l) { return LIST_RE.test(l.text); }

  /** 行尾标点（用于判断段落是否结束） */
  var SENT_END_RE = /[。！？；：…\s,.!?;:]$/;

  /** 对齐方式推断 */
  function detectAlignment(l, pageWidth) {
    var center = l.x + l.w / 2;
    if (Math.abs(center - pageWidth / 2) < Math.max(8, pageWidth * 0.025)) return 'center';
    if (l.x + l.w > pageWidth * 0.9) return 'right';
    return 'left';
  }

  /** 判断一行是否像表格行（多个单元格且横向跨度足够） */
  function isTableLikeRow(l, cells, pageWidth) {
    return cells.length >= 2 && (l.x + l.w - l.x) > pageWidth * 0.22 && l.w > pageWidth * 0.22;
  }

  /* ---------------------------------------------------------------------
     Word 可编辑内容构建（核心）
     输入：页面的行数组
     输出：docx children（段落 + 真正的 Table 对象）
     --------------------------------------------------------------------- */
  function buildEditableContent(docx, lines, pageWidth) {
    if (!lines.length) {
      return [new docx.Paragraph({
        spacing: { after: 160 },
        children: [new docx.TextRun({
          text: '（本页无可提取的文字内容，可能为图片或扫描件）',
          italics: true, size: 20, color: 'AAAAAA', font: '微软雅黑'
        })]
      })];
    }

    /* 1. 预处理：每行切单元格 + 标记表格行 */
    var rows = lines.map(function (l) {
      var cells = splitRowIntoCells(l);
      return {
        line: l,
        cells: cells,
        tableRow: isTableLikeRow(l, cells, pageWidth)
      };
    });

    /* 2. 连续表格行分组（>= 2 行才构成表格，单行按普通段落处理） */
    var children = [];
    var i = 0;
    while (i < rows.length) {
      if (rows[i].tableRow) {
        var j = i;
        while (j < rows.length && rows[j].tableRow) j++;
        var groupLen = j - i;
        if (groupLen >= 2) {
          children.push(buildTable(docx, rows.slice(i, j), pageWidth));
          i = j;
          continue;
        }
      }
      // 普通行：进入段落构建
      var paraRows = [];
      while (i < rows.length && !rows[i].tableRow) { paraRows.push(rows[i]); i++; }
      // 单个表格行落在普通区间里，也当普通行处理
      if (paraRows.length === 0 && i < rows.length) { paraRows.push(rows[i]); i++; }
      children.push.apply(children, buildParagraphs(docx, paraRows, pageWidth));
    }

    // 首尾空段清理由 docx 自然处理
    return children;
  }

  /** 把一组普通行构建为段落（标题 / 列表 / 对齐 / 智能合并） */
  function buildParagraphs(docx, rows, pageWidth) {
    var children = [];

    // 字号统计：用于标题分级
    var sizes = {};
    rows.forEach(function (r) { sizes[Math.round(r.line.fontSize)] = true; });
    var uniq = Object.keys(sizes).map(Number).sort(function (a, b) { return b - a; });
    var bodySize = uniq.length ? uniq[uniq.length - 1] : 10;
    var maxSize = uniq.length ? uniq[0] : 10;
    var h1Thresh = Math.max(maxSize * 0.95, bodySize * 1.5);
    var h2Thresh = Math.max(bodySize * 1.25, maxSize * 0.8);

    var buf = null;  // { lines: [], ... }

    function flush() {
      if (!buf) return;
      var l = buf.lines[0];
      var size = Math.round(buf.avgSize);
      var isH1 = size >= h1Thresh && uniq.length > 1;
      var isH2 = !isH1 && size >= h2Thresh && uniq.length > 2;
      var align = detectAlignment(l, pageWidth);
      var listish = isListLine(l);
      var indent = Math.max(0, Math.round((l.x - 56.7) * 20));
      if (listish) indent = Math.max(indent, 360);

      var opts = {
        spacing: isH1 ? { before: 240, after: 120, line: 300 }
              : isH2 ? { before: 180, after: 100, line: 280 }
              : { after: 80, line: 280 },
        alignment: align === 'center' ? docx.AlignmentType.CENTER
                : align === 'right' ? docx.AlignmentType.RIGHT : undefined,
        indent: indent > 6 ? { left: indent, firstLine: listish ? undefined : (align === 'center' ? undefined : Math.min(indent, 420)) } : undefined
      };

      children.push(new docx.Paragraph(Object.assign(opts, {
        children: [new docx.TextRun({
          text: buf.lines.map(function (x) { return x.text; }).join(''),
          size: Math.max(18, Math.min(44, size * 2)),  // 半磅
          bold: buf.bold || isH1 || isH2,
          font: '宋体'
        })]
      })));
      buf = null;
    }

    rows.forEach(function (r) {
      var l = r.line;
      if (buf) {
        // 合并条件：垂直间距紧凑、左边界一致、字号一致、上行未结束句子、均非列表行
        var gap = Math.abs(buf.lastY - l.y);
        var lineH = Math.max(buf.avgSize, l.fontSize) * 1.2;
        var canMerge = gap < lineH
          && Math.abs(buf.lastX - l.x) < 3
          && Math.abs(buf.avgSize - l.fontSize) < 0.6
          && !SENT_END_RE.test(buf.lines[buf.lines.length - 1].text)
          && !isListLine(l)
          && !isListLine(buf.lines[0])
          && buf.lines.length < 6;
        if (canMerge) {
          buf.lines.push(l);
          buf.lastY = l.y;
          buf.lastX = l.x;
          buf.avgSize = (buf.avgSize * (buf.lines.length - 1) + l.fontSize) / buf.lines.length;
          buf.bold = buf.bold && l.bold;
          return;
        }
        flush();
      }
      buf = {
        lines: [l],
        lastY: l.y,
        lastX: l.x,
        avgSize: l.fontSize,
        bold: l.bold
      };
    });
    flush();
    return children;
  }

  /** 把一组表格行构建为真正的 docx.Table */
  function buildTable(docx, tableRows, pageWidth) {
    // 列锚点：收集所有单元格 x，聚类
    var xs = [];
    tableRows.forEach(function (r) {
      r.cells.forEach(function (c) { xs.push(c.x); });
    });
    xs.sort(function (a, b) { return a - b; });
    var avgFont = tableRows.reduce(function (s, r) { return s + r.line.fontSize; }, 0) / tableRows.length;
    var colTol = Math.max(8, avgFont * 0.7);
    var anchors = [];
    xs.forEach(function (x) {
      var last = anchors[anchors.length - 1];
      if (last === undefined || x - last > colTol) anchors.push(x);
    });
    // 限制列数
    var maxCols = 20;
    if (anchors.length > maxCols) {
      var step = anchors.length / maxCols;
      var reduced = [];
      for (var k = 0; k < maxCols; k++) reduced.push(anchors[Math.floor(k * step)]);
      anchors = reduced;
    }

    var colW = Math.floor(9000 / anchors.length);  // 总宽 9000 dxa 近似均分

    var tableRowsData = tableRows.map(function (r) {
      var rowCells = new Array(anchors.length).fill(null);
      r.cells.forEach(function (c) {
        var ci = nearestAnchor(c.x, anchors);
        var idx = ci;
        // 向右找第一个空位，避免同列多个单元格互相覆盖
        while (idx < anchors.length && rowCells[idx]) idx++;
        if (idx >= anchors.length) idx = ci;
        rowCells[idx] = c.text.trim();
      });
      return rowCells.map(function (t) { return t == null ? '' : t; });
    });

    // 表头检测：首行全部非空且短文本 → 加粗
    var firstRow = tableRowsData[0] || [];
    var headerish = firstRow.length > 0
      && firstRow.every(function (c) { return c.length > 0 && c.length <= 20; })
      && tableRowsData.length > 1;

    var rows = tableRowsData.map(function (cells, ri) {
      return new docx.TableRow({
        tableHeader: headerish && ri === 0,
        children: cells.map(function (txt) {
          return new docx.TableCell({
            width: { size: colW, type: docx.WidthType.DXA },
            margins: { top: 40, bottom: 40, left: 80, right: 80 },
            children: [new docx.Paragraph({
              spacing: { after: 0, line: 240 },
              children: [new docx.TextRun({
                text: txt,
                size: 18,  // 9pt，表格内小字
                bold: headerish && ri === 0,
                font: '宋体'
              })]
            })]
          });
        })
      });
    });

    return new docx.Table({
      width: { size: 100, type: docx.WidthType.PERCENTAGE },
      borders: {
        top: { style: docx.BorderStyle.SINGLE, size: 4, color: '999999' },
        bottom: { style: docx.BorderStyle.SINGLE, size: 4, color: '999999' },
        left: { style: docx.BorderStyle.SINGLE, size: 4, color: '999999' },
        right: { style: docx.BorderStyle.SINGLE, size: 4, color: '999999' },
        insideHorizontal: { style: docx.BorderStyle.SINGLE, size: 2, color: 'BBBBBB' },
        insideVertical: { style: docx.BorderStyle.SINGLE, size: 2, color: 'BBBBBB' }
      },
      rows: rows
    });
  }

  function nearestAnchor(x, anchors) {
    var best = 0, bestD = Infinity;
    for (var i = 0; i < anchors.length; i++) {
      var d = Math.abs(anchors[i] - x);
      if (d < bestD) { bestD = d; best = i; }
    }
    return best;
  }

  /* ---------------------------------------------------------------------
     页面渲染为图片（版式还原备选模式 / 打印用）
     --------------------------------------------------------------------- */
  function renderPageDataUrl(pdfjsDoc, pageNo, scale) {
    return pdfjsDoc.getPage(pageNo).then(function (page) {
      var s = scale || 2;
      var vp = page.getViewport({ scale: s });
      var maxSide = 3000;
      if (Math.max(vp.width, vp.height) > maxSide) {
        var k = maxSide / Math.max(vp.width, vp.height);
        vp = page.getViewport({ scale: s * k });
      }
      var canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.floor(vp.width));
      canvas.height = Math.max(1, Math.floor(vp.height));
      var ctx = canvas.getContext('2d');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      return page.render({ canvasContext: ctx, viewport: vp }).promise.then(function () {
        return canvas.toDataURL('image/png');
      });
    });
  }

  function renderPageBlob(pdfjsDoc, pageNo, scale) {
    return renderPageDataUrl(pdfjsDoc, pageNo, scale).then(function (dataUrl) {
      var b64 = dataUrl.split(',')[1];
      var bin = atob(b64);
      var bytes = new Uint8Array(bin.length);
      for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      return new Blob([bytes], { type: 'image/png' });
    });
  }

  /* ---------------------------------------------------------------------
     19. PDF → Word (.docx)
     模式：
     - edit  ：可编辑结构重建（默认）——标题 / 真正的表格 / 列表 / 对齐 / 段落
     - layout：版式还原图片模式（视觉一致，内容不可编辑）
     - both  ：图片 + 可编辑文字层
     --------------------------------------------------------------------- */
  function toWord(pdfjsDoc, opts, onProgress) {
    var docx = need('docx', global.docx);
    opts = opts || {};
    var mode = opts.mode || 'edit';
    var imageScale = Number(opts.imageScale) || 2;

    return extractDocument(pdfjsDoc, onProgress).then(function (pages) {
      var children = [];

      // 封面标题
      var docTitle = (opts.fileName || 'PDF 文档').replace(/\.pdf$/i, '');
      children.push(new docx.Paragraph({
        alignment: docx.AlignmentType.CENTER,
        spacing: { before: 1200, after: 200 },
        children: [new docx.TextRun({
          text: docTitle, bold: true, size: 44, font: '微软雅黑', color: '2B579A'
        })]
      }));
      children.push(new docx.Paragraph({
        alignment: docx.AlignmentType.CENTER,
        spacing: { after: 800 },
        children: [new docx.TextRun({
          text: '共 ' + pages.length + ' 页 · 由 PDF 工具箱转换（可编辑模式）',
          size: 20, color: '888888', font: '微软雅黑'
        })]
      }));

      var chain = Promise.resolve();

      // 图片层（layout / both 模式）
      if (mode === 'layout' || mode === 'both') {
        pages.forEach(function (pg) {
          chain = chain.then(function () {
            if (opts.includeHeadings !== false) {
              children.push(new docx.Paragraph({
                heading: docx.HeadingLevel.HEADING_1,
                spacing: { before: 360, after: 180 },
                border: { bottom: { color: '2B579A', style: docx.BorderStyle.SINGLE, size: 8, space: 4 } },
                children: [new docx.TextRun({
                  text: '第 ' + pg.page + ' 页', bold: true, size: 28, color: '2B579A', font: '微软雅黑'
                })]
              }));
            }
            return renderPageBlob(pdfjsDoc, pg.page, imageScale).then(function (blob) {
              return blob.arrayBuffer().then(function (buf) {
                var MAX_W_PX = 727, MAX_H_PX = 1041;  // A4 内容区（2cm 边距，96dpi）
                var k = Math.min(MAX_W_PX / pg.width, MAX_H_PX / pg.height);
                children.push(new docx.Paragraph({
                  alignment: docx.AlignmentType.CENTER,
                  spacing: { after: 200 },
                  children: [new docx.ImageRun({
                    data: buf,
                    transformation: { width: Math.round(pg.width * k), height: Math.round(pg.height * k) },
                    type: 'png'
                  })]
                }));
              });
            }).catch(function (err) {
              console.warn('页面图片渲染失败', err);
            });
          });
        });
      }

      // 可编辑文字层（edit / both 模式）
      if (mode === 'edit' || mode === 'both') {
        pages.forEach(function (pg) {
          if (mode === 'both') {
            children.push(new docx.Paragraph({
              spacing: { before: 200, after: 100 },
              children: [new docx.TextRun({
                text: '—— 第 ' + pg.page + ' 页文字内容 ——',
                size: 18, color: '999999', font: '微软雅黑', italics: true
              })]
            }));
          } else if (opts.includeHeadings !== false) {
            // edit 模式：每页标题
            children.push(new docx.Paragraph({
              heading: docx.HeadingLevel.HEADING_1,
              spacing: { before: 360, after: 180 },
              border: { bottom: { color: '2B579A', style: docx.BorderStyle.SINGLE, size: 8, space: 4 } },
              children: [new docx.TextRun({
                text: '第 ' + pg.page + ' 页', bold: true, size: 28, color: '2B579A', font: '微软雅黑'
              })]
            }));
          }
          var content = buildEditableContent(docx, pg.lines, pg.width);
          content.forEach(function (c) { children.push(c); });
          // 分页符
          if (opts.pageBreak !== false && pg.page !== pages.length) {
            children.push(new docx.Paragraph({ children: [new docx.PageBreak()] }));
          }
        });
      }

      return chain.then(function () {
        var doc = new docx.Document({
          creator: 'PDF 工具箱',
          title: docTitle,
          description: '由 PDF 工具箱转换生成',
          styles: { default: { document: { run: { font: '宋体', size: 22 } } } },
          sections: [{
            properties: {
              page: { margin: { top: 1134, right: 1134, bottom: 1134, left: 1134 } }
            },
            children: children
          }]
        });
        return docx.Packer.toBlob(doc);
      });
    });
  }

  /* ---------------------------------------------------------------------
     20. PDF → Excel (.xlsx)
     坐标聚类推断行列 —— 单元格本身即可编辑。
     --------------------------------------------------------------------- */
  function linesToTable(lines) {
    if (!lines.length) return [];

    var rows = lines.map(function (l) {
      var segs = (l.parts && l.parts.length)
        ? l.parts.map(function (p) { return { text: p.text, x: p.x }; })
        : [{ text: l.text, x: l.x }];
      return segs.map(function (s) {
        return { text: String(s.text == null ? '' : s.text).trim(), x: s.x };
      }).filter(function (s) { return s.text.length > 0; });
    });

    var xs = [];
    rows.forEach(function (r) { r.forEach(function (s) { xs.push(s.x); }); });
    if (!xs.length) return rows.map(function () { return []; });
    xs.sort(function (a, b) { return a - b; });

    var avgFont = lines.reduce(function (s, l) { return s + (l.fontSize || 10); }, 0) / lines.length;
    var colTol = Math.max(10, avgFont * 0.9);
    var anchors = [];
    xs.forEach(function (x) {
      var last = anchors[anchors.length - 1];
      if (last === undefined || x - last > colTol) anchors.push(x);
    });

    var maxCols = 50;
    if (anchors.length > maxCols) {
      var step = anchors.length / maxCols;
      var reduced = [];
      for (var i = 0; i < maxCols; i++) reduced.push(anchors[Math.floor(i * step)]);
      anchors = reduced;
    }

    var table = rows.map(function (segs) {
      var row = new Array(anchors.length).fill('');
      segs.forEach(function (s) {
        var ci = nearestAnchor(s.x, anchors);
        row[ci] = row[ci] ? (row[ci] + ' ' + s.text) : s.text;
      });
      return row;
    });

    // 去掉全空的尾列
    var lastCol = -1;
    table.forEach(function (r) {
      for (var c = r.length - 1; c >= 0; c--) {
        if (r[c]) { if (c > lastCol) lastCol = c; break; }
      }
    });
    if (lastCol >= 0 && lastCol < table[0].length - 1) {
      table = table.map(function (r) { return r.slice(0, lastCol + 1); });
    }
    return table;
  }

  function toExcel(pdfjsDoc, opts, onProgress) {
    var XLSX = need('xlsx', global.XLSX);
    opts = opts || {};

    return extractDocument(pdfjsDoc, onProgress).then(function (pages) {
      var wb = XLSX.utils.book_new();
      var mode = opts.mode || 'sheetPerPage';

      if (mode === 'single') {
        var all = [['页码', '行内容']];
        pages.forEach(function (pg) {
          pg.lines.forEach(function (l) {
            all.push([pg.page, l.text]);
          });
        });
        var ws = XLSX.utils.aoa_to_sheet(all);
        ws['!cols'] = [{ wch: 8 }, { wch: 100 }];
        XLSX.utils.book_append_sheet(wb, ws, '全部内容');
      } else {
        pages.forEach(function (pg) {
          var table = linesToTable(pg.lines);
          var aoa = [];
          aoa.push(['第 ' + pg.page + ' 页', '', '', '']);
          if (!table.length) {
            aoa.push(['（本页无可提取的文字内容）']);
          } else {
            table.forEach(function (row) {
              aoa.push(row.map(function (c) { return c == null ? '' : c; }));
            });
          }
          var sheet = XLSX.utils.aoa_to_sheet(aoa);
          var colCount = aoa.reduce(function (m, r) { return Math.max(m, r.length); }, 1);
          var cols = [];
          for (var c = 0; c < colCount; c++) {
            var maxLen = 8;
            aoa.forEach(function (r) {
              var v = r[c];
              if (v == null) return;
              var visual = 0;
              var s = String(v);
              for (var i = 0; i < s.length; i++) {
                visual += s.charCodeAt(i) > 255 ? 2 : 1;
              }
              maxLen = Math.max(maxLen, Math.min(visual, 80));
            });
            cols.push({ wch: maxLen + 2 });
          }
          sheet['!cols'] = cols;
          var name = '第' + pg.page + '页';
          if (name.length > 31) name = name.substring(0, 31);
          XLSX.utils.book_append_sheet(wb, sheet, name);
        });
      }

      if (!wb.SheetNames.length) {
        var empty = XLSX.utils.aoa_to_sheet([['未提取到任何文字内容']]);
        XLSX.utils.book_append_sheet(wb, empty, '空');
      }

      var out = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
      return new Blob([out], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    });
  }

  /* ---------------------------------------------------------------------
     21. PDF → PPT (.pptx)
     模式：
     - text ：可编辑文字结构（默认）——标题 + 正文 textbox，字号层级映射
     - image：整页图片背景（视觉一致，不可编辑）
     - both ：图片背景 + 可编辑文字浮层
     --------------------------------------------------------------------- */
  function toPpt(pdfjsDoc, opts, onProgress) {
    var PptxGenJS = need('pptxgenjs', global.PptxGenJS);
    opts = opts || {};

    var pptx = new PptxGenJS();
    pptx.author = 'PDF 工具箱';
    pptx.title = (opts.fileName || 'PDF 文档').replace(/\.pdf$/i, '');
    pptx.subject = '由 PDF 工具箱转换生成';

    pptx.defineLayout({ name: 'WIDE_16_9', width: 13.333, height: 7.5 });
    pptx.layout = 'WIDE_16_9';

    var SLIDE_W = 13.333, SLIDE_H = 7.5;
    var mode = opts.mode || 'text';
    var imageScale = Number(opts.imageScale) || 2;
    var withNotes = opts.withNotes !== false;
    var withImage = mode === 'image' || mode === 'both';

    // 封面
    var cover = pptx.addSlide();
    cover.background = { color: '2B579A' };
    cover.addShape(pptx.ShapeType.rect, {
      x: 0, y: 3.05, w: SLIDE_W, h: 0.06, fill: { color: '7FA8DD' }
    });
    cover.addText(pptx.title, {
      x: 0.8, y: 2.0, w: SLIDE_W - 1.6, h: 1.0,
      fontSize: 40, bold: true, color: 'FFFFFF', align: 'center', fontFace: '微软雅黑'
    });
    cover.addText('共 ' + pdfjsDoc.numPages + ' 页 · 由 PDF 工具箱转换生成', {
      x: 0.8, y: 3.3, w: SLIDE_W - 1.6, h: 0.5,
      fontSize: 16, color: 'C7D8EF', align: 'center', fontFace: '微软雅黑'
    });

    return extractDocument(pdfjsDoc, onProgress).then(function (pages) {
      var chain = Promise.resolve();

      pages.forEach(function (pg) {
        chain = chain.then(function () {
          var slide = pptx.addSlide();
          slide.background = { color: 'FFFFFF' };

          // 图片背景（image / both 模式）
          var imgPromise = withImage
            ? renderPageDataUrl(pdfjsDoc, pg.page, imageScale).then(function (dataUrl) {
                if (dataUrl) {
                  var ar = pg.width / pg.height;
                  var iw = SLIDE_W, ih = iw / ar;
                  if (ih > SLIDE_H) { ih = SLIDE_H; iw = ih * ar; }
                  slide.addImage({
                    data: dataUrl,
                    x: (SLIDE_W - iw) / 2, y: (SLIDE_H - ih) / 2, w: iw, h: ih
                  });
                }
              }).catch(function (err) { console.warn('PPT 图片渲染失败', err); })
            : Promise.resolve();

          return imgPromise.then(function () {
            // 可编辑文字层（text / both 模式）
            if (mode === 'text' || mode === 'both') {
              buildPptTextLayer(pptx, slide, pg, mode === 'both');
            }
            // 演讲者备注
            if (withNotes) {
              var txt = pg.lines.map(function (l) { return l.text; }).join('\n');
              if (txt.trim()) slide.addNotes('第 ' + pg.page + ' 页\n' + txt);
            }
          });
        });
      });

      return chain.then(function () {
        return pptx.write({ outputType: 'blob' });
      });
    });
  }

  /**
   * PPT 文字层：标题（最大字号行）+ 正文 textbox
   * @param {boolean} transparentBg both 模式下文字加浅色底衬提升可读性
   */
  function buildPptTextLayer(pptx, slide, pg, overlayMode) {
    if (!pg.lines.length) {
      slide.addText('（本页无可提取的文字内容）', {
        x: 0.8, y: 3.2, w: 11.7, h: 1,
        fontSize: 14, italic: true, color: '999999', align: 'center', fontFace: '微软雅黑'
      });
      return;
    }

    var maxSize = pg.lines.reduce(function (m, l) { return Math.max(m, l.fontSize); }, 0);
    var bodySize = pg.lines.reduce(function (m, l) { return Math.min(m, l.fontSize); }, Infinity);
    if (!isFinite(bodySize)) bodySize = 10;

    // 标题：字号 >= max*0.95 的前两行
    var titleLines = pg.lines.filter(function (l) { return l.fontSize >= maxSize * 0.95; }).slice(0, 2);
    var titleSet = {};
    titleLines.forEach(function (l) { titleSet[l.y] = true; });
    var bodyLines = pg.lines.filter(function (l) { return !titleSet[l.y]; });

    // 顶部色条 + 标题
    if (titleLines.length) {
      slide.addShape(pptx.ShapeType.rect, {
        x: 0, y: 0, w: SLIDE_W_PPT(), h: 0.9, fill: { color: '2B579A' }
      });
      slide.addText(titleLines.map(function (l) { return l.text; }).join(' '), {
        x: 0.5, y: 0.08, w: SLIDE_W_PPT() - 1, h: 0.74,
        fontSize: clampPpt(20 + (maxSize - bodySize) * 0.6, 20, 32),
        bold: true, color: 'FFFFFF', fontFace: '微软雅黑', valign: 'middle'
      });
    }

    // 正文：字号映射到 12-20pt，逐行 bullet
    var runs = [];
    var maxChars = 2200;
    var used = 0;
    var truncated = false;
    bodyLines.forEach(function (l) {
      if (used >= maxChars) { truncated = true; return; }
      var t = l.text;
      if (t.length > maxChars - used) {
        t = t.substring(0, Math.max(0, maxChars - used)) + '…';
        truncated = true;
      }
      used += t.length;
      runs.push({
        text: t,
        options: {
          breakLine: true,
          fontSize: clampPpt(10 + (l.fontSize - bodySize) * 0.8, 11, 20),
          color: '333333', fontFace: '微软雅黑',
          paraSpaceAfter: 4,
          bold: !!l.bold,
          bullet: isListLine(l) ? { code: '2022' } : false
        }
      });
    });
    if (truncated) {
      runs.push({
        text: '（内容较多，已截断；完整文字见演讲者备注）',
        options: { fontSize: 10, italic: true, color: 'B08A4A', fontFace: '微软雅黑' }
      });
    }

    var textOpts = {
      x: 0.55, y: titleLines.length ? 1.15 : 0.6,
      w: SLIDE_W_PPT() - 1.1, h: SLIDE_H_PPT() - (titleLines.length ? 1.5 : 0.95),
      valign: 'top', align: 'left', isTextBox: true
    };
    if (overlayMode) {
      // both 模式：半透明白色底衬，保证图片上的文字可读
      textOpts.fill = { color: 'FFFFFF', transparency: 15 };
      textOpts.line = { color: 'D5DEEA', width: 0.75 };
    }
    slide.addText(runs.length ? runs : [{
      text: '（本页除标题外无其他文字）',
      options: { fontSize: 12, italic: true, color: '999999' }
    }], textOpts);
  }

  function SLIDE_W_PPT() { return 13.333; }
  function SLIDE_H_PPT() { return 7.5; }
  function clampPpt(v, lo, hi) { return Math.max(lo, Math.min(hi, Math.round(v))); }

  /* ---------------------------------------------------------------------
     附加：提取纯文本
     --------------------------------------------------------------------- */
  function toPlainText(pdfjsDoc, onProgress) {
    return extractDocument(pdfjsDoc, onProgress).then(function (pages) {
      return pages.map(function (pg) {
        return '===== 第 ' + pg.page + ' 页 =====\n' + pg.lines.map(function (l) { return l.text; }).join('\n');
      }).join('\n\n');
    });
  }

  /* ---------------------------------------------------------------------
     导出
     --------------------------------------------------------------------- */
  global.Converters = {
    extractLines: extractLines,
    extractDocument: extractDocument,
    linesToTable: linesToTable,
    splitRowIntoCells: splitRowIntoCells,
    renderPageDataUrl: renderPageDataUrl,
    renderPageBlob: renderPageBlob,
    toWord: toWord,
    toExcel: toExcel,
    toPpt: toPpt,
    toPlainText: toPlainText
  };

})(window);
