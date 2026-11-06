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
    $('endOv').hidden = false; $('againBtn').focus();
    say(why + ' Final score ' + score + '. ' + rk.title + '.');
  }

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
