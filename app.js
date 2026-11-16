/* =========================================================
   피클 홀로그램 · 4면 피라미드 홀로그램 웹앱
   피클(하와이안 피자의 피클) 코어 · D-DAY HUD · 공부 타이머
   ========================================================= */
(function () {
  'use strict';

  var TAU = Math.PI * 2;
  var LIME = '#a3e635';
  var PALE = '#d9f99d';

  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
  function lerp(a, b, t) { return a + (b - a) * t; }

  /* ---------------- DOM ---------------- */
  var app = document.getElementById('app');
  var stage = document.getElementById('stage');
  var stageBox = document.getElementById('stageBox');
  var hint = document.getElementById('hint');
  var toastEl = document.getElementById('toast');
  var gapVal = document.getElementById('gapVal');
  var sizeVal = document.getElementById('sizeVal');
  var micBtn = document.getElementById('micBtn');
  var tRun = document.getElementById('tRun');
  var timerCtl = document.getElementById('timerCtl');

  var CANVAS_KEYS = ['tl', 'tr', 'bl', 'br'];
  var canvases = {};
  var ctxs = {};
  CANVAS_KEYS.forEach(function (k) {
    canvases[k] = document.querySelector('canvas[data-q="' + k + '"]');
    ctxs[k] = canvases[k].getContext('2d');
  });
  var sheetEl = document.getElementById('sheet');
  var sheetCtx = sheetEl.getContext('2d');
  var sheetW = 300, sheetH = 400;
  var BASE_ROT = { tl: 180, tr: 270, bl: 90, br: 0 };

  var off = document.createElement('canvas');
  var octx = off.getContext('2d');

  var DPR = Math.max(1, Math.min(3, window.devicePixelRatio || 1));

  /* ---------------- state ---------------- */
  var STORE = 'pickle-hologram-v1';
  var state = {
    mode: 'pickle',
    gapPct: 0.14,
    sizeScale: 0.94,
    flipX: false,
    rot180: false
  };
  try {
    var saved = JSON.parse(localStorage.getItem(STORE) || 'null');
    if (saved && typeof saved === 'object') {
      if (saved.mode === 'pickle' || saved.mode === 'dday' || saved.mode === 'timer' || saved.mode === 'sheet') state.mode = saved.mode;
      if (typeof saved.gapPct === 'number') state.gapPct = clamp(saved.gapPct, 0, 0.80);
      if (typeof saved.sizeScale === 'number') state.sizeScale = clamp(saved.sizeScale, 0.55, 1.2);
      if (typeof saved.flipX === 'boolean') state.flipX = saved.flipX;
      if (typeof saved.rot180 === 'boolean') state.rot180 = saved.rot180;
    }
  } catch (e) { /* private mode 등 */ }

  function save() {
    try {
      localStorage.setItem(STORE, JSON.stringify({
        mode: state.mode, gapPct: state.gapPct, sizeScale: state.sizeScale,
        flipX: state.flipX, rot180: state.rot180
      }));
    } catch (e) { /* ignore */ }
  }

  /* ---------------- timer ---------------- */
  var POMO = 25 * 60;
  var timer = { kind: 'pomo', running: false, remaining: POMO, elapsed: 0, done: false };

  /* ---------------- layout ---------------- */
  var S = 320, P = 150, px = 150;

  function layout() {
    if (state.mode === 'sheet') {
      sheetW = Math.max(40, stageBox.clientWidth || 300);
      sheetH = Math.max(40, stageBox.clientHeight || 300);
      var sw = Math.round(sheetW * DPR), shh = Math.round(sheetH * DPR);
      if (sheetEl.width !== sw || sheetEl.height !== shh) { sheetEl.width = sw; sheetEl.height = shh; }
      sheetEl.style.width = sheetW + 'px';
      sheetEl.style.height = sheetH + 'px';
      if (off.width !== sw || off.height !== shh) { off.width = sw; off.height = shh; }
      return;
    }

    var bw = stageBox.clientWidth || 300;
    var bh = stageBox.clientHeight || 300;
    S = Math.max(140, Math.floor(Math.min(bw, bh)));
    stage.style.width = S + 'px';
    stage.style.height = S + 'px';

    var gap = Math.round(S * state.gapPct);
    P = Math.max(36, Math.floor((S - gap) / 2));
    px = Math.round(P * DPR);

    CANVAS_KEYS.forEach(function (k) {
      var wrap = canvases[k].parentNode;
      wrap.style.width = P + 'px';
      wrap.style.height = P + 'px';
      var c = canvases[k];
      if (c.width !== px || c.height !== px) { c.width = px; c.height = px; }
      c.style.width = P + 'px';
      c.style.height = P + 'px';
      c.style.transform = 'rotate(' + (BASE_ROT[k] + (state.rot180 ? 180 : 0)) + 'deg) scaleX(' + (state.flipX ? -1 : 1) + ')';
    });

    if (off.width !== px || off.height !== px) { off.width = px; off.height = px; }
  }

  /* ---------------- audio ---------------- */
  var audioCtx = null, analyser = null, micStream = null, micReady = false;
  var freqData = null, timeData = null;
  var level = 0, speaking = 0;

  var BARS = 72;
  var bars = new Float32Array(BARS);
  var WAVE = 96;
  var wave = new Float32Array(WAVE);

  function ensureAudioCtx() {
    if (audioCtx) return audioCtx;
    var AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    try { audioCtx = new AC(); } catch (e) { audioCtx = null; }
    return audioCtx;
  }

  function startMic() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      return Promise.reject(new Error('unsupported'));
    }
    return navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false }
    }).then(function (stream) {
      micStream = stream;
      var ctx = ensureAudioCtx();
      if (!ctx) throw new Error('no-audio-context');
      audioCtx = ctx;
      var p = ctx.resume ? ctx.resume() : Promise.resolve();
      return Promise.resolve(p).then(function () {
        var src = ctx.createMediaStreamSource(stream);
        analyser = ctx.createAnalyser();
        analyser.fftSize = 1024;
        analyser.smoothingTimeConstant = 0.72;
        src.connect(analyser);
        freqData = new Uint8Array(analyser.frequencyBinCount);
        timeData = new Uint8Array(analyser.fftSize);
        micReady = true;
      });
    });
  }

  function stopMic() {
    micReady = false;
    analyser = null;
    freqData = null;
    timeData = null;
    if (micStream) {
      try { micStream.getTracks().forEach(function (t) { t.stop(); }); } catch (e) { }
      micStream = null;
    }
    if (audioCtx) {
      try { audioCtx.close(); } catch (e) { }
      audioCtx = null;
    }
    level = 0;
  }

  function toggleMic() {
    if (micReady) {
      stopMic();
      updateUI();
      toast('마이크 꺼짐 · 아이들 모드');
      return;
    }
    toast('마이크 권한을 확인하는 중…');
    // iOS는 사용자 제스처 안에서 AudioContext를 만들어야 소리가 열린다
    var ctx = ensureAudioCtx();
    if (ctx && ctx.resume) { try { ctx.resume(); } catch (e) { } }
    startMic().then(function () {
      updateUI();
      toast('마이크 켜짐 · 말해보세요 🎙');
    }).catch(function (err) {
      stopMic();
      updateUI();
      toast('마이크를 쓸 수 없어요 · 아이들 모드로 재생');
      try { console.warn('[pickle] mic', err && err.name); } catch (e) { }
    });
  }

  function updateAudio(now, dt) {
    if (micReady && analyser) {
      analyser.getByteTimeDomainData(timeData);
      analyser.getByteFrequencyData(freqData);

      var sum = 0, i;
      for (i = 0; i < timeData.length; i++) {
        var v = (timeData[i] - 128) / 128;
        sum += v * v;
      }
      var rms = Math.sqrt(sum / timeData.length);
      var target = clamp((rms - 0.010) * 5.4, 0, 1);
      level = lerp(level, target, target > level ? 0.42 : 0.10);
      // 무음이어도 코어가 완전히 꺼지지 않게 최소 호흡만 남긴다
      var floor = 0.030 + 0.018 * (0.5 + 0.5 * Math.sin(now * 1.15));
      if (level < floor) level = floor;

      var n = freqData.length;
      for (i = 0; i < BARS; i++) {
        var idx = Math.floor(Math.pow(i / BARS, 1.45) * (n * 0.60));
        var b = Math.pow(freqData[idx] / 255, 1.35);
        bars[i] = lerp(bars[i], b, b > bars[i] ? 0.55 : 0.14);
      }
      for (i = 0; i < WAVE; i++) {
        var ti = Math.floor(i / WAVE * timeData.length);
        var wv = clamp((timeData[ti] - 128) / 128 * 2.2, -1, 1) * 0.5 + 0.5;
        wave[i] = lerp(wave[i], wv, 0.35);
      }
    } else {
      var idle = 0.052
        + 0.030 * (0.5 + 0.5 * Math.sin(now * 1.18))
        + 0.018 * (0.5 + 0.5 * Math.sin(now * 0.61 + 1.7));
      level = lerp(level, idle, 0.05);
      for (var j = 0; j < BARS; j++) {
        var p = j / BARS;
        var ib = 0.11
          + 0.055 * (0.5 + 0.5 * Math.sin(now * 1.35 + p * TAU * 2.0))
          + 0.030 * (0.5 + 0.5 * Math.sin(now * 0.72 - p * TAU * 3.0));
        bars[j] = lerp(bars[j], ib, 0.06);
      }
      for (var q = 0; q < WAVE; q++) {
        var pq = q / WAVE;
        var wi = 0.5 + 0.10 * Math.sin(now * 1.0 + pq * TAU * 2)
                     + 0.05 * Math.sin(now * 1.7 - pq * TAU * 3);
        wave[q] = lerp(wave[q], wi, 0.05);
      }
    }
    speaking = clamp((level - 0.15) / 0.30, 0, 1);
  }

  /* ---------------- blink ---------------- */
  var blinkNext = 2.5, blinkT = -1, blinkAmt = 1;

  function updateBlink(now, dt) {
    if (blinkT < 0) {
      blinkNext -= dt;
      if (blinkNext <= 0) { blinkT = 0; blinkNext = 2.2 + Math.random() * 3.6; }
      blinkAmt = 1;
    } else {
      blinkT += dt;
      var d = 0.16;
      if (blinkT >= d) { blinkT = -1; blinkAmt = 1; }
      else blinkAmt = Math.abs(1 - 2 * (blinkT / d));
    }
  }

  /* ---------------- text helper ---------------- */
  function txt(str, x, y, size, color, align, weight, mono) {
    octx.font = (weight || '700') + ' ' + size.toFixed(1) + 'px ' +
      (mono ? 'ui-monospace,"SF Mono",Menlo,monospace'
            : '-apple-system,"Apple SD Gothic Neo",system-ui,sans-serif');
    octx.fillStyle = color;
    octx.textAlign = align || 'center';
    octx.textBaseline = 'middle';
    octx.fillText(str, x, y);
  }

  /* ---------------- lime core rings ---------------- */
  function drawCore(cx, cy, u, now) {
    var o = octx, i, a, r;

    // aura
    var aura = o.createRadialGradient(cx, cy, u * 0.05, cx, cy, u * 0.62);
    aura.addColorStop(0, 'rgba(163,230,53,' + (0.13 + 0.30 * level).toFixed(3) + ')');
    aura.addColorStop(0.42, 'rgba(163,230,53,0.075)');
    aura.addColorStop(1, 'rgba(163,230,53,0)');
    o.fillStyle = aura;
    o.beginPath(); o.arc(cx, cy, u * 0.62, 0, TAU); o.fill();

    // spectrum bars
    var r0 = u * 0.340;
    o.lineCap = 'round';
    for (i = 0; i < BARS; i++) {
      a = (i / BARS) * TAU - Math.PI / 2;
      var len = u * (0.010 + 0.100 * bars[i]);
      o.beginPath();
      o.moveTo(cx + Math.cos(a) * r0, cy + Math.sin(a) * r0);
      o.lineTo(cx + Math.cos(a) * (r0 + len), cy + Math.sin(a) * (r0 + len));
      o.lineWidth = u * 0.011;
      o.strokeStyle = 'rgba(163,230,53,' + (0.20 + 0.62 * bars[i]).toFixed(3) + ')';
      o.stroke();
    }

    // waveform ring
    var rW = u * 0.442, amp = u * 0.024 * (0.45 + level);
    o.beginPath();
    for (i = 0; i <= WAVE; i++) {
      var k = i % WAVE;
      var ang = (k / WAVE) * TAU - Math.PI / 2;
      r = rW + (wave[k] - 0.5) * 2 * amp;
      if (i === 0) o.moveTo(cx + Math.cos(ang) * r, cy + Math.sin(ang) * r);
      else o.lineTo(cx + Math.cos(ang) * r, cy + Math.sin(ang) * r);
    }
    o.closePath();
    o.lineWidth = u * 0.006;
    o.strokeStyle = 'rgba(217,249,157,0.42)';
    o.stroke();

    // thin guide circle
    o.beginPath(); o.arc(cx, cy, r0 - u * 0.012, 0, TAU);
    o.lineWidth = 1; o.strokeStyle = 'rgba(163,230,53,0.14)'; o.stroke();

    // rotating arcs
    var arcs = [
      { r: u * 0.306, span: 0.85, spd: 0.55, al: 0.30 },
      { r: u * 0.286, span: 0.42, spd: -0.92, al: 0.20 },
      { r: u * 0.326, span: 1.30, spd: 0.31, al: 0.13 }
    ];
    for (i = 0; i < arcs.length; i++) {
      var ar = arcs[i];
      var st = now * ar.spd + i * 2.1;
      o.beginPath();
      o.arc(cx, cy, ar.r, st, st + ar.span);
      o.lineWidth = u * 0.008;
      o.strokeStyle = 'rgba(163,230,53,' + (ar.al * (0.5 + 0.9 * level)).toFixed(3) + ')';
      o.stroke();
    }

    // cardinal ticks
    for (i = 0; i < 4; i++) {
      var ta = i * Math.PI / 2 + now * 0.12;
      o.beginPath();
      o.moveTo(cx + Math.cos(ta) * u * 0.402, cy + Math.sin(ta) * u * 0.402);
      o.lineTo(cx + Math.cos(ta) * u * 0.428, cy + Math.sin(ta) * u * 0.428);
      o.lineWidth = 1.2;
      o.strokeStyle = 'rgba(217,249,157,0.30)';
      o.stroke();
    }
  }

  /* ---------------- pickle ---------------- */
  function drawFeather(x, y, r, rot) {
    var o = octx;
    o.save();
    o.translate(x, y);
    o.rotate(rot);
    o.globalAlpha = 0.82;
    var strands = [[-0.44, 0.60], [-0.06, 0.96], [0.36, 0.68]];
    for (var i = 0; i < strands.length; i++) {
      var a = strands[i][0], len = strands[i][1];
      o.save();
      o.rotate(a);
      var g = o.createLinearGradient(0, 0, r * len, 0);
      g.addColorStop(0, 'rgba(244,255,222,0.96)');
      g.addColorStop(0.55, PALE);
      g.addColorStop(1, 'rgba(163,230,53,0.70)');
      o.fillStyle = g;
      o.strokeStyle = 'rgba(163,230,53,0.50)';
      o.lineWidth = Math.max(0.5, r * 0.017);
      o.beginPath();
      o.ellipse(r * len * 0.5, 0, r * len * 0.5, r * 0.088, 0, 0, TAU);
      o.fill(); o.stroke();
      o.restore();
    }
    o.restore();
  }

  function drawPickle(cx, cy, r, now) {
    var o = octx;
    o.save();
    o.translate(cx, cy);

    // breathing + talking bounce
    var breath = 1 + 0.020 * Math.sin(now * 1.85);
    var talk = 1 + 0.045 * speaking * Math.sin(now * 12.0);
    var sy = breath * talk;
    var sx = 1 / sy;
    o.scale(sx, sy);

    // bloom
    var bloom = o.createRadialGradient(0, 0, r * 0.2, 0, 0, r * 2.3);
    bloom.addColorStop(0, 'rgba(255,255,255,' + (0.10 + 0.18 * level).toFixed(3) + ')');
    bloom.addColorStop(0.45, 'rgba(163,230,53,0.075)');
    bloom.addColorStop(1, 'rgba(163,230,53,0)');
    o.fillStyle = bloom;
    o.beginPath(); o.arc(0, 0, r * 2.3, 0, TAU); o.fill();

    // tail (behind body, 짧은 꼬리 — 옆구리 위쪽으로)
    o.save();
    o.translate(-r * 0.80, r * 0.06);
    o.rotate(-0.30);
    o.fillStyle = 'rgba(217,249,157,0.9)';
    o.beginPath(); o.ellipse(-r * 0.10, 0, r * 0.16, r * 0.062, 0, 0, TAU); o.fill();
    o.strokeStyle = 'rgba(120,165,55,0.40)';
    o.lineWidth = Math.max(0.5, r * 0.015);
    o.stroke();
    o.restore();

    // 3쌍의 짧은 다리 (몸 아래쪽에 마디가 보이는 형태로)
    var lw = Math.max(2.0, r * 0.074);
    var legs = [
      { a: 15, l1: 0.135, l2: 0.090, big: true },   // 앞다리 = 앞손
      { a: 33, l1: 0.125, l2: 0.082, big: false },
      { a: 51, l1: 0.110, l2: 0.075, big: false }
    ];
    o.lineCap = 'round';
    o.lineJoin = 'round';
    for (var gi = 0; gi < legs.length; gi++) {
      var g = legs[gi];
      var sig = g.a * Math.PI / 180;
      for (var sd = -1; sd <= 1; sd += 2) {
        var ax = sd * r * 0.84 * Math.sin(sig);
        var ay = r * 0.96 * Math.cos(sig);
        var wig = Math.sin(now * 2.0 + gi * 0.9 + (sd > 0 ? 0.7 : 0)) * 0.04;

        var x1 = ax + sd * Math.sin(sig) * r * g.l1;
        var y1 = ay + Math.cos(sig) * r * g.l1;

        var sig2 = sig * 0.30 + wig;
        var x2 = x1 + sd * Math.sin(sig2) * r * g.l2;
        var y2 = y1 + Math.cos(sig2) * r * g.l2;

        o.beginPath();
        o.moveTo(ax, ay);
        o.lineTo(x1, y1);
        o.lineTo(x2, y2);
        o.lineWidth = lw + Math.max(1.3, r * 0.042);
        o.strokeStyle = 'rgba(88,132,38,0.34)';
        o.stroke();
        o.lineWidth = lw;
        o.strokeStyle = '#cbe97f';
        o.stroke();

        // 마디(관절) 점
        o.beginPath();
        o.arc(x1, y1, lw * 0.46, 0, TAU);
        o.fillStyle = '#ecffc9';
        o.fill();

        // 발
        o.beginPath();
        o.arc(x2, y2, lw * (g.big ? 0.86 : 0.66), 0, TAU);
        o.fillStyle = g.big ? '#eaffc8' : '#d5ef96';
        o.fill();
        o.lineWidth = Math.max(0.5, lw * 0.22);
        o.strokeStyle = 'rgba(88,132,38,0.40)';
        o.stroke();
      }
    }

    // feather ears (양옆 깃털 귀 — 다리와 구분되도록 위쪽으로 길게)
    drawFeather(r * 0.58, -r * 0.62, r * 1.05, -1.02);
    drawFeather(-r * 0.58, -r * 0.62, r * 1.05, Math.PI + 1.02);

    // body (white, 살짝 긴 둥근 몸통)
    var body = o.createRadialGradient(-r * 0.28, -r * 0.40, r * 0.10, 0, 0, r * 1.18);
    body.addColorStop(0, '#FFFFFF');
    body.addColorStop(0.42, '#FBFDF6');
    body.addColorStop(0.78, '#EEF4E4');
    body.addColorStop(1, '#DEE9CF');
    o.fillStyle = body;
    o.beginPath(); o.ellipse(0, 0, r * 0.88, r * 1.0, 0, 0, TAU); o.fill();

    // lime rim light
    o.lineWidth = Math.max(1.0, r * 0.048);
    o.strokeStyle = 'rgba(163,230,53,' + (0.34 + 0.30 * level).toFixed(3) + ')';
    o.beginPath(); o.ellipse(0, 0, r * 0.865, r * 0.985, 0, 0, TAU); o.stroke();

    // soft inner shade at the foot of the body
    var foot = o.createRadialGradient(0, r * 0.72, r * 0.05, 0, r * 0.72, r * 0.62);
    foot.addColorStop(0, 'rgba(163,230,53,0.10)');
    foot.addColorStop(1, 'rgba(163,230,53,0)');
    o.fillStyle = foot;
    o.beginPath(); o.ellipse(0, r * 0.72, r * 0.62, r * 0.42, 0, 0, TAU); o.fill();

    // specular
    o.fillStyle = 'rgba(255,255,255,0.60)';
    o.beginPath(); o.ellipse(-r * 0.30, -r * 0.52, r * 0.21, r * 0.13, -0.5, 0, TAU); o.fill();

    // eyes
    var eyeDX = r * 0.305, eyeY = -r * 0.16;
    var eyeRy = r * 0.305 * (0.10 + 0.90 * blinkAmt) * (1 - 0.18 * speaking);
    [-1, 1].forEach(function (s) {
      var ex = s * eyeDX;
      o.fillStyle = '#FFFFFF';
      o.beginPath(); o.ellipse(ex, eyeY, r * 0.245, Math.max(eyeRy, r * 0.028), 0, 0, TAU); o.fill();
      o.lineWidth = Math.max(0.7, r * 0.022);
      o.strokeStyle = 'rgba(120,150,70,0.45)';
      o.stroke();
      if (blinkAmt > 0.35) {
        o.fillStyle = '#101C2A';
        o.beginPath();
        o.ellipse(ex + Math.sin(now * 0.9) * r * 0.012, eyeY + r * 0.02, r * 0.128,
          Math.min(r * 0.128, eyeRy * 0.80), 0, 0, TAU);
        o.fill();
        o.fillStyle = 'rgba(255,255,255,0.95)';
        o.beginPath(); o.arc(ex - r * 0.045, eyeY - r * 0.035, r * 0.040, 0, TAU); o.fill();
      }
    });

    // mouth (pale lime lips)
    var lipY = r * 0.445;
    var open = 0.02 + 0.34 * speaking;
    o.fillStyle = PALE;
    o.beginPath(); o.ellipse(0, lipY, r * 0.250, r * 0.115, 0, 0, TAU); o.fill();
    o.fillStyle = '#131c07';
    o.beginPath(); o.ellipse(0, lipY - r * 0.005, r * 0.158, r * (0.022 + open * 0.50), 0, 0, TAU); o.fill();
    o.strokeStyle = 'rgba(150,200,80,0.45)';
    o.lineWidth = Math.max(0.6, r * 0.016);
    o.beginPath(); o.ellipse(0, lipY, r * 0.250, r * 0.115, 0, 0, TAU); o.stroke();

    o.restore();
  }

  /* ---------------- modes ---------------- */
  function drawPickleMode(cx, cy, u, now) {
    drawCore(cx, cy, u, now);
    drawPickle(cx, cy - u * 0.02, u * 0.198, now);
  }

  var KST_FMT = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Seoul',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
  });
  var WD = ['일', '월', '화', '수', '목', '금', '토'];

  function kstNow() {
    var o = {};
    KST_FMT.formatToParts(new Date()).forEach(function (p) { o[p.type] = p.value; });
    var y = +o.year, m = +o.month, d = +o.day;
    var hh = (+o.hour) % 24, mm = +o.minute, ss = +o.second;
    var wdIdx = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
    return { y: y, m: m, d: d, hh: hh, mm: mm, ss: ss, wd: wdIdx };
  }

  function ddLabel(diff) {
    if (diff > 0) return 'D-' + diff;
    if (diff === 0) return 'D-DAY';
    return 'D+' + (-diff);
  }

  function dayDiff(t, ty, tm, td) {
    return Math.round((Date.UTC(ty, tm - 1, td) - Date.UTC(t.y, t.m - 1, t.d)) / 86400000);
  }

  function pad2(n) { return n < 10 ? '0' + n : '' + n; }

  function hudFrame(cx, cy, u) {
    var o = octx, i;
    var s = u * 0.5, b = u * 0.052;
    o.lineWidth = 1;
    o.strokeStyle = 'rgba(163,230,53,0.22)';
    for (i = 0; i < 4; i++) {
      var sx = i < 2 ? -1 : 1;
      var sy = (i % 2 === 0) ? -1 : 1;
      var x = cx + sx * (s - b);
      var y = cy + sy * (s - b);
      o.beginPath();
      o.moveTo(x - sx * b * 0.9, y);
      o.lineTo(x, y);
      o.lineTo(x, y - sy * b * 0.9);
      o.stroke();
    }
  }

  function drawDDayMode(cx, cy, u, now) {
    var t = kstNow();
    var examDiff = dayDiff(t, 2026, 12, 8);
    var sunDiff = dayDiff(t, 2027, 11, 18);

    hudFrame(cx, cy, u);

    // clock
    txt(pad2(t.hh) + ':' + pad2(t.mm) + ':' + pad2(t.ss),
        cx, cy - u * 0.355, u * 0.125, '#eaffc8', 'center', '700', true);
    txt(t.m + '월 ' + t.d + '일 ' + WD[t.wd] + '요일',
        cx, cy - u * 0.262, u * 0.055, 'rgba(217,249,157,0.55)', 'center', '600');

    // divider
    octx.beginPath();
    octx.moveTo(cx - u * 0.24, cy - u * 0.205);
    octx.lineTo(cx + u * 0.24, cy - u * 0.205);
    octx.lineWidth = 1;
    octx.strokeStyle = 'rgba(163,230,53,0.20)';
    octx.stroke();

    txt('2학기 기말고사', cx, cy - u * 0.140, u * 0.058, 'rgba(217,249,157,0.72)', 'center', '600');

    var pulse = 0.82 + 0.18 * (0.5 + 0.5 * Math.sin(now * 2.0));
    octx.save();
    octx.shadowColor = 'rgba(163,230,53,0.75)';
    octx.shadowBlur = u * 0.14;
    txt(ddLabel(examDiff), cx, cy + u * 0.030, u * 0.250, 'rgba(198,244,110,' + pulse.toFixed(3) + ')', 'center', '800', true);
    octx.restore();

    txt('12.08 화 08:30 미적분Ⅰ', cx, cy + u * 0.180, u * 0.050, 'rgba(217,249,157,0.50)', 'center', '500');

    // suneung
    octx.beginPath();
    octx.moveTo(cx - u * 0.24, cy + u * 0.235);
    octx.lineTo(cx + u * 0.24, cy + u * 0.235);
    octx.lineWidth = 1;
    octx.strokeStyle = 'rgba(163,230,53,0.20)';
    octx.stroke();

    txt('수능 ' + ddLabel(sunDiff), cx, cy + u * 0.325, u * 0.100, 'rgba(217,249,157,0.80)', 'center', '700', true);
    txt('2027.11.18', cx, cy + u * 0.412, u * 0.046, 'rgba(217,249,157,0.38)', 'center', '500', true);
  }

  function fmtClock(sec) {
    sec = Math.max(0, Math.floor(sec));
    var m = Math.floor(sec / 60), s = sec % 60;
    return pad2(m) + ':' + pad2(s);
  }

  function drawTimerMode(cx, cy, u, now) {
    hudFrame(cx, cy, u);

    var isPomo = timer.kind === 'pomo';
    var main = isPomo ? timer.remaining : timer.elapsed;
    var prog = isPomo ? (1 - timer.remaining / POMO) : ((timer.elapsed % 1500) / 1500);
    var done = isPomo && timer.done;

    // progress ring
    var R = u * 0.415;
    octx.beginPath(); octx.arc(cx, cy, R, 0, TAU);
    octx.lineWidth = u * 0.011; octx.strokeStyle = 'rgba(163,230,53,0.13)'; octx.stroke();

    octx.beginPath();
    octx.arc(cx, cy, R, -Math.PI / 2, -Math.PI / 2 + TAU * clamp(prog, 0, 1));
    octx.lineWidth = u * 0.013;
    octx.lineCap = 'round';
    octx.strokeStyle = done ? 'rgba(217,249,157,' + (0.5 + 0.4 * Math.sin(now * 6)).toFixed(2) + ')' : 'rgba(163,230,53,0.85)';
    octx.stroke();

    // spinning tick
    if (timer.running) {
      var a = now * 1.6;
      octx.beginPath();
      octx.moveTo(cx + Math.cos(a) * (R + u * 0.018), cy + Math.sin(a) * (R + u * 0.018));
      octx.lineTo(cx + Math.cos(a) * (R + u * 0.052), cy + Math.sin(a) * (R + u * 0.052));
      octx.lineWidth = u * 0.012;
      octx.strokeStyle = 'rgba(217,249,157,0.8)';
      octx.stroke();
    }

    txt(isPomo ? '뽀모도로 25분' : '스톱워치', cx, cy - u * 0.245, u * 0.070, 'rgba(217,249,157,0.62)', 'center', '600');

    var label = done ? 'DONE' : fmtClock(main);
    var size = done ? u * 0.20 : u * (isPomo ? 0.275 : 0.245);
    octx.save();
    octx.shadowColor = 'rgba(163,230,53,0.6)';
    octx.shadowBlur = u * 0.12;
    txt(label, cx, cy + u * 0.005, size, '#f2ffd6', 'center', '800', true);
    octx.restore();

    var status = done ? '25분 완료 · 쉬어가요' : (timer.running ? (isPomo ? '집중 중' : '기록 중') : (main === (isPomo ? POMO : 0) ? '준비' : '일시정지'));
    txt(status, cx, cy + u * 0.275, u * 0.062, timer.running ? 'rgba(198,244,110,0.9)' : 'rgba(217,249,157,0.5)', 'center', '600');

    if (timer.running) {
      var dot = 0.5 + 0.5 * Math.sin(now * 3.4);
      octx.beginPath();
      octx.arc(cx - u * 0.075, cy + u * 0.345, u * 0.018, 0, TAU);
      octx.fillStyle = 'rgba(163,230,53,' + (0.25 + 0.65 * dot).toFixed(2) + ')';
      octx.fill();
    }
  }

  /* ---------------- reflector (반사판 / Pepper's ghost) ---------------- */
  function sheetTimerText() {
    return timer.kind === 'pomo' ? fmtClock(timer.remaining) : fmtClock(timer.elapsed);
  }

  function sheetStatus() {
    if (timer.kind === 'pomo' && timer.done) return '25분 완료 · 쉬어가요';
    if (timer.running) return timer.kind === 'pomo' ? '집중 중' : '기록 중';
    if (timer.kind === 'pomo' && timer.remaining >= POMO) return '타이머 준비';
    if (timer.kind === 'stop' && timer.elapsed === 0) return '스톱워치 준비';
    return '일시정지';
  }

  function drawSheet(W, H, now) {
    var u = Math.min(W, H);
    var t = kstNow();
    var examDiff = dayDiff(t, 2026, 12, 8);
    var sunDiff = dayDiff(t, 2027, 11, 18);
    var wide = W > H * 1.15;
    var pulse = 0.84 + 0.16 * (0.5 + 0.5 * Math.sin(now * 2.0));

    if (!wide) {
      /* --- 세로: D-DAY → 피클 코어 → 타이머 --- */
      txt(pad2(t.hh) + ':' + pad2(t.mm) + ':' + pad2(t.ss), W / 2, H * 0.078, u * 0.070, '#eaffc8', 'center', '700', true);
      txt(t.m + '월 ' + t.d + '일 ' + WD[t.wd] + '요일', W / 2, H * 0.128, u * 0.035, 'rgba(217,249,157,0.52)', 'center', '600');

      txt('2학기 기말고사', W / 2, H * 0.180, u * 0.040, 'rgba(217,249,157,0.72)', 'center', '600');
      octx.save();
      octx.shadowColor = 'rgba(163,230,53,0.80)'; octx.shadowBlur = u * 0.09;
      txt(ddLabel(examDiff), W / 2, H * 0.242, u * 0.125, 'rgba(198,244,110,' + pulse.toFixed(3) + ')', 'center', '800', true);
      octx.restore();
      txt('수능 ' + ddLabel(sunDiff) + '  ·  2027.11.18', W / 2, H * 0.312, u * 0.042, 'rgba(217,249,157,0.70)', 'center', '600', true);

      var coreU = Math.min(W * 0.94, H * 0.42);
      drawCore(W / 2, H * 0.525, coreU, now);
      drawPickle(W / 2, H * 0.505, coreU * 0.198, now);

      txt(timer.kind === 'pomo' ? '뽀모도로 25분' : '스톱워치', W / 2, H * 0.780, u * 0.034, 'rgba(217,249,157,0.55)', 'center', '600');
      octx.save();
      octx.shadowColor = 'rgba(163,230,53,0.55)'; octx.shadowBlur = u * 0.07;
      txt(sheetTimerText(), W / 2, H * 0.850, u * 0.110, '#f2ffd6', 'center', '800', true);
      octx.restore();
      txt(sheetStatus(), W / 2, H * 0.918, u * 0.030, 'rgba(217,249,157,0.50)', 'center', '600');
    } else {
      /* --- 가로: 피클 코어 | D-DAY + 타이머 --- */
      var coreU2 = Math.min(W * 0.44, H * 0.86);
      var lx = W * 0.27, ly = H * 0.50;
      drawCore(lx, ly, coreU2, now);
      drawPickle(lx, ly - coreU2 * 0.02, coreU2 * 0.198, now);

      var rx = W * 0.72;
      txt(pad2(t.hh) + ':' + pad2(t.mm) + ':' + pad2(t.ss), rx, H * 0.095, u * 0.072, '#eaffc8', 'center', '700', true);
      txt(t.m + '월 ' + t.d + '일 ' + WD[t.wd] + '요일', rx, H * 0.160, u * 0.034, 'rgba(217,249,157,0.52)', 'center', '600');

      txt('2학기 기말고사', rx, H * 0.235, u * 0.038, 'rgba(217,249,157,0.72)', 'center', '600');
      octx.save();
      octx.shadowColor = 'rgba(163,230,53,0.80)'; octx.shadowBlur = u * 0.09;
      txt(ddLabel(examDiff), rx, H * 0.330, u * 0.135, 'rgba(198,244,110,' + pulse.toFixed(3) + ')', 'center', '800', true);
      octx.restore();
      txt('12.08 화 08:30 미적분Ⅰ', rx, H * 0.420, u * 0.030, 'rgba(217,249,157,0.48)', 'center', '500');

      txt('수능 ' + ddLabel(sunDiff) + '  ·  2027.11.18', rx, H * 0.495, u * 0.042, 'rgba(217,249,157,0.70)', 'center', '600', true);

      octx.beginPath();
      octx.moveTo(rx - u * 0.22, H * 0.560);
      octx.lineTo(rx + u * 0.22, H * 0.560);
      octx.lineWidth = 1; octx.strokeStyle = 'rgba(163,230,53,0.18)'; octx.stroke();

      txt(timer.kind === 'pomo' ? '뽀모도로 25분' : '스톱워치', rx, H * 0.640, u * 0.032, 'rgba(217,249,157,0.55)', 'center', '600');
      octx.save();
      octx.shadowColor = 'rgba(163,230,53,0.55)'; octx.shadowBlur = u * 0.07;
      txt(sheetTimerText(), rx, H * 0.740, u * 0.105, '#f2ffd6', 'center', '800', true);
      octx.restore();
      txt(sheetStatus(), rx, H * 0.830, u * 0.028, 'rgba(217,249,157,0.50)', 'center', '600');
    }
  }

  /* ---------------- render ---------------- */
  function render(now) {
    if (state.mode === 'sheet') {
      if (off.width !== sheetEl.width || off.height !== sheetEl.height) {
        off.width = sheetEl.width; off.height = sheetEl.height;
      }
      octx.setTransform(DPR, 0, 0, DPR, 0, 0);
      octx.clearRect(0, 0, sheetW, sheetH);
      drawSheet(sheetW, sheetH, now);
      sheetCtx.setTransform(1, 0, 0, 1, 0, 0);
      sheetCtx.clearRect(0, 0, off.width, off.height);
      sheetCtx.drawImage(off, 0, 0);
      return;
    }

    var W = P, H = P, u = Math.min(W, H);
    var cx = W / 2, cy = H / 2;

    octx.setTransform(DPR, 0, 0, DPR, 0, 0);
    octx.clearRect(0, 0, W, H);
    octx.save();
    octx.translate(cx, cy);
    octx.scale(state.sizeScale, state.sizeScale);
    octx.translate(-cx, -cy);

    if (state.mode === 'dday') drawDDayMode(cx, cy, u, now);
    else if (state.mode === 'timer') drawTimerMode(cx, cy, u, now);
    else drawPickleMode(cx, cy, u, now);

    octx.restore();

    for (var i = 0; i < CANVAS_KEYS.length; i++) {
      var k = CANVAS_KEYS[i];
      var c = ctxs[k];
      c.setTransform(1, 0, 0, 1, 0, 0);
      c.clearRect(0, 0, px, px);
      c.drawImage(off, 0, 0);
    }
  }

  /* ---------------- loop ---------------- */
  var last = 0, t0 = 0, started = false;

  function frame(ts) {
    if (!started) { started = true; t0 = ts; last = ts; }
    var dt = Math.min(0.1, (ts - last) / 1000);
    last = ts;
    var now = (ts - t0) / 1000;

    updateAudio(now, dt);
    updateBlink(now, dt);
    tickTimer(dt);
    render(now);
    requestAnimationFrame(frame);
  }

  function tickTimer(dt) {
    if (!timer.running) return;
    if (timer.kind === 'pomo') {
      timer.remaining -= dt;
      if (timer.remaining <= 0) {
        timer.remaining = 0;
        timer.running = false;
        timer.done = true;
        updateUI();
        toast('25분 완료! 5분 쉬고 다음 세트 🍋');
        beep();
      }
    } else {
      timer.elapsed += dt;
    }
  }

  function beep() {
    try {
      var AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      var ctx = new AC();
      var o = ctx.createOscillator(), g = ctx.createGain();
      o.type = 'sine';
      o.frequency.value = 880;
      g.gain.value = 0.0001;
      o.connect(g); g.connect(ctx.destination);
      var t = ctx.currentTime;
      g.gain.exponentialRampToValueAtTime(0.14, t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.5);
      o.start(t); o.stop(t + 0.55);
      o.onended = function () { try { ctx.close(); } catch (e) { } };
    } catch (e) { /* 무음 */ }
  }

  /* ---------------- UI ---------------- */
  var toastTimer = null;
  function toast(msg) {
    toastEl.textContent = msg;
    toastEl.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toastEl.classList.remove('show'); }, 2400);
  }

  function updateUI() {
    gapVal.textContent = Math.round(state.gapPct * 100) + '%';
    sizeVal.textContent = state.sizeScale.toFixed(2);

    Array.prototype.forEach.call(document.querySelectorAll('[data-act^="mode-"]'), function (b) {
      b.classList.toggle('on', b.getAttribute('data-act') === 'mode-' + state.mode);
    });
    document.querySelector('[data-act="flip"]').classList.toggle('on', state.flipX);
    document.querySelector('[data-act="rot180"]').classList.toggle('on', state.rot180);

    micBtn.classList.toggle('mic-on', micReady);
    micBtn.textContent = micReady ? '🎙 켜짐' : '🎙 마이크';

    document.querySelector('[data-act="kind-pomo"]').classList.toggle('on', timer.kind === 'pomo');
    document.querySelector('[data-act="kind-stop"]').classList.toggle('on', timer.kind === 'stop');
    tRun.textContent = timer.running ? '⏸ 일시정지' : (timer.kind === 'pomo' && timer.remaining < POMO && !timer.done ? '▶ 계속' : '▶ 시작');

    timerCtl.style.display = (state.mode === 'timer' || state.mode === 'sheet') ? '' : 'none';
    document.querySelector('[data-act="chrome"]').textContent = document.body.classList.contains('clean') ? '보이기' : '숨기기';
  }

  function setMode(m) {
    state.mode = m;
    save();
    document.body.classList.toggle('mode-sheet', m === 'sheet');
    layout();
    updateUI();
    if (m === 'timer' || m === 'sheet') hint.classList.add('gone');
    if (m === 'sheet') toast('화면 밝기 최대로 · 아크릴판을 45°로 세워주세요');
  }

  document.addEventListener('click', function (ev) {
    var btn = ev.target.closest ? ev.target.closest('[data-act]') : null;
    if (!btn) return;
    var act = btn.getAttribute('data-act');

    switch (act) {
      case 'mode-pickle': setMode('pickle'); break;
      case 'mode-dday': setMode('dday'); break;
      case 'mode-timer': setMode('timer'); break;
      case 'mode-sheet': setMode('sheet'); break;

      case 'gap-inc': state.gapPct = clamp(state.gapPct + 0.02, 0, 0.80); layout(); save(); updateUI(); break;
      case 'gap-dec': state.gapPct = clamp(state.gapPct - 0.02, 0, 0.80); layout(); save(); updateUI(); break;
      case 'size-inc': state.sizeScale = clamp(Math.round((state.sizeScale + 0.05) * 100) / 100, 0.55, 1.2); save(); updateUI(); break;
      case 'size-dec': state.sizeScale = clamp(Math.round((state.sizeScale - 0.05) * 100) / 100, 0.55, 1.2); save(); updateUI(); break;
      case 'flip': state.flipX = !state.flipX; layout(); save(); updateUI(); break;
      case 'rot180': state.rot180 = !state.rot180; layout(); save(); updateUI(); break;

      case 'mic': toggleMic(); break;

      case 'chrome':
        document.body.classList.toggle('clean');
        if (document.body.classList.contains('clean')) requestWakeLock(true);
        setTimeout(layout, 60);
        updateUI();
        break;

      case 'kind-pomo':
        timer.kind = 'pomo'; timer.running = false; timer.remaining = POMO; timer.done = false;
        updateUI(); break;
      case 'kind-stop':
        timer.kind = 'stop'; timer.running = false; timer.elapsed = 0; timer.done = false;
        updateUI(); break;
      case 't-run':
        if (timer.kind === 'pomo' && timer.done) { timer.remaining = POMO; timer.done = false; }
        timer.running = !timer.running;
        updateUI();
        break;
      case 't-reset':
        timer.running = false; timer.done = false; timer.elapsed = 0; timer.remaining = POMO;
        updateUI();
        break;
    }
  });

  /* ---------------- wake lock ---------------- */
  var wakeLock = null, wakeAsked = false;
  function requestWakeLock(fromGesture) {
    if (!('wakeLock' in navigator)) return;
    if (!document.hidden && !wakeLock) {
      navigator.wakeLock.request('screen').then(function (wl) {
        wakeLock = wl;
        wl.addEventListener('release', function () { wakeLock = null; });
      }).catch(function () { /* 무시 */ });
    }
    wakeAsked = true;
  }
  document.addEventListener('pointerdown', function () {
    if (!wakeAsked) requestWakeLock(true);
  }, { passive: true });
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden && wakeAsked) requestWakeLock(false);
  });

  /* ---------------- boot ---------------- */
  function fit() { layout(); }

  if (window.ResizeObserver) {
    new ResizeObserver(fit).observe(stageBox);
  }
  window.addEventListener('resize', fit);
  window.addEventListener('orientationchange', function () { setTimeout(fit, 120); });

  document.addEventListener('gesturestart', function (e) { e.preventDefault(); });
  document.addEventListener('dblclick', function (e) { e.preventDefault(); }, { passive: false });

  layout();
  updateUI();
  document.body.classList.toggle('mode-sheet', state.mode === 'sheet');
  if (state.mode === 'sheet') layout();
  requestAnimationFrame(frame);

  setTimeout(function () { hint.classList.add('gone'); }, 9000);

  // 탭 전환에서 돌아오면 시간 보정
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden) { last = performance.now(); }
  });
})();
