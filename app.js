/* Calculation core: reads a score sheet and computes every figure. No DOM here. */
var Core = (function () {
  var SKIP = /total|position|\brank|pass|fail|average|\bavg\b|range|grade|remark|comment|^class\b|^arm$|^stream$|^s\/?n\.?$|^no\.?$|\bid\b|^sex$|^gender$|admission|^reg/i;
  var NOT_STUDENT = /^(average|avg|total|mean|grand|subject|highest|lowest|max|min)\b/i;
  var SCALES = [10, 15, 20, 25, 30, 40, 50, 60, 70, 100];
  var BANDS = ['90-100', '80-89', '70-79', '60-69', '50-59', '<50'];

  function norm(s) { return String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); }
  function key(s) { return norm(s).toUpperCase(); }
  function isNum(v) { return typeof v === 'number' && isFinite(v); }
  function mean(a) {
    var s = 0, n = 0;
    for (var i = 0; i < a.length; i++) if (isNum(a[i])) { s += a[i]; n++; }
    return n ? s / n : null;
  }
  function band(p) {
    if (p == null) return null;
    return p < 50 ? '<50' : p < 60 ? '50-59' : p < 70 ? '60-69' : p < 80 ? '70-79' : p < 90 ? '80-89' : '90-100';
  }
  /* A column that simply counts 1, 2, 3 ... down the rows is a serial number, not a subject. */
  function isSerial(body, c) {
    var steps = 0, n = 0, prev = null;
    body.forEach(function (row) {
      var v = row[c];
      if (!isNum(v)) return;
      if (prev !== null) { n++; if (v === prev + 1) steps++; }
      prev = v;
    });
    return n >= 3 && steps / n >= 0.9;
  }

  /* rows: array of arrays (one sheet). Returns null when the sheet is not a score sheet. */
  function parseSheet(rows, sheetName) {
    if (!rows || !rows.length) return null;
    var h = -1;
    for (var r = 0; r < Math.min(rows.length, 12); r++) {
      var texts = (rows[r] || []).filter(function (c) { return typeof c === 'string' && norm(c); }).length;
      if (texts >= 3) { h = r; break; }
    }
    if (h < 0) return null;
    var head = (rows[h] || []).map(norm);
    var nameCol = head.findIndex(function (x) { return /name|student|pupil|candidate/i.test(x); });
    if (nameCol < 0) nameCol = 0;
    var classCol = head.findIndex(function (x, i) { return i !== nameCol && /^(class|arm|stream)$/i.test(x); });

    var body = [];
    for (var i = h + 1; i < rows.length; i++) {
      var row = rows[i] || [];
      var nm = norm(row[nameCol]);
      if (!nm || typeof row[nameCol] !== 'string' || NOT_STUDENT.test(nm)) continue;
      body.push(row);
    }
    if (body.length < 2) return null;

    var subjCols = [];
    for (var c = 0; c < head.length; c++) {
      if (c === nameCol || c === classCol || !head[c] || SKIP.test(head[c])) continue;
      /* Electives are taken by a few students only, so a subject needs scores, not scores for most of the class. */
      var n = 0, filled = 0;
      for (var j = 0; j < body.length; j++) {
        var v = body[j][c];
        if (isNum(v)) n++;
        if (v != null && norm(v) !== '') filled++;
      }
      if (n >= 1 && n >= filled / 2 && !isSerial(body, c)) subjCols.push(c);
    }
    if (subjCols.length < 2) return null;

    var top = 0, students = [];
    body.forEach(function (row) {
      var scores = subjCols.map(function (c) { return isNum(row[c]) ? row[c] : null; });
      if (!scores.some(isNum)) return;
      scores.forEach(function (v) { if (v > top) top = v; });
      students.push({ name: norm(row[nameCol]), cls: classCol >= 0 ? norm(row[classCol]) || null : null, scores: scores });
    });
    if (students.length < 2) return null;
    var max = 100;
    for (var k = 0; k < SCALES.length; k++) if (top <= SCALES[k]) { max = SCALES[k]; break; }
    return { sheet: sheetName, max: max, subjects: subjCols.map(function (c) { return head[c]; }), students: students };
  }

  function rankBy(list, set) {
    var val = function (s) { return Math.round(s.avg * 1e6) / 1e6; };
    var sorted = list.filter(function (s) { return s.avg != null; }).sort(function (x, y) { return val(y) - val(x); });
    var prev = null, rank = 0;
    sorted.forEach(function (s, i) {
      if (prev === null || val(s) !== prev) { rank = i + 1; prev = val(s); }
      set(s, rank);
    });
  }

  /* Builds one record per student for the whole year group. */
  function build(sheet, passMark) {
    var seen = {};
    var students = sheet.students.map(function (st, i) {
      var k = key(st.name); if (seen[k]) k += ' #' + i; seen[k] = 1;
      var pct = st.scores.map(function (v) { return isNum(v) ? v / sheet.max * 100 : null; });
      var avg = mean(pct);
      return { key: k, name: st.name, cls: st.cls || 'Unassigned', scores: st.scores, pct: pct,
        total: st.scores.reduce(function (a, v) { return a + (isNum(v) ? v : 0); }, 0),
        avg: avg, pass: avg != null && avg >= passMark, band: band(avg) };
    });
    rankBy(students, function (s, r) { s.rank = r; });
    var classes = [];
    students.forEach(function (s) { if (classes.indexOf(s.cls) < 0) classes.push(s.cls); });
    classes.sort();
    classes.forEach(function (c) {
      rankBy(students.filter(function (s) { return s.cls === c; }), function (s, r) { s.classRank = r; });
    });
    return { subjects: sheet.subjects, students: students, classes: classes, max: sheet.max };
  }

  /* Aggregates for a list of student records (the whole year group or one class). */
  function summarise(model, list) {
    var subjects = model.subjects.map(function (name, i) {
      return { name: name, avg: mean(list.map(function (x) { return x.pct[i]; })), n: list.filter(function (x) { return x.pct[i] != null; }).length };
    });
    var classes = model.classes.map(function (c) {
      var m = list.filter(function (x) { return x.cls === c; });
      return { name: c, n: m.length, avg: mean(m.map(function (x) { return x.avg; })),
        pass: m.filter(function (x) { return x.pass; }).length,
        subjects: model.subjects.map(function (name, i) { return mean(m.map(function (x) { return x.pct[i]; })); }),
        takers: model.subjects.map(function (name, i) { return m.filter(function (x) { return x.pct[i] != null; }).length; }) };
    }).filter(function (c) { return c.n; });
    return {
      n: list.length, avg: mean(list.map(function (x) { return x.avg; })),
      pass: list.filter(function (x) { return x.pass; }).length,
      subjects: subjects, classes: classes,
      bands: BANDS.map(function (b) { return { name: b, n: list.filter(function (x) { return x.band === b; }).length }; })
    };
  }

  return { parseSheet: parseSheet, build: build, summarise: summarise, mean: mean, norm: norm, band: band, BANDS: BANDS };
})();
if (typeof module !== 'undefined') module.exports = Core;

(function () {
  if (typeof document === 'undefined') return;
  var $ = function (id) { return document.getElementById(id); };
  var STORE = 'hillrange-ca1-dashboard-v1';
  var pool = [];            // parsed sheets available to choose from
  var cfg = null;           // { a, pass, support, group, label, source }
  var model = null, view = [], whole = null;
  var filt = { cls: 'All' }, sort = { col: 'rank', dir: 1 }, selected = null, query = '';
  var lastFile = null;      // the file chosen in this visit, kept so Refresh can read it again

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function f1(v) { return v == null ? '–' : v.toFixed(1); }
  function f2(v) { return v == null ? '–' : String(Math.round(v * 100) / 100); }
  function pct0(n, d) { return d ? Math.round(n / d * 100) : 0; }
  function plural(n, w) { return n + ' ' + w + (n === 1 ? '' : 's'); }
  var ABBR = [[/PHYSICAL (AND|&) HEALTH EDUCATION/i, 'PHE'], [/CHRISTIAN RELIGIOUS (STUDIES|KNOWLEDGE)/i, 'CRS'], [/ISLAMIC RELIGIOUS (STUDIES|KNOWLEDGE)/i, 'IRS'],
    [/CULTURAL (AND|&) CREATIVE ARTS?/i, 'Creative Art'], [/COMPUTER STUDIES\/ICT/i, 'Computer/ICT'], [/PRE-?VOCATIONAL STUDIES/i, 'Pre-Vocational'],
    [/INFORMATION (AND|&) COMMUNICATION TECHNOLOGY/i, 'ICT'], [/BASIC TECHNOLOGY/i, 'Basic Tech'], [/ENGLISH (STUDIES|LANGUAGE)/i, 'English'], [/NATIONAL VALUES( EDUCATION)?/i, 'National Values']];
  function shortSubj(n) {
    for (var i = 0; i < ABBR.length; i++) if (ABBR[i][0].test(n)) return ABBR[i][1];
    return n.toLowerCase().replace(/(^|[\s\/-])([a-z])/g, function (m, p, c) { return p + c.toUpperCase(); });
  }
  function bandName(b) { return b === '<50' ? 'Below 50' : b.replace('-', '–'); }
  function took(s, n) { return s.n < n ? ' (' + plural(s.n, 'student') + ')' : ''; }
  function clsColor(c) { return (model.classes.indexOf(c) % 6) + 1; }

  /* ---------- charts ---------- */
  function barList(el, rows, opt) {
    if (!rows.length) { el.innerHTML = '<p class="empty">' + (opt.empty || 'No students match the current filter.') + '</p>'; return; }
    var html = '<div class="bars' + (opt.wide ? ' wide' : '') + '" role="list">';
    rows.forEach(function (r) {
      var colors = r.colors || opt.colors, bars = '';
      r.vals.forEach(function (v, k) {
        if (v == null) return;
        bars += '<span class="' + colors[k] + '" style="width:' + Math.max(0, Math.min(100, v / opt.max * 100)) + '%"></span>';
      });
      var one = r.vals.filter(function (v) { return v != null; }).length < 2;
      html += '<div class="bar-row' + (r.dim ? ' dim' : '') + '" role="listitem" tabindex="0" data-tip="' + esc(r.tip || '') + '"' + (r.key ? ' data-key="' + esc(r.key) + '"' : '') + '>' +
        '<span class="name">' + esc(r.name) + (r.sub ? '<small>' + esc(r.sub) + '</small>' : '') + '</span>' +
        '<div class="track' + (one ? ' one' : '') + '">' + bars + '</div>' +
        '<span class="vals num">' + r.label + '</span></div>';
    });
    html += '</div>';
    var pad = rows.reduce(function (m, r) { var t = r.label.replace(/<[^>]+>/g, ''); return t.length > m.length ? t : m; }, '');
    el.innerHTML = html + '<div class="axis num' + (opt.wide ? ' wide' : '') + '"><span></span><div><span>0</span><span>' + opt.max / 2 + '</span><span>' + opt.max + '</span></div><span class="vals" style="visibility:hidden">' + esc(pad) + '</span></div>';
  }
  function legend(el, items) {
    el.innerHTML = items.map(function (it) { return '<span' + (it[2] ? ' class="dim"' : '') + '><i class="' + it[0] + '"></i>' + esc(it[1]) + '</span>'; }).join('');
    el.hidden = items.length < 2;
  }
  function niceMax(v, step) { return Math.max(step, Math.ceil(v / step) * step); }

  /* Grouped columns: one group per subject, one column per class, on a 0 to 100 percent scale. */
  function groupedColumns(el, sum) {
    var subs = sum.subjects, cls = sum.classes, n = subs.length, k = cls.length;
    if (!n || !k) { el.innerHTML = '<p class="empty">No scores to show.</p>'; return; }
    var W = Math.max(el.clientWidth || 0, Math.max(760, n * Math.max(64, k * 12 + 16) + 40)), H = 300, L = 34, R = 6, T = 12, B = 46;
    var ph = H - T - B, band = (W - L - R) / n;
    var bw = Math.max(5, Math.min(18, (band * 0.72 - 2 * (k - 1)) / k)), gw = k * bw + 2 * (k - 1);
    var y = function (v) { return T + ph - v / 100 * ph; };
    var s = '<svg class="cols" width="' + W + '" height="' + H + '" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="Average score of each class in every subject">';
    [0, 25, 50, 75, 100].forEach(function (t) {
      s += '<line class="' + (t ? 'grid' : 'base') + '" x1="' + L + '" x2="' + (W - R) + '" y1="' + y(t) + '" y2="' + y(t) + '"></line>' +
        '<text class="num" x="' + (L - 8) + '" y="' + (y(t) + 4) + '" text-anchor="end">' + t + '</text>';
    });
    subs.forEach(function (sub, i) {
      var x0 = L + i * band, gx = x0 + (band - gw) / 2;
      var tip = '<b>' + esc(sub.name) + '</b>';
      var bars = '';
      cls.forEach(function (c, j) {
        var v = c.subjects[i];
        tip += '<br>' + esc(c.name) + ': ' + (v == null ? 'not offered' : f1(v) + '% (' + plural(c.takers[i], 'student') + ')');
        if (v == null) return;
        var x = gx + j * (bw + 2), top = y(v), h = y(0) - top, r = Math.min(4, bw / 2, h);
        bars += '<path class="f' + clsColor(c.name) + (filt.cls !== 'All' && filt.cls !== c.name ? ' dim' : '') + '" d="M' + x + ' ' + y(0) + 'V' + (top + r) + 'q0 ' + -r + ' ' + r + ' ' + -r + 'h' + (bw - 2 * r) + 'q' + r + ' 0 ' + r + ' ' + r + 'V' + y(0) + 'z"></path>';
      });
      var words = shortSubj(sub.name).replace('/', '/ ').split(' '), l1 = words[0], l2 = words.slice(1).join(' ');
      s += '<g class="hit" tabindex="0" data-tip="' + esc(tip) + '"><rect class="bg" x="' + x0 + '" y="' + T + '" width="' + band + '" height="' + (H - T) + '" rx="4"></rect>' + bars +
        '<text class="cat" x="' + (x0 + band / 2) + '" y="' + (H - B + 18) + '" text-anchor="middle">' + esc(l1) + '</text>' +
        (l2 ? '<text class="cat" x="' + (x0 + band / 2) + '" y="' + (H - B + 33) + '" text-anchor="middle">' + esc(l2) + '</text>' : '') + '</g>';
    });
    el.innerHTML = s + '</svg>';
  }

  function ring(el, pass, fail) {
    var n = pass + fail, r = 52, c = 2 * Math.PI * r, gap = fail && pass ? 3 : 0;
    var fl = n ? Math.max(fail ? 5 : 0, fail / n * c) : 0, pl = c - fl;
    var arc = function (cls, len, off) {
      return len > gap ? '<circle class="' + cls + '" cx="70" cy="70" r="' + r + '" fill="none" stroke-width="15" stroke-dasharray="' + (len - gap) + ' ' + (c - len + gap) + '" stroke-dashoffset="' + -off + '" transform="rotate(-90 70 70)"></circle>' : '';
    };
    el.innerHTML = '<svg width="140" height="140" viewBox="0 0 140 140" role="img" aria-label="' + pass + ' passed, ' + fail + ' failed">' +
      (n ? arc('arc-pass', pl, 0) + arc('arc-fail', fl, pl) : '<circle class="arc-none" cx="70" cy="70" r="52" fill="none" stroke-width="15"></circle>') +
      '<text class="big num" x="70" y="72" text-anchor="middle">' + pct0(pass, n) + '%</text><text class="cap" x="70" y="90" text-anchor="middle">passed</text></svg>' +
      '<ul><li><span class="ico pass" aria-hidden="true">✓</span><b class="num">' + pass + '</b><span>passed (' + cfg.pass + '% or above)</span></li>' +
      '<li><span class="ico fail" aria-hidden="true">✕</span><b class="num">' + fail + '</b><span>failed (below ' + cfg.pass + '%)</span></li></ul>';
  }

  /* ---------- rendering ---------- */
  function insights(sum) {
    var out = [], n = sum.n, scope = filt.cls === 'All' ? '' : ' in ' + filt.cls;
    var sub = sum.subjects.filter(function (s) { return s.avg != null; }).sort(function (x, y) { return y.avg - x.avg; });
    if (sub.length) {
      var best = sub[0], worst = sub[sub.length - 1], next = sub[sub.length - 2];
      out.push(['Best performing subject', '<b>' + esc(shortSubj(best.name)) + '</b> has the highest average score' + scope + ' at ' + f1(best.avg) + '%' + took(best, n) + (sub[1] ? ', ahead of ' + esc(shortSubj(sub[1].name)) + ' (' + f1(sub[1].avg) + '%).' : '.')]);
      out.push(['Weakest subject', '<b>' + esc(shortSubj(worst.name)) + '</b> recorded the lowest average at ' + f1(worst.avg) + '%' + took(worst, n) + (next && next !== best ? ', followed by ' + esc(shortSubj(next.name)) + ' (' + f1(next.avg) + '%). Students may need extra support in these subjects.' : '.')]);
    }
    var cl = whole.classes.slice().sort(function (x, y) { return y.avg - x.avg; });
    if (cl.length > 1) {
      var pos = cl.findIndex(function (c) { return c.name === filt.cls; });
      out.push(['Best performing class', '<b>' + esc(cl[0].name) + '</b> achieved the highest class average (' + f1(cl[0].avg) + '%). ' +
        cl.slice(1).map(function (c) { return esc(c.name) + ' averaged ' + f1(c.avg) + '%'; }).join(' and ') + '.' + (pos > 0 ? ' ' + esc(filt.cls) + ' is in position ' + (pos + 1) + ' of ' + cl.length + '.' : '')]);
    }
    var fail = n - sum.pass, low = view.filter(function (s) { return s.avg != null && s.avg < cfg.support; }).length;
    out.push(['Students at academic risk', (fail ? '<b>' + plural(fail, 'student') + '</b> (' + pct0(fail, n) + '%) scored below the ' + cfg.pass + '% pass mark' : '<b>No student</b> scored below the ' + cfg.pass + '% pass mark') + scope + '.' +
      (cfg.support > cfg.pass ? ' ' + (low ? plural(low, 'student') + (low === 1 ? ' is' : ' are') : 'None are') + ' below ' + cfg.support + '% and may need targeted support.' : '')]);
    var b = {}; sum.bands.forEach(function (x) { b[x.name] = x.n; });
    var strong = b['90-100'] + b['80-89'];
    out.push(['Consistently strong students', '<b>' + plural(strong, 'student') + '</b> (' + pct0(strong, n) + '%) averaged 80% or above' + scope + (b['90-100'] ? ', and ' + b['90-100'] + ' of them reached 90% or above.' : '.')]);
    var mode = sum.bands.slice().sort(function (x, y) { return y.n - x.n; })[0];
    if (n) out.push(['Score distribution', 'The most common band is <b>' + bandName(mode.name) + '%</b> (' + plural(mode.n, 'student') + '). ' + pct0(b['70-79'] + b['80-89'], n) + '% of averages fall between 70% and 89%.']);
    return out.map(function (x) { return '<li><span class="eyebrow">' + x[0] + '</span><p>' + x[1] + '</p></li>'; }).join('');
  }

  function render() {
    view = model.students.filter(function (s) { return filt.cls === 'All' || s.cls === filt.cls; });
    whole = Core.summarise(model, model.students);
    var sum = filt.cls === 'All' ? whole : Core.summarise(model, view);
    var L = cfg.label, all = filt.cls === 'All', who = all ? (cfg.group || 'the year group') : filt.cls;

    $('title').textContent = (cfg.group ? cfg.group + ' ' : '') + L + ' result dashboard';
    $('subtitle').textContent = plural(model.students.length, 'student') + ' in ' + plural(model.classes.length, 'class').replace('classs', 'classes') + ' · ' + model.subjects.length + ' subjects, each marked out of ' + model.max;
    $('filters').innerHTML = '<div class="seg" role="group" aria-label="Class"><span class="lab">Class</span>' + ['All'].concat(model.classes).map(function (o) {
      return '<button type="button" class="chip" data-v="' + esc(o) + '" aria-pressed="' + (filt.cls === o) + '">' + esc(o) + '</button>';
    }).join('') + '</div>';

    /* headline figures */
    var sub = sum.subjects.filter(function (s) { return s.avg != null; }).sort(function (x, y) { return y.avg - x.avg; });
    var cl = whole.classes.slice().sort(function (x, y) { return y.avg - x.avg; });
    var k = [];
    k.push(['Students', '<span class="num">' + sum.n + '</span>', all ? 'whole year group' : 'in ' + esc(filt.cls), '']);
    k.push(['Average score', '<span class="num">' + f1(sum.avg) + '</span><small>%</small>', 'across all subjects', '']);
    k.push(['Pass rate', '<span class="num">' + pct0(sum.pass, sum.n) + '</span><small>%</small>', sum.pass + ' of ' + sum.n + ' at or above ' + cfg.pass + '%', '']);
    if (sub.length) {
      k.push(['Best subject', esc(shortSubj(sub[0].name)), f1(sub[0].avg) + '% average' + took(sub[0], sum.n), ' txt']);
      k.push(['Weakest subject', esc(shortSubj(sub[sub.length - 1].name)), f1(sub[sub.length - 1].avg) + '% average' + took(sub[sub.length - 1], sum.n), ' txt']);
    }
    if (cl.length > 1) k.push(['Top class', esc(cl[0].name), f1(cl[0].avg) + '% average', ' txt']);
    $('kpis').innerHTML = k.map(function (x) { return '<div class="kpi"><span class="eyebrow">' + x[0] + '</span><span class="v' + x[3] + '">' + x[1] + '</span><span class="d">' + x[2] + '</span></div>'; }).join('');

    $('ins-title').textContent = 'What the ' + L + ' results say';
    $('ins-sub').textContent = 'Written from the figures below for ' + who + '. It updates with the class filter and with each upload.';
    $('insights').innerHTML = insights(sum);

    /* subjects by class: always every class, the filtered one stays at full strength */
    legend($('legend-grp'), whole.classes.map(function (c) { return ['c' + clsColor(c.name), c.name, !all && c.name !== filt.cls]; }));
    groupedColumns($('chart-grp'), whole);

    $('subj-sub').textContent = 'Average score in each subject for ' + who + ', in percent, highest first.' + (sub.some(function (s) { return s.n < sum.n; }) ? ' Electives show how many students offer them.' : '');
    barList($('chart-subj'), sub.map(function (s) {
      return { name: shortSubj(s.name), sub: s.n < sum.n ? s.n + ' of ' + sum.n : '', vals: [s.avg], label: '<b>' + f1(s.avg) + '</b>', tip: '<b>' + esc(s.name) + '</b><br>Average: ' + f1(s.avg) + '% (' + f2(s.avg / 100 * model.max) + ' out of ' + model.max + ')<br>Offered by ' + s.n + ' of ' + plural(sum.n, 'student') };
    }), { max: 100, colors: ['ca'] });

    barList($('chart-class'), cl.map(function (c) {
      return { name: c.name, sub: plural(c.n, 'student'), vals: [c.avg], colors: ['c' + clsColor(c.name)], dim: !all && c.name !== filt.cls, label: '<b>' + f1(c.avg) + '</b>',
        tip: '<b>' + esc(c.name) + '</b> · ' + plural(c.n, 'student') + '<br>Average: ' + f1(c.avg) + '%<br>Passed: ' + c.pass + ' of ' + c.n };
    }), { max: 100 });

    $('pf-sub').textContent = 'Pass means an average of ' + cfg.pass + '% or above.';
    ring($('chart-pf'), sum.pass, sum.n - sum.pass);

    var bm = niceMax(Math.max.apply(null, sum.bands.map(function (b) { return b.n; }).concat([1])), 4);
    barList($('chart-band'), sum.bands.map(function (b) {
      return { name: bandName(b.name), vals: [b.n], label: '<b>' + b.n + '</b> · ' + pct0(b.n, sum.n) + '%',
        tip: '<b>' + bandName(b.name) + '%</b><br>' + plural(b.n, 'student') + ' · ' + pct0(b.n, sum.n) + '% of ' + sum.n };
    }), { max: bm, colors: ['ca'] });

    /* ranked lists */
    function stuRow(s) {
      var lows = model.subjects.map(function (nm, i) { return [nm, s.pct[i]]; }).filter(function (x) { return x[1] != null; }).sort(function (x, y) { return x[1] - y[1]; }).slice(0, 2);
      return { key: s.key, name: s.name, sub: s.cls, vals: [s.avg], colors: [s.pass ? 'ca' : 'cb'], label: '<b>' + f1(s.avg) + '</b>',
        tip: '<b>' + esc(s.name) + '</b> · ' + esc(s.cls) + '<br>Average: ' + f1(s.avg) + '% · position ' + s.rank + (s.pass ? '' : '<br>Below the pass mark') +
          '<br>Lowest: ' + lows.map(function (x) { return esc(shortSubj(x[0])) + ' ' + f1(x[1]) + '%'; }).join(', ') };
    }
    var byAvg = view.filter(function (s) { return s.avg != null; }).sort(function (x, y) { return x.rank - y.rank; });
    barList($('list-top'), byAvg.slice(0, 10).map(stuRow), { max: 100, wide: true });
    var weak = byAvg.filter(function (s) { return s.avg < cfg.support; }).reverse();
    $('weak-sub').textContent = plural(weak.length, 'student') + ' with an average below ' + cfg.support + '%, lowest first.' + (weak.some(function (s) { return !s.pass; }) ? ' Red bars are below the pass mark.' : '');
    barList($('list-weak'), weak.slice(0, 15).map(stuRow), { max: 100, wide: true, empty: 'No student is below ' + cfg.support + '%.' });

    renderTable();
    if (!selected || !view.some(function (s) { return s.key === selected; })) selected = byAvg.length ? byAvg[0].key : null;
    renderProfile();
    markSelected();

    $('foot').textContent = 'Each score is converted to a percent of the ' + model.max + ' marks obtainable. A student\'s average is the mean of the subjects they offer (blank subjects are left out), and positions rank on it across the whole year group. Pass means ' + cfg.pass + '% or above. Score ranges: below 50, 50–59, 60–69, 70–79, 80–89, 90–100.';
  }

  var COLS = [['rank', 'Pos.'], ['name', 'Student'], ['cls', 'Class'], ['total', 'Total points'], ['avg', 'Average %'], ['band', 'Score range'], ['classRank', 'Class pos.'], ['pass', 'Result']];
  function tableRows() {
    var q = query.trim().toUpperCase();
    var rows = view.filter(function (s) { return !q || s.name.toUpperCase().indexOf(q) >= 0; });
    var c = sort.col === 'band' ? 'avg' : sort.col;
    rows.sort(function (x, y) {
      var a = x[c], b = y[c];
      if (a == null) return 1; if (b == null) return -1;
      return (typeof a === 'string' ? a.localeCompare(b) : a - b) * sort.dir || x.rank - y.rank;
    });
    return rows;
  }
  function renderTable() {
    var rows = tableRows();
    $('table').tHead.innerHTML = '<tr>' + COLS.map(function (c) {
      return '<th scope="col" tabindex="0" data-col="' + c[0] + '"' + (sort.col === c[0] ? ' aria-sort="' + (sort.dir === 1 ? 'ascending' : 'descending') + '"' : '') + '>' + c[1] + '</th>';
    }).join('') + '</tr>';
    $('table').tBodies[0].innerHTML = rows.map(function (s) {
      return '<tr data-key="' + esc(s.key) + '" tabindex="0"><td class="num">' + s.rank + '</td><td>' + esc(s.name) + '</td><td>' + esc(s.cls) + '</td><td class="num">' + f2(s.total) + '</td>' +
        '<td class="num"><b>' + f1(s.avg) + '</b></td><td class="num">' + esc(bandName(s.band)) + '</td><td class="num">' + s.classRank + '</td><td><span class="pill ' + (s.pass ? 'pass' : 'fail') + '">' + (s.pass ? 'Pass' : 'Fail') + '</span></td></tr>';
    }).join('') || '<tr><td colspan="8" style="text-align:left">No students match.</td></tr>';
    $('reg-sub').textContent = rows.length + ' of ' + model.students.length + ' students. Select a row to see the subject breakdown.';
  }
  function markSelected() {
    Array.prototype.forEach.call($('table').tBodies[0].rows, function (tr) { tr.setAttribute('aria-selected', tr.dataset.key === selected); });
  }
  function renderProfile() {
    var s = model.students.filter(function (x) { return x.key === selected; })[0];
    var el = $('profile');
    if (!s) { el.innerHTML = '<p class="empty">Select a student to see their subjects.</p>'; return; }
    el.innerHTML = '<div><span class="eyebrow">Student profile</span><h3>' + esc(s.name) + '</h3><p class="sub">' + esc(s.cls) + ' · <span class="pill ' + (s.pass ? 'pass' : 'fail') + '">' + (s.pass ? 'Pass' : 'Fail') + '</span></p></div>' +
      '<div class="facts num"><div><b>' + f1(s.avg) + '%</b><span>Average score</span></div><div><b>' + s.rank + ' <small>of ' + model.students.length + '</small></b><span>Year position</span></div><div><b>' + s.classRank + '</b><span>Class position</span></div></div>' +
      '<div class="legend" id="legend-prof"></div><div id="chart-prof"></div>';
    legend($('legend-prof'), [['c1', 'This student'], ['cm', 'Year average']]);
    barList($('chart-prof'), model.subjects.map(function (name, i) {
      var v = s.pct[i], y = whole.subjects[i].avg;
      return { name: shortSubj(name), vals: [v, y], label: '<b>' + (s.scores[i] == null ? '–' : f2(s.scores[i])) + '</b>/' + model.max,
        tip: '<b>' + esc(name) + '</b><br>Score: ' + (s.scores[i] == null ? 'none' : f2(s.scores[i]) + ' out of ' + model.max + ' (' + f1(v) + '%)') + '<br>Year average: ' + f1(y) + '%' };
    }), { max: 100, colors: ['c1', 'cm'] });
  }

  /* ---------- data: run, save, upload ---------- */
  function setEmpty(empty) {
    $('dash').hidden = empty; $('empty').hidden = !empty;
    $('btn-refresh').disabled = $('btn-clear').disabled = $('btn-settings').disabled = empty;
    if (empty) { openPanel(false); $('title').textContent = 'Result dashboard'; $('subtitle').textContent = 'No score sheet loaded'; }
  }
  /* keep = true holds on to the class filter and the selected student (used by Refresh). */
  function run(keep) {
    model = Core.build(pool[cfg.a], cfg.pass);
    if (!keep || model.classes.indexOf(filt.cls) < 0) filt = { cls: 'All' };
    if (!keep) selected = null;
    setEmpty(false);
    render();
  }
  function status(t) { $('status').textContent = t || ''; $('status').hidden = !t; }
  function clock() { try { return new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); } catch (e) { return ''; } }
  function clearAll() {
    pool = []; model = null; lastFile = null; view = []; selected = null; query = ''; $('search').value = '';
    try { localStorage.setItem(STORE, JSON.stringify({ cleared: true })); } catch (e) { }
    setEmpty(true);
  }
  function save() {
    try { localStorage.setItem(STORE, JSON.stringify({ sheet: pool[cfg.a], pass: cfg.pass, support: cfg.support, group: cfg.group, label: cfg.label, source: cfg.source })); }
    catch (e) { /* storage unavailable: the page still works for this visit */ }
  }
  function restore() {
    try {
      var s = JSON.parse(localStorage.getItem(STORE) || 'null');
      if (s && s.cleared) return 'empty';
      if (s && s.sheet && s.sheet.students && s.sheet.students.length) {
        pool = [s.sheet];
        cfg = { a: 0, pass: s.pass, support: s.support, group: s.group || '', label: s.label || 'CA1', source: s.source || 'your last upload' };
        return true;
      }
    } catch (e) { }
    return false;
  }
  function fillPanel() {
    $('sel-a').innerHTML = pool.map(function (p, i) { return '<option value="' + i + '">' + esc(p.sheet) + ' (' + p.students.length + ' students)</option>'; }).join('');
    $('sel-a').value = cfg.a; $('max-a').value = pool[cfg.a].max; $('lab-a').value = cfg.label;
    $('group').value = cfg.group; $('pass').value = cfg.pass; $('support').value = cfg.support;
    $('source-note').textContent = 'Current data: ' + cfg.source + '. Uploaded files are read in this browser only.';
  }
  function showMsg(t) { $('panel-msg').textContent = t || ''; $('panel-msg').hidden = !t; }
  function openPanel(open) { $('panel').hidden = !open; $('btn-settings').setAttribute('aria-expanded', open); }

  function guessGroup(names) {
    for (var i = 0; i < names.length; i++) {
      var m = String(names[i]).match(/(JSS?|SSS?|BASIC|PRIMARY|YEAR|GRADE)[\s_-]*(\d)/i);
      if (m) return m[1].toUpperCase() + m[2];
    }
    return '';
  }
  function guessLabel(names) {
    for (var i = 0; i < names.length; i++) {
      var m = String(names[i]).replace(/[_.-]/g, ' ').match(/\b(CA\s*\d+|EXAM\w*|TEST\s*\d*|MID\s?TERM)\b/i);
      if (m) return m[1].replace(/\s+/g, '').toUpperCase();
    }
    return 'CA1';
  }
  function readFile(file, refresh) {
    if (typeof XLSX === 'undefined') { status('The Excel reader could not load. Check the internet connection and reload the page.'); return; }
    var stale = 'The browser could not read ' + file.name + ' again, usually because it was edited and saved after you uploaded it. Select Upload a score sheet and choose it again to bring in the changes.';
    var fr = new FileReader();
    fr.onload = function () {
      var found = [];
      try {
        var wb = XLSX.read(new Uint8Array(fr.result), { type: 'array' });
        wb.SheetNames.forEach(function (n) {
          var p = Core.parseSheet(XLSX.utils.sheet_to_json(wb.Sheets[n], { header: 1, defval: null, raw: true }), n);
          if (p && p.subjects.length <= 30) found.push(p);
        });
      } catch (e) { status('Could not read ' + file.name + '. Save it as .xlsx and try again.'); return; }
      if (!found.length) { status('No score sheet was found in ' + file.name + '. A score sheet needs a heading row with student names and one column per subject.'); return; }
      lastFile = file;
      if (refresh && model) {
        /* same file again: keep the chosen sheet, the settings and the class filter */
        var name = pool[cfg.a].sheet, max = pool[cfg.a].max, at = found.findIndex(function (p) { return p.sheet === name; });
        pool = found; cfg.a = at < 0 ? 0 : at; pool[cfg.a].max = max; cfg.source = file.name;
        showMsg(''); fillPanel(); run(true); save();
        status('Refreshed from ' + file.name + ' at ' + clock() + '.');
        return;
      }
      pool = found;
      var classes = found[0].students.map(function (s) { return s.cls; }).filter(Boolean);
      cfg = { a: 0, pass: cfg ? cfg.pass : 50, support: cfg ? cfg.support : 55, group: guessGroup(classes.slice(0, 3).concat([found[0].sheet, file.name])), label: guessLabel([found[0].sheet, file.name]), source: file.name };
      showMsg(''); fillPanel(); run(); save();
      openPanel(found.length > 1);
      status('Loaded ' + file.name + (found.length > 1 ? '. This workbook has ' + found.length + ' score sheets; the first is shown. Choose another under Score sheet in Settings, then select Update dashboard.' : ' at ' + clock() + '.'));
    };
    fr.onerror = function () { status(refresh ? stale : 'Could not open ' + file.name + '.'); };
    fr.readAsArrayBuffer(file);
  }

  /* ---------- events ---------- */
  $('btn-upload').onclick = function () { $('file').click(); };
  $('file').onchange = function () { if (this.files.length) readFile(this.files[0]); this.value = ''; };
  $('btn-settings').onclick = function () { openPanel($('panel').hidden); };
  $('sel-a').onchange = function () { $('max-a').value = pool[+this.value].max; };
  $('btn-apply').onclick = function () {
    var a = +$('sel-a').value, ma = +$('max-a').value, pass = +$('pass').value, sup = +$('support').value;
    if (!(ma > 0) || !(pass >= 0 && pass <= 100) || !(sup >= 0 && sup <= 100)) { showMsg('Marks obtainable must be above zero, and the two percentages between 0 and 100.'); return; }
    showMsg('');
    pool[a].max = ma; cfg.a = a; cfg.pass = pass; cfg.support = sup;
    cfg.label = Core.norm($('lab-a').value) || 'CA1'; cfg.group = Core.norm($('group').value);
    run(); save(); fillPanel(); status('');
  };
  $('btn-refresh').onclick = function () {
    if (!model) return;
    armClear(false);
    if (lastFile) { readFile(lastFile, true); return; }
    query = ''; $('search').value = ''; run(true);
    status('Recalculated at ' + clock() + ' from the data saved in this browser. To bring in changes made in Excel, upload the file again.');
  };
  /* Clear asks once more before it removes the data: the first click arms the button, the second clears. */
  var armTimer;
  function armClear(on) {
    clearTimeout(armTimer);
    $('btn-clear').dataset.armed = on ? '1' : '';
    $('btn-clear').textContent = on ? 'Select again to clear' : 'Clear';
    if (on) armTimer = setTimeout(function () { armClear(false); }, 5000);
  }
  $('btn-clear').onclick = function () {
    if (this.dataset.armed !== '1') { armClear(true); return; }
    armClear(false); clearAll();
    status('Cleared. Upload a score sheet to see its results.');
  };
  $('filters').onclick = function (e) {
    var b = e.target.closest('.chip'); if (!b) return;
    filt.cls = b.dataset.v; render();
  };
  $('search').oninput = function () { query = this.value; if (model) { renderTable(); markSelected(); } };
  function pick(key, scroll) {
    selected = key; renderProfile(); markSelected();
    if (scroll) $('profile').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }
  $('table').addEventListener('click', function (e) {
    var th = e.target.closest('th');
    if (th) { var c = th.dataset.col; if (sort.col === c) sort.dir = -sort.dir; else { sort.col = c; sort.dir = (c === 'name' || c === 'cls' || c === 'rank' || c === 'classRank') ? 1 : -1; } renderTable(); markSelected(); return; }
    var tr = e.target.closest('tr[data-key]'); if (tr) pick(tr.dataset.key, true);
  });
  $('table').addEventListener('keydown', function (e) {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    var t = e.target.closest('th, tr[data-key]'); if (t) { e.preventDefault(); t.click(); }
  });
  document.addEventListener('click', function (e) {
    var r = e.target.closest('.bar-row[data-key]'); if (r) pick(r.dataset.key, true);
  });
  /* Copies the summary sheet in the workbook's own column order. */
  $('btn-copy').onclick = function () {
    var btn = this;
    var head = ['S/N', 'STUDENTS NAME'].concat(model.subjects, ['TOTAL POINTS', 'CLASS', 'RANK', 'PASS/FAIL', 'AVERAGE SCORE', 'SCORE RANGE']);
    var lines = [head.join('\t')].concat(tableRows().map(function (s, i) {
      return [i + 1, s.name].concat(s.scores.map(function (v) { return v == null ? '' : v; }), [f2(s.total), s.cls, s.rank, s.pass ? 'PASS' : 'FAIL', s.avg == null ? '' : s.avg.toFixed(2), s.band || '']).join('\t');
    }));
    var ok = function () { btn.textContent = 'Copied. Paste into Excel'; setTimeout(function () { btn.textContent = 'Copy summary for Excel'; }, 2500); };
    var fail = function () { btn.textContent = 'Copy is blocked in this view'; setTimeout(function () { btn.textContent = 'Copy summary for Excel'; }, 2500); };
    try { navigator.clipboard.writeText(lines.join('\n')).then(ok, fail); } catch (e) { fail(); }
  };

  /* tooltip */
  var tip = $('tip');
  function showTip(row, x, y) {
    if (!row || !row.dataset.tip) { tip.hidden = true; return; }
    tip.innerHTML = row.dataset.tip; tip.hidden = false;
    var w = tip.offsetWidth, h = tip.offsetHeight;
    tip.style.left = Math.max(8, Math.min(window.innerWidth - w - 8, x + 14)) + 'px';
    tip.style.top = (y + h + 24 > window.innerHeight ? y - h - 12 : y + 16) + 'px';
  }
  document.addEventListener('mousemove', function (e) { showTip(e.target.closest && e.target.closest('[data-tip]'), e.clientX, e.clientY); });
  document.addEventListener('focusin', function (e) {
    var r = e.target.closest && e.target.closest('[data-tip]');
    if (r) { var b = r.getBoundingClientRect(); showTip(r, b.left + b.width / 3, b.bottom - 12); } else tip.hidden = true;
  });
  document.addEventListener('scroll', function () { tip.hidden = true; }, true);
  var rz; window.addEventListener('resize', function () { clearTimeout(rz); rz = setTimeout(function () { if (model) groupedColumns($('chart-grp'), whole); }, 150); });

  /* ---------- start ---------- */
  var kept = restore();
  /* The page carries no built-in results: it starts empty until a score sheet is uploaded in this browser. */
  if (kept === true) { fillPanel(); run(); } else setEmpty(true);
})();
