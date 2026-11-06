(function () {
  'use strict';
  var CFG = window.CAMPAIGN_CONFIG || {};
  var G = Object.assign({ duration: 60, lives: 5, penalty: 15, stormAt: 30, stormLength: 9 }, CFG.game || {});
  var $ = function (id) { return document.getElementById(id); };

  /* ---------- config-driven page bits ---------- */
  document.querySelectorAll('[data-link]').forEach(function (a) {
    var u = CFG.links && CFG.links[a.getAttribute('data-link')];
    if (u) a.href = u;
  });
  if (CFG.logoUrl) {
    document.querySelectorAll('[data-logo]').forEach(function (el) {
      el.textContent = '';
      el.classList.add('has-img');
      var im = document.createElement('img');
      im.src = CFG.logoUrl; im.alt = 'CORSAIR';
      el.appendChild(im);
    });
  }
  $('year').textContent = new Date().getFullYear();
  $('hTime').textContent = G.duration;

  /* ---------- how-to dialog ---------- */
  var dlg = $('howDlg');
  $('howBtn').addEventListener('click', function () {
    if (dlg.showModal) dlg.showModal(); else dlg.setAttribute('open', '');
  });
  $('howClose').addEventListener('click', function () { dlg.close ? dlg.close() : dlg.removeAttribute('open'); });

  /* ---------- canvas setup ---------- */
  var canvas = $('gameCanvas'), ctx = canvas.getContext('2d');
  var stage = $('stage');
  var W = 0, H = 0, dpr = 1;
  function resize() {
    var r = stage.getBoundingClientRect();
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    W = r.width; H = r.height;
    canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (S.px === undefined || S.px === null) S.px = W / 2;
    S.px = Math.max(padW() / 2, Math.min(W - padW() / 2, S.px));
  }
  function padW() { return Math.max(90, W * 0.24); }
  var PAD_H = 16;
  function padY() { return H - 46; }
  function boxW() { return Math.max(48, W * 0.14); }

  var imgs = {};
  function load(name, src) { var i = new Image(); i.src = src; imgs[name] = i; }
  load('real', 'assets/box-real.webp');
  load('fake', 'assets/box-fake.webp');
  load('plain', 'assets/box-plain.webp');
  load('logo', 'assets/logo.png');
  load('sticker', 'assets/sticker.webp');

  /* ---------- state ---------- */
  var S = { state: 'intro', px: null };
  var best = 0;
  try { best = +localStorage.getItem('corsairChallengeBest') || 0; } catch (e) {}
  var keys = { l: false, r: false };
  var items, floaters, particles, score, lives, time, combo, streak, bestCombo, caught, avoided, missedReal, spawnT, shake, flash, raf, last, storm, stormDone, banner;

  function reset() {
    items = []; floaters = []; particles = [];
    score = 0; lives = G.lives; time = G.duration; combo = 1; streak = 0; bestCombo = 0;
    caught = 0; avoided = 0; missedReal = 0; spawnT = 0.3; shake = 0; flash = 0; storm = 0; stormDone = false; banner = null;
    S.px = W / 2;
    hud();
  }

  function hud() {
    $('hScore').textContent = score;
    $('hTime').textContent = Math.max(0, Math.ceil(time));
    var h = ''; for (var i = 0; i < G.lives; i++) h += i < lives ? '♥' : '♡';
    $('hLives').textContent = h;
    $('hCombo').textContent = 'x' + combo;
  }

  /* ---------- audio (WebAudio, no files) ---------- */
  var actx = null, muted = false;
  try { muted = localStorage.getItem('corsairChallengeMuted') === '1'; } catch (e) {}
  function setMuteUI() {
    var b = $('muteBtn');
    b.textContent = muted ? '🔇' : '🔊';
    b.setAttribute('aria-pressed', muted);
    b.setAttribute('aria-label', muted ? 'Sound off' : 'Sound on');
  }
  setMuteUI();
  function beep(freq, dur, type, vol, slide) {
    if (muted) return;
    try {
      actx = actx || new (window.AudioContext || window.webkitAudioContext)();
      if (actx.state === 'suspended') actx.resume();
      var o = actx.createOscillator(), g = actx.createGain(), t = actx.currentTime;
      o.type = type || 'sine'; o.frequency.setValueAtTime(freq, t);
      if (slide) o.frequency.exponentialRampToValueAtTime(slide, t + dur);
      g.gain.setValueAtTime(vol || 0.08, t);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(g); g.connect(actx.destination); o.start(t); o.stop(t + dur);
    } catch (e) {}
  }
  var sfx = {
    good: function (c) { beep(520 + c * 60, 0.12, 'triangle', 0.09); },
    bad: function () { beep(220, 0.3, 'sawtooth', 0.09, 70); },
    dodge: function () { beep(880, 0.05, 'sine', 0.025); },
    end: function () { beep(660, 0.15, 'triangle', 0.09); setTimeout(function () { beep(440, 0.25, 'triangle', 0.09); }, 150); }
  };
  $('muteBtn').addEventListener('click', function () {
    muted = !muted; setMuteUI();
    try { localStorage.setItem('corsairChallengeMuted', muted ? '1' : '0'); } catch (e) {}
  });

  /* ---------- helpers ---------- */
  function say(t) { $('live').textContent = t; }
  function pop(x, y, text, color) { floaters.push({ x: x, y: y, t: 0, text: text, color: color }); }
  function burst(x, y, color, n) {
    for (var i = 0; i < n; i++) {
      var a = Math.random() * Math.PI * 2, s = 60 + Math.random() * 180;
      particles.push({ x: x, y: y, vx: Math.cos(a) * s, vy: Math.sin(a) * s - 60, t: 0, life: 0.5 + Math.random() * 0.3, c: color });
    }
  }

  /* ---------- spawn / difficulty ---------- */
  function difficulty() { return 1 - time / G.duration; } // 0 -> 1
  function spawn() {
    var d = difficulty(), inStorm = storm > 0;
    var bw = boxW(), bh = bw * 1.16;
    var real = Math.random() < (inStorm ? 0.88 : 0.5);
    var kind = real ? 'real' : (Math.random() < 0.5 ? 'fake' : 'plain');
    var w = kind === 'plain' ? bw * 0.78 : bw, h = kind === 'plain' ? bh * 1.05 : bh;
    var speed = H * (0.55 + 0.45 * d) * (inStorm ? 1.25 : 1) * (0.85 + Math.random() * 0.4);
    items.push({
      x: w / 2 + Math.random() * (W - w), y: -h, w: w, h: h, real: real, kind: kind,
      vy: speed, rot: (Math.random() - 0.5) * 0.4, vr: (Math.random() - 0.5) * 1.2
    });
    spawnT = inStorm ? 0.11 + Math.random() * 0.08 : Math.max(0.28, 0.72 - 0.42 * d) * (0.75 + Math.random() * 0.5);
  }

  /* ---------- update ---------- */
  function update(dt) {
    time -= dt;
    if (time <= 0) { time = 0; hud(); return end("TIME'S UP"); }

    if (!stormDone && time <= G.stormAt) {
      stormDone = true; storm = G.stormLength; spawnT = 0;
      banner = { text: 'STICKER STORM!', sub: 'DOUBLE POINTS', t: 0 };
      beep(440, 0.4, 'square', 0.06, 880); say('Sticker storm! Double points.');
    }
    if (storm > 0) { storm -= dt; if (storm <= 0) { storm = 0; say('Storm over.'); } }
    if (banner) { banner.t += dt; if (banner.t > 1.8) banner = null; }

    var kx = (keys.r ? 1 : 0) - (keys.l ? 1 : 0);
    if (kx) S.px += kx * W * 1.1 * dt;
    var half = padW() / 2;
    S.px = Math.max(half, Math.min(W - half, S.px));

    spawnT -= dt; if (spawnT <= 0) spawn();

    var py = padY();
    for (var i = items.length - 1; i >= 0; i--) {
      var it = items[i];
      it.y += it.vy * dt; it.rot += it.vr * dt;
      var bottom = it.y + it.h * 0.35;
      if (bottom >= py && bottom <= py + PAD_H + it.vy * dt + 6 && Math.abs(it.x - S.px) < half + it.w * 0.3) {
        items.splice(i, 1);
        if (it.real) {
          streak++; combo = Math.min(5, 1 + Math.floor(streak / 3));
          bestCombo = Math.max(bestCombo, streak);
          var pts = 10 * combo * (storm > 0 ? 2 : 1); score += pts; caught++;
          pop(it.x, py - 20, '+' + pts, '#2ee572'); burst(it.x, py, '#2ee572', 14); sfx.good(combo);
        } else {
          lives--; streak = 0; combo = 1; shake = 0.35; flash = 0.35;
          score = Math.max(0, score - G.penalty);
          pop(it.x, py - 20, '-' + G.penalty + ' UNOFFICIAL!', '#ff3b4e'); burst(it.x, py, '#ff3b4e', 18); sfx.bad();
          say('Unofficial box caught. ' + lives + ' lives left.');
          if (lives <= 0) { hud(); return end('OUT OF LIVES'); }
        }
        hud();
      } else if (it.y > H + it.h) {
        items.splice(i, 1);
        if (it.real) { missedReal++; streak = 0; combo = 1; hud(); } else { avoided++; sfx.dodge(); }
      }
    }
    for (i = floaters.length - 1; i >= 0; i--) { floaters[i].t += dt; floaters[i].y -= 40 * dt; if (floaters[i].t > 0.8) floaters.splice(i, 1); }
    for (i = particles.length - 1; i >= 0; i--) {
      var p = particles[i]; p.t += dt; p.x += p.vx * dt; p.y += p.vy * dt; p.vy += 420 * dt;
      if (p.t > p.life) particles.splice(i, 1);
    }
    if (shake > 0) shake -= dt; if (flash > 0) flash -= dt;
    $('hTime').textContent = Math.ceil(time);
  }

  /* ---------- draw ---------- */
  function draw() {
    ctx.save();
    ctx.clearRect(0, 0, W, H);
    if (shake > 0) ctx.translate((Math.random() - 0.5) * 10 * shake * 3, (Math.random() - 0.5) * 10 * shake * 3);

    var bg = ctx.createLinearGradient(0, 0, 0, H);
    bg.addColorStop(0, '#0b0b10'); bg.addColorStop(1, '#16161d');
    ctx.fillStyle = bg; ctx.fillRect(-20, -20, W + 40, H + 40);
    ctx.strokeStyle = 'rgba(255,212,0,.05)'; ctx.lineWidth = 1;
    var off = (performance.now() / 40) % 40;
    for (var gy = -40 + off; gy < H; gy += 40) { ctx.beginPath(); ctx.moveTo(0, gy); ctx.lineTo(W, gy); ctx.stroke(); }
    for (var gx = 0; gx < W; gx += 40) { ctx.beginPath(); ctx.moveTo(gx, 0); ctx.lineTo(gx, H); ctx.stroke(); }

    if (storm > 0) {
      var sg = ctx.createLinearGradient(0, 0, W, 0);
      ['#ff2a6d', '#ffd400', '#2ee572', '#05d9e8', '#7a5cff'].forEach(function (c, i) { sg.addColorStop(i / 4, c); });
      ctx.globalAlpha = 0.10 + 0.06 * Math.sin(performance.now() / 80); ctx.fillStyle = sg; ctx.fillRect(0, 0, W, H); ctx.globalAlpha = 1;
      ctx.fillStyle = '#ffd400'; ctx.font = '800 14px Barlow Condensed, Arial, sans-serif'; ctx.textAlign = 'center';
      ctx.fillText('STORM x2  ' + Math.ceil(storm) + 's', W / 2, 58);
    }
    // items
    items.forEach(function (it) {
      var im = imgs[it.kind];
      ctx.save(); ctx.translate(it.x, it.y); ctx.rotate(it.rot);
      if (im && im.complete && im.naturalWidth) ctx.drawImage(im, -it.w / 2, -it.h / 2, it.w, it.h);
      else { ctx.fillStyle = '#ffd400'; ctx.fillRect(-it.w / 2, -it.h / 2, it.w, it.h); }
      ctx.restore();
    });

    // scanner pad
    var pw = padW(), py = padY(), x0 = S.px - pw / 2;
    ctx.save();
    ctx.shadowColor = '#05d9e8'; ctx.shadowBlur = 18;
    var pg = ctx.createLinearGradient(x0, 0, x0 + pw, 0);
    ['#ff2a6d', '#ffd400', '#2ee572', '#05d9e8', '#7a5cff'].forEach(function (c, i) { pg.addColorStop(i / 4, c); });
    ctx.fillStyle = pg;
    roundRect(x0, py, pw, PAD_H, 8); ctx.fill();
    ctx.restore();
    ctx.fillStyle = 'rgba(5,217,232,.12)';
    ctx.beginPath(); ctx.moveTo(x0 + 6, py); ctx.lineTo(x0 + pw - 6, py); ctx.lineTo(x0 + pw + 14, py - 120); ctx.lineTo(x0 - 14, py - 120); ctx.closePath(); ctx.fill();
    ctx.fillStyle = '#000'; ctx.font = '800 11px Barlow Condensed, Arial, sans-serif'; ctx.textAlign = 'center';
    ctx.fillText('SCANNER', S.px, py + 12);

    particles.forEach(function (p) {
      ctx.globalAlpha = Math.max(0, 1 - p.t / p.life); ctx.fillStyle = p.c;
      ctx.fillRect(p.x - 2, p.y - 2, 4, 4);
    });
    ctx.globalAlpha = 1;
    ctx.font = '800 22px Barlow Condensed, Arial, sans-serif'; ctx.textAlign = 'center';
    floaters.forEach(function (f) {
      ctx.globalAlpha = Math.max(0, 1 - f.t / 0.8); ctx.fillStyle = f.color; ctx.fillText(f.text, f.x, f.y);
    });
    ctx.globalAlpha = 1;
    if (banner) {
      var k = banner.t / 1.8, sc = 1 + 0.25 * Math.max(0, 1 - banner.t * 5);
      ctx.save(); ctx.globalAlpha = k > 0.75 ? Math.max(0, (1 - k) / 0.25) : 1;
      ctx.translate(W / 2, H * 0.4); ctx.scale(sc, sc); ctx.textAlign = 'center';
      ctx.lineWidth = 6; ctx.strokeStyle = '#000'; ctx.fillStyle = '#ffd400';
      ctx.font = '800 ' + Math.round(W * 0.12) + 'px Barlow Condensed, Arial, sans-serif';
      ctx.strokeText(banner.text, 0, 0); ctx.fillText(banner.text, 0, 0);
      ctx.font = '800 ' + Math.round(W * 0.06) + 'px Barlow Condensed, Arial, sans-serif'; ctx.fillStyle = '#2ee572';
      ctx.strokeText(banner.sub, 0, W * 0.08); ctx.fillText(banner.sub, 0, W * 0.08);
      ctx.restore();
    }
    if (flash > 0) { ctx.fillStyle = 'rgba(255,59,78,' + (flash * 0.8) + ')'; ctx.fillRect(-20, -20, W + 40, H + 40); }
    ctx.restore();
  }
  function roundRect(x, y, w, h, r) {
    ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
  }

  /* ---------- loop / flow ---------- */
  function loop(ts) {
    if (S.state !== 'play') return;
    var dt = Math.min(0.05, (ts - last) / 1000); last = ts;
    update(dt);
    if (S.state === 'play') { draw(); raf = requestAnimationFrame(loop); }
  }
  function start() {
    reset();
    $('introOv').hidden = true; $('endOv').hidden = true; $('pauseOv').hidden = true;
    $('hud').removeAttribute('aria-hidden');
    S.state = 'play'; last = performance.now();
    fetchToken();
    say('Game started.');
    cancelAnimationFrame(raf); raf = requestAnimationFrame(loop);
  }
  function pause() {
    if (S.state !== 'play') return;
    S.state = 'pause'; $('pauseOv').hidden = false; $('resumeBtn').focus();
  }
  function resume() {
    if (S.state !== 'pause') return;
    $('pauseOv').hidden = true; S.state = 'play'; last = performance.now(); raf = requestAnimationFrame(loop);
  }
  function rankFor(sc) {
    var r = (CFG.ranks || [{ min: 0, title: 'PLAYER', message: '' }]).slice().sort(function (a, b) { return a.min - b.min; });
    var out = r[0]; r.forEach(function (x) { if (sc >= x.min) out = x; });
    return out;
  }
  function end(why) {
    S.state = 'end'; cancelAnimationFrame(raf); draw(); sfx.end();
    if (score > best) { best = score; try { localStorage.setItem('corsairChallengeBest', best); } catch (e) {} }
    var rk = rankFor(score), total = caught + missedReal + (G.lives - lives);
    $('endWhy').textContent = why;
    $('endScore').textContent = score;
    $('endRank').textContent = rk.title; $('endMsg').textContent = rk.message;
    $('sCaught').textContent = caught; $('sAvoided').textContent = avoided; $('sCombo').textContent = bestCombo;
    var offered = caught + missedReal;
    $('sAcc').textContent = (offered ? Math.round(caught / offered * 100) : 0) + '%';
    $('sBest').textContent = best;
    resetForm();
    result = { score: score, rank: rk.title, message: rk.message, caught: caught, avoided: avoided, combo: bestCombo, acc: $('sAcc').textContent };
    note('Tip: download the PNG to post on Instagram or Facebook stories.');
    $('endOv').hidden = false; $('againBtn').focus();
    say(why + ' Final score ' + score + '. ' + rk.title + '.');
  }


  /* ---------- sharing ---------- */
  var result = null;
  var SH = CFG.share || {};
  function shareUrl() { return SH.url || (location.origin + location.pathname); }
  function shareText() {
    return (SH.text || 'I scored {score} in the CORSAIR Authenticity Challenge!')
      .replace('{score}', result ? result.score : 0).replace('{rank}', result ? result.rank : '');
  }
  function note(t) { $('shareNote').textContent = t; }

  function drawBoard() {
    var cw = 1080, ch = 1350, c = document.createElement('canvas'); c.width = cw; c.height = ch;
    var x = c.getContext('2d');
    var F = function (w, px) { return w + ' ' + px + 'px "Barlow Condensed", "Arial Narrow", Impact, sans-serif'; };
    var bg = x.createLinearGradient(0, 0, 0, ch); bg.addColorStop(0, '#0b0b10'); bg.addColorStop(1, '#1a1a22');
    x.fillStyle = bg; x.fillRect(0, 0, cw, ch);
    var glow = x.createRadialGradient(cw * 0.8, 0, 0, cw * 0.8, 0, 700); glow.addColorStop(0, 'rgba(255,212,0,.22)'); glow.addColorStop(1, 'rgba(255,212,0,0)');
    x.fillStyle = glow; x.fillRect(0, 0, cw, ch);
    var rgb = x.createLinearGradient(0, 0, cw, 0);
    ['#ff2a6d', '#ffd400', '#2ee572', '#05d9e8', '#7a5cff'].forEach(function (col, i) { rgb.addColorStop(i / 4, col); });
    x.fillStyle = rgb; x.fillRect(0, 0, cw, 10); x.fillRect(0, ch - 10, cw, 10);
    x.textAlign = 'center';
    if (imgs.logo && imgs.logo.naturalWidth) { var lw = 520, lh = lw * imgs.logo.naturalHeight / imgs.logo.naturalWidth; x.drawImage(imgs.logo, (cw - lw) / 2, 70, lw, lh); }
    x.fillStyle = '#a8a8a8'; x.font = F(700, 34); x.fillText('A U T H E N T I C I T Y   C H A L L E N G E', cw / 2, 250);
    x.fillStyle = '#ffd400'; x.font = F(800, 340); x.fillText(String(result.score), cw / 2, 560);
    x.fillStyle = '#a8a8a8'; x.font = F(700, 36); x.fillText('POINTS', cw / 2, 612);
    x.fillStyle = '#fff'; x.font = F(800, 96); x.fillText(result.rank, cw / 2, 730);
    x.fillStyle = '#2ee572'; x.font = F(700, 38);
    wrap(x, result.message, cw / 2, 790, 820, 48);
    var st = [['REAL RAM CAUGHT', result.caught], ['UNOFFICIAL AVOIDED', result.avoided], ['BEST COMBO', result.combo], ['ACCURACY', result.acc]];
    st.forEach(function (s, i) {
      var bx = 90 + (i % 2) * 450, by = 880 + Math.floor(i / 2) * 150;
      x.fillStyle = 'rgba(255,255,255,.06)'; x.strokeStyle = '#2a2a2a'; x.lineWidth = 2;
      rr(x, bx, by, 410, 128, 14); x.fill(); x.stroke();
      x.textAlign = 'left'; x.fillStyle = '#a8a8a8'; x.font = F(700, 26); x.fillText(s[0], bx + 24, by + 44);
      x.fillStyle = '#fff'; x.font = F(800, 64); x.fillText(String(s[1]), bx + 24, by + 106);
    });
    x.textAlign = 'center';
    if (imgs.sticker && imgs.sticker.naturalWidth) { var sw = 120, sh = sw * imgs.sticker.naturalHeight / imgs.sticker.naturalWidth; x.drawImage(imgs.sticker, 90, 1195, sw, sh); }
    x.textAlign = 'left'; x.fillStyle = '#ffd400'; x.font = F(800, 38);
    x.fillText('BEFORE BUYING CORSAIR RAM,', 240, 1235); x.fillStyle = '#fff'; x.fillText('CHECK THE SMART WARRANTY STICKER', 240, 1282);
    x.textAlign = 'center'; x.fillStyle = '#777'; x.font = F(700, 26);
    x.fillText(shareUrl().replace(/^https?:\/\//, '') + '  ·  FAN MADE WEBSITE', cw / 2, 1328);
    return c;
  }
  function rr(x, a, b, w, h, r) { x.beginPath(); x.moveTo(a + r, b); x.arcTo(a + w, b, a + w, b + h, r); x.arcTo(a + w, b + h, a, b + h, r); x.arcTo(a, b + h, a, b, r); x.arcTo(a, b, a + w, b, r); x.closePath(); }
  function wrap(x, t, cx, y, maxW, lh) {
    var words = String(t).split(' '), line = '';
    words.forEach(function (w) {
      var test = line ? line + ' ' + w : w;
      if (x.measureText(test).width > maxW && line) { x.fillText(line, cx, y); y += lh; line = w; } else line = test;
    });
    x.fillText(line, cx, y);
  }
  function makeBlob() {
    var fonts = document.fonts && document.fonts.load ? Promise.all([document.fonts.load('800 40px "Barlow Condensed"'), document.fonts.load('700 40px "Barlow Condensed"')]).catch(function () {}) : Promise.resolve();
    return fonts.then(function () {
      var c = drawBoard();
      return new Promise(function (res) { c.toBlob(res, 'image/png'); });
    });
  }
  function download() {
    if (!result) return;
    makeBlob().then(function (b) {
      if (!b) return note('Could not create the image.');
      var a = document.createElement('a'); a.href = URL.createObjectURL(b); a.download = 'corsair-authenticity-score-' + result.score + '.png';
      document.body.appendChild(a); a.click(); a.remove(); setTimeout(function () { URL.revokeObjectURL(a.href); }, 2000);
      note('Scoreboard saved. Post it on Instagram, Facebook or anywhere you like!');
    });
  }
  function nativeShare() {
    if (!result) return;
    makeBlob().then(function (b) {
      var file = b && new File([b], 'corsair-score.png', { type: 'image/png' });
      var data = { title: 'CORSAIR Authenticity Challenge', text: shareText(), url: shareUrl() };
      if (file && navigator.canShare && navigator.canShare({ files: [file] })) data.files = [file];
      if (navigator.share) return navigator.share(data).catch(function () {});
      note('Sharing is not supported here. Use a button below or download the PNG.');
    });
  }
  function social(kind) {
    if (!result) return;
    var u = encodeURIComponent(shareUrl()), t = encodeURIComponent(shareText()), tags = (SH.hashtags || []).join(',');
    var link = {
      facebook: 'https://www.facebook.com/sharer/sharer.php?u=' + u + '&quote=' + t,
      whatsapp: 'https://wa.me/?text=' + encodeURIComponent(shareText() + ' ' + shareUrl()),
      x: 'https://twitter.com/intent/tweet?text=' + t + '&url=' + u + '&hashtags=' + encodeURIComponent(tags),
      telegram: 'https://t.me/share/url?url=' + u + '&text=' + t
    }[kind];
    if (kind === 'copy') {
      var txt = shareText() + ' ' + shareUrl() + (tags ? ' ' + tags.split(',').map(function (h) { return '#' + h; }).join(' ') : '');
      if (navigator.clipboard) navigator.clipboard.writeText(txt).then(function () { note('Text copied. Paste it with your PNG!'); }, function () { note(txt); });
      else note(txt);
      return;
    }
    window.open(link, '_blank', 'noopener,noreferrer,width=640,height=560');
    note('Tip: download the PNG and attach it to your post.');
  }
  $('shareBtn').addEventListener('click', nativeShare);
  $('dlBtn').addEventListener('click', download);
  document.querySelectorAll('[data-soc]').forEach(function (b) { b.addEventListener('click', function () { social(b.getAttribute('data-soc')); }); });
  if (!navigator.share) $('shareBtn').hidden = true;


  /* ---------- leaderboard ---------- */
  var roundToken = null, submitted = false, profile = {}, myKey = null;
  try { profile = JSON.parse(localStorage.getItem('corsairProfile') || '{}') || {}; } catch (e) {}
  function api(path, opt) {
    return fetch(path, opt).then(function (r) { return r.json().then(function (j) { if (!r.ok) throw new Error(j.error || 'Request failed'); return j; }); });
  }
  function fetchToken() {
    roundToken = null;
    api('/api/start').then(function (j) { roundToken = j.token; }).catch(function () {});
  }
  function trophy(fill, dark) {
    return '<svg viewBox="0 0 64 64" aria-hidden="true"><path d="M18 8h28v14c0 9-6 16-14 17-8-1-14-8-14-17V8z" fill="' + fill + '"/>' +
      '<path d="M18 12H8c0 9 4 15 11 17M46 12h10c0 9-4 15-11 17" fill="none" stroke="' + fill + '" stroke-width="4" stroke-linecap="round"/>' +
      '<rect x="28" y="38" width="8" height="8" fill="' + dark + '"/><rect x="20" y="46" width="24" height="6" rx="2" fill="' + fill + '"/>' +
      '<rect x="16" y="52" width="32" height="5" rx="2" fill="' + dark + '"/><path d="M32 13l2.4 5 5.4.7-4 3.7 1 5.3-4.8-2.6-4.8 2.6 1-5.3-4-3.7 5.4-.7z" fill="#fff" opacity=".85"/></svg>';
  }
  var TROPHY = { 1: trophy('#ffd400', '#b08a00'), 2: trophy('#d5dbe2', '#7d8791'), 3: trophy('#d98c4a', '#8a5122') };
  var STARS = { 1: '★★★', 2: '★★', 3: '★' };
  var lbPeriod = 'week', lbLoaded = {};
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function fmtLeft(ms) {
    var m = Math.max(0, Math.floor(ms / 60000)), d = Math.floor(m / 1440), h = Math.floor(m % 1440 / 60);
    return d ? d + 'd ' + h + 'h' : h + 'h ' + (m % 60) + 'm';
  }
  function renderBoard(data) {
    var pod = $('podium'), list = $('lbList'), empty = $('lbEmpty');
    pod.textContent = ''; list.textContent = '';
    var es = data.entries || [];
    $('lbMeta').textContent = data.period === 'week'
      ? 'Weekly leaderboard · resets in ' + fmtLeft(data.resetsAt - Date.now()) + ' (Mon, Bangladesh time)'
      : 'All-time best scores';
    [2, 1, 3].forEach(function (rank) {
      var e = es[rank - 1], p = el('div', 'pod r' + rank + (e ? '' : ' empty'));
      p.insertAdjacentHTML('beforeend', TROPHY[rank]);
      p.appendChild(el('div', 'stars', STARS[rank]));
      p.appendChild(el('div', 'place', rank === 1 ? '1ST' : rank === 2 ? '2ND' : '3RD'));
      p.appendChild(el('div', 'pname', e ? e.name : '—'));
      p.appendChild(el('div', 'pscore', e ? e.score : '0'));
      if (e) p.appendChild(el('div', 'psub', e.caught + ' caught · combo ' + e.combo));
      pod.appendChild(p);
    });
    es.slice(3).forEach(function (e, i) {
      var li = el('li'); li.appendChild(el('span', 'n', i + 4));
      var w = el('span', 'who', e.name); w.appendChild(el('small', null, '•••' + e.tail)); li.appendChild(w);
      li.appendChild(el('span', 'sc', e.score));
      if (myKey && e.name + '|' + e.tail === myKey) li.className = 'me';
      list.appendChild(li);
    });
    empty.hidden = es.length > 0;
    if (!es.length) empty.textContent = data.period === 'week' ? 'No scores yet this week — be the first!' : 'No scores yet — be the first!';
  }
  function loadBoard(period, force) {
    lbPeriod = period || lbPeriod;
    document.querySelectorAll('.tabs [role=tab]').forEach(function (t) { t.setAttribute('aria-selected', t.getAttribute('data-period') === lbPeriod); });
    if (lbLoaded[lbPeriod] && !force && Date.now() - lbLoaded[lbPeriod] < 15000) return;
    api('/api/leaderboard?period=' + lbPeriod).then(function (d) { lbLoaded[d.period] = Date.now(); if (d.period === lbPeriod) renderBoard(d); })
      .catch(function () { $('lbMeta').textContent = 'Leaderboard is unavailable right now.'; });
  }
  document.querySelectorAll('.tabs [role=tab]').forEach(function (t) {
    t.addEventListener('click', function () { loadBoard(t.getAttribute('data-period'), true); });
    t.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') { var o = document.querySelector('.tabs [role=tab]:not([aria-selected=true])'); o.focus(); o.click(); }
    });
  });
  loadBoard('week', true);
  if (window.IntersectionObserver) new IntersectionObserver(function (en) { if (en[0].isIntersecting) loadBoard(null, false); }, { threshold: 0.2 }).observe($('leaderboard'));

  function resetForm() {
    submitted = false;
    $('lbForm').hidden = false; $('lbDone').hidden = true;
    $('lbName').value = profile.name || ''; $('lbPhone').value = profile.phone || ''; $('lbConsent').checked = !!profile.consent;
    $('lbMsg').textContent = ''; $('lbMsg').className = 'lb-msg'; $('lbSubmit').disabled = false;
  }
  $('lbForm').addEventListener('submit', function (e) {
    e.preventDefault();
    if (!result || submitted) return;
    var msg = $('lbMsg'); msg.className = 'lb-msg';
    var name = $('lbName').value.trim(), phone = $('lbPhone').value.trim(), consent = $('lbConsent').checked;
    if (name.length < 2) { msg.textContent = 'Please enter your name.'; return $('lbName').focus(); }
    if (!/^(?:\+?88)?01[3-9]\d{8}$/.test(phone.replace(/[\s\-()]/g, ''))) { msg.textContent = 'Enter a valid mobile number, e.g. 01XXXXXXXXX.'; return $('lbPhone').focus(); }
    if (!consent) { msg.textContent = 'Please tick the consent box.'; return $('lbConsent').focus(); }
    if (!roundToken) { msg.textContent = 'Could not verify this round (offline?). Play again to submit.'; return; }
    $('lbSubmit').disabled = true; msg.textContent = 'Submitting…';
    api('/api/score', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: name, phone: phone, consent: true, token: roundToken, score: result.score, caught: result.caught, combo: result.combo }) })
      .then(function (r) {
        submitted = true; profile = { name: name, phone: phone, consent: true };
        try { localStorage.setItem('corsairProfile', JSON.stringify(profile)); } catch (e2) {}
        myKey = r.name + '|' + phone.replace(/\D/g, '').slice(-3);
        $('lbForm').hidden = true; $('lbDone').hidden = false;
        $('lbDoneTxt').textContent = 'Saved, ' + r.name + '! You are #' + r.weekRank + ' this week and #' + r.allRank + ' all time.';
        say('Score submitted. Rank ' + r.weekRank + ' this week.');
        loadBoard('week', true);
      })
      .catch(function (err) { $('lbSubmit').disabled = false; msg.textContent = err.message || 'Could not submit. Try again.'; });
  });
  $('lbViewBtn').addEventListener('click', function () { setTimeout(function () { loadBoard('week', true); }, 300); });

  /* ---------- input ---------- */
  function setX(clientX) {
    var r = canvas.getBoundingClientRect(), half = padW() / 2;
    S.px = Math.max(half, Math.min(W - half, clientX - r.left));
  }
  stage.addEventListener('pointermove', function (e) { if (S.state === 'play') setX(e.clientX); });
  stage.addEventListener('pointerdown', function (e) { if (S.state === 'play') setX(e.clientX); });
  window.addEventListener('keydown', function (e) {
    var k = e.key;
    if (k === 'ArrowLeft' || k === 'a' || k === 'A') { keys.l = true; if (S.state === 'play') e.preventDefault(); }
    else if (k === 'ArrowRight' || k === 'd' || k === 'D') { keys.r = true; if (S.state === 'play') e.preventDefault(); }
    else if (k === 'p' || k === 'P' || k === 'Escape') { S.state === 'play' ? pause() : resume(); }
  });
  window.addEventListener('keyup', function (e) {
    var k = e.key;
    if (k === 'ArrowLeft' || k === 'a' || k === 'A') keys.l = false;
    if (k === 'ArrowRight' || k === 'd' || k === 'D') keys.r = false;
  });
  document.addEventListener('visibilitychange', function () { if (document.hidden) pause(); });
  window.addEventListener('blur', function () { keys.l = keys.r = false; });

  $('playBtn').addEventListener('click', start);
  $('againBtn').addEventListener('click', start);
  $('pauseBtn').addEventListener('click', function () { S.state === 'play' ? pause() : resume(); });
  $('resumeBtn').addEventListener('click', resume);
  $('playNow').addEventListener('click', function () { setTimeout(function () { if (S.state === 'intro') $('playBtn').focus({ preventScroll: true }); }, 400); });
  $('learnBtn').addEventListener('click', function () { /* anchor scroll handles it */ });

  window.addEventListener('resize', function () { resize(); if (S.state !== 'play') draw(); });
  resize(); reset(); draw();
  if (window.ResizeObserver) new ResizeObserver(function () { resize(); if (S.state !== 'play') draw(); }).observe(stage);
})();
