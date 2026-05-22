(() => {
  'use strict';

  // ---------- Audio ----------
  const Audio = {
    ctx: null,
    enabled: true,
    init() {
      if (this.ctx) return;
      try {
        const Ctx = window.AudioContext || window.webkitAudioContext;
        if (Ctx) this.ctx = new Ctx();
      } catch (e) {}
    },
    resume() {
      if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume();
    },
    beep(freq = 880, duration = 0.12, gain = 0.25, type = 'square') {
      if (!this.enabled || !this.ctx) return;
      const t = this.ctx.currentTime;
      const osc = this.ctx.createOscillator();
      const g = this.ctx.createGain();
      osc.type = type;
      osc.frequency.setValueAtTime(freq, t);
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(gain, t + 0.005);
      g.gain.exponentialRampToValueAtTime(0.0001, t + duration);
      osc.connect(g).connect(this.ctx.destination);
      osc.start(t);
      osc.stop(t + duration + 0.02);
    },
    tick()  { this.beep(880, 0.10, 0.20); },          // count-in tick
    go()    { this.beep(1320, 0.35, 0.30, 'square'); }, // start of work / interval
    rest()  { this.beep(660, 0.30, 0.25, 'sine'); },   // start of rest
    end()   {
      this.beep(1600, 0.18, 0.30);
      setTimeout(() => this.beep(1600, 0.18, 0.30), 200);
      setTimeout(() => this.beep(2000, 0.60, 0.30), 400);
    },
    minute() { this.beep(1200, 0.20, 0.25); },
  };

  // ---------- Haptics ----------
  const Haptic = {
    enabled: false,
    pulse(ms = 30) {
      if (!this.enabled) return;
      if (navigator.vibrate) navigator.vibrate(ms);
    },
    pattern(p) {
      if (!this.enabled) return;
      if (navigator.vibrate) navigator.vibrate(p);
    },
  };

  // ---------- Wake Lock ----------
  const Wake = {
    enabled: true,
    sentinel: null,
    async request() {
      if (!this.enabled) return;
      if (!('wakeLock' in navigator)) return;
      try {
        this.sentinel = await navigator.wakeLock.request('screen');
        this.sentinel.addEventListener('release', () => { this.sentinel = null; });
      } catch (e) {}
    },
    async release() {
      try { if (this.sentinel) await this.sentinel.release(); } catch (e) {}
      this.sentinel = null;
    },
  };
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && app && app.state === 'running') {
      Wake.request();
    }
  });

  // ---------- Storage ----------
  const Store = {
    KEY: 'wodclock.settings.v1',
    load() {
      try { return JSON.parse(localStorage.getItem(this.KEY)) || {}; } catch (e) { return {}; }
    },
    save(obj) {
      try { localStorage.setItem(this.KEY, JSON.stringify(obj)); } catch (e) {}
    },
  };

  // ---------- Helpers ----------
  const pad = (n) => String(Math.max(0, n | 0)).padStart(2, '0');
  const fmtTime = (totalMs, showTenths = false) => {
    const totalSec = Math.max(0, totalMs / 1000);
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    const s = Math.floor(totalSec % 60);
    if (h > 0) return `${h}:${pad(m)}:${pad(s)}`;
    if (showTenths) {
      const tenths = Math.floor((totalSec - Math.floor(totalSec)) * 10);
      return `${pad(m)}:${pad(s)}.${tenths}`;
    }
    return `${pad(m)}:${pad(s)}`;
  };
  const fmtClock = (date, h24) => {
    let h = date.getHours();
    const m = date.getMinutes();
    const s = date.getSeconds();
    let suffix = '';
    if (!h24) {
      suffix = h >= 12 ? ' PM' : ' AM';
      h = h % 12 || 12;
    }
    return `${h24 ? pad(h) : h}:${pad(m)}:${pad(s)}${suffix}`;
  };

  // ---------- DOM ----------
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  const el = {
    app: $('#app'),
    display: $('#display'),
    phase: $('#phase'),
    time: $('#time'),
    sub: $('#sub'),
    rounds: $('#rounds'),
    hint: $('#hint'),
    startBtn: $('#startBtn'),
    resetBtn: $('#resetBtn'),
    lapBtn: $('#lapBtn'),
    settingsBtn: $('#settingsBtn'),
    fullscreenBtn: $('#fullscreenBtn'),
    modeButtons: $$('.mode'),
    sheet: $('#sheet'),
    sheetDone: $('#sheetDone'),
  };

  // ---------- App ----------
  const DEFAULTS = {
    mode: 'clock',
    preroll: 10,
    sound: true,
    vibrate: true,
    wakelock: true,
    color: 'red',
    h24: false,
    countdown: { sec: 300 },
    interval:  { work: 20, rest: 10, rounds: 8 },
    emom:      { interval: 60, rounds: 10 },
    amrap:     { sec: 600 },
  };

  const app = {
    settings: { ...DEFAULTS, ...Store.load() },
    mode: 'clock',
    state: 'idle',     // idle | running | paused | done
    phase: 'idle',     // idle | preroll | work | rest | done
    startedAt: 0,
    accumulated: 0,    // ms accumulated before pause
    lastTickSec: -1,   // for beep edge detection on countdown ticks
    lastPhase: null,
    amrapRounds: 0,
    rafId: 0,
  };

  // ---------- State helpers ----------
  function setMode(mode) {
    app.mode = mode;
    el.app.dataset.mode = mode;
    el.sheet.dataset.mode = mode;
    el.modeButtons.forEach(b => b.setAttribute('aria-selected', b.dataset.mode === mode ? 'true' : 'false'));
    resetTimer();
    app.settings.mode = mode;
    Store.save(app.settings);
  }

  function setState(s) {
    app.state = s;
    el.app.dataset.state = s;
    el.startBtn.textContent =
      s === 'running' ? 'PAUSE'
      : s === 'paused' ? 'RESUME'
      : 'START';
  }

  function setPhase(p) {
    app.phase = p;
    el.app.dataset.phase = p;
  }

  function flash() {
    el.display.classList.remove('flash');
    void el.display.offsetWidth;
    el.display.classList.add('flash');
  }

  // ---------- Timer math ----------
  function nowMs() { return performance.now(); }

  function elapsedMs() {
    if (app.state === 'running') return app.accumulated + (nowMs() - app.startedAt);
    return app.accumulated;
  }

  function startElapsed() {
    app.startedAt = nowMs();
  }

  function pauseElapsed() {
    app.accumulated += nowMs() - app.startedAt;
  }

  // ---------- Render ----------
  function render() {
    switch (app.mode) {
      case 'clock':     return renderClock();
      case 'stopwatch': return renderStopwatch();
      case 'countdown': return renderCountdown();
      case 'interval':  return renderInterval();
      case 'emom':      return renderEMOM();
      case 'amrap':     return renderAMRAP();
    }
  }

  function renderClock() {
    el.time.textContent = fmtClock(new Date(), app.settings.h24);
    el.phase.textContent = '';
    el.sub.textContent = new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' });
    el.rounds.textContent = '';
    el.hint.textContent = '';
    setPhase('idle');
  }

  function renderStopwatch() {
    const e = elapsedMs();
    el.time.textContent = fmtTime(e, app.state !== 'idle');
    el.phase.textContent = app.state === 'running' ? 'ELAPSED' : (app.state === 'paused' ? 'PAUSED' : 'READY');
    el.sub.textContent = '';
    el.rounds.textContent = '';
    el.hint.textContent = app.state === 'idle' ? 'tap START' : '';
  }

  function renderCountdown() {
    const total = app.settings.countdown.sec * 1000;
    const e = elapsedMs();

    if (app.phase === 'preroll') {
      const left = Math.max(0, app.settings.preroll * 1000 - e);
      el.phase.textContent = 'GET READY';
      el.time.textContent = String(Math.ceil(left / 1000));
      el.sub.textContent = 'starting…';
      el.rounds.textContent = '';
      el.hint.textContent = '';
      handlePrerollTicks(left);
      if (left <= 0) advanceFromPreroll();
      return;
    }

    const remaining = Math.max(0, total - e);
    el.time.textContent = fmtTime(remaining, remaining < 10000);
    el.phase.textContent = app.state === 'done' ? 'DONE' : 'COUNTDOWN';
    el.sub.textContent = '';
    el.rounds.textContent = '';
    el.hint.textContent = '';

    handleCountdownTicks(remaining);

    if (remaining <= 0 && app.state === 'running') finishWorkout();
  }

  function renderInterval() {
    const { work, rest, rounds } = app.settings.interval;
    const cycle = (work + rest) * 1000;
    const total = cycle * rounds;
    const e = elapsedMs();

    if (app.phase === 'preroll') {
      const left = Math.max(0, app.settings.preroll * 1000 - e);
      el.phase.textContent = 'GET READY';
      el.time.textContent = String(Math.ceil(left / 1000));
      el.sub.textContent = `${work}s WORK / ${rest}s REST × ${rounds}`;
      el.rounds.textContent = '';
      el.hint.textContent = '';
      handlePrerollTicks(left);
      if (left <= 0) advanceFromPreroll();
      return;
    }

    if (e >= total) { finishWorkout(); return; }

    const round = Math.floor(e / cycle) + 1;
    const inCycle = e % cycle;
    let phase, phaseLeft;
    if (inCycle < work * 1000) {
      phase = 'work';
      phaseLeft = work * 1000 - inCycle;
    } else {
      phase = 'rest';
      phaseLeft = cycle - inCycle;
    }

    if (phase !== app.lastPhase) {
      app.lastPhase = phase;
      setPhase(phase);
      if (phase === 'work') { Audio.go(); Haptic.pattern([60,40,60]); }
      else                  { Audio.rest(); Haptic.pulse(50); }
      flash();
    }

    el.phase.textContent = phase === 'work' ? 'WORK' : 'REST';
    el.time.textContent = fmtTime(phaseLeft, phaseLeft < 10000);
    el.sub.textContent = phase === 'work' ? `then ${rest}s rest` : `then ${work}s work`;
    el.rounds.textContent = `ROUND ${round} / ${rounds}`;
    el.hint.textContent = '';

    handleCountdownTicks(phaseLeft);
  }

  function renderEMOM() {
    const { interval, rounds } = app.settings.emom;
    const cycle = interval * 1000;
    const total = cycle * rounds;
    const e = elapsedMs();

    if (app.phase === 'preroll') {
      const left = Math.max(0, app.settings.preroll * 1000 - e);
      el.phase.textContent = 'GET READY';
      el.time.textContent = String(Math.ceil(left / 1000));
      el.sub.textContent = `EMOM ${interval}s × ${rounds}`;
      el.rounds.textContent = '';
      el.hint.textContent = '';
      handlePrerollTicks(left);
      if (left <= 0) advanceFromPreroll();
      return;
    }

    if (e >= total) { finishWorkout(); return; }

    const round = Math.floor(e / cycle) + 1;
    const inCycle = e % cycle;
    const left = cycle - inCycle;

    const newPhase = `emom-${round}`;
    if (newPhase !== app.lastPhase) {
      app.lastPhase = newPhase;
      setPhase('work');
      Audio.minute(); Haptic.pulse(50);
      flash();
    }

    el.phase.textContent = `MINUTE ${round}`;
    el.time.textContent = fmtTime(left, left < 10000);
    el.sub.textContent = '';
    el.rounds.textContent = `ROUND ${round} / ${rounds}`;
    el.hint.textContent = '';

    handleCountdownTicks(left);
  }

  function renderAMRAP() {
    const total = app.settings.amrap.sec * 1000;
    const e = elapsedMs();

    if (app.phase === 'preroll') {
      const left = Math.max(0, app.settings.preroll * 1000 - e);
      el.phase.textContent = 'GET READY';
      el.time.textContent = String(Math.ceil(left / 1000));
      el.sub.textContent = `AMRAP ${fmtTime(total)}`;
      el.rounds.textContent = `ROUNDS: ${app.amrapRounds}`;
      el.hint.textContent = '';
      handlePrerollTicks(left);
      if (left <= 0) advanceFromPreroll();
      return;
    }

    const remaining = Math.max(0, total - e);
    el.time.textContent = fmtTime(remaining, remaining < 10000);
    el.phase.textContent = app.state === 'done' ? 'DONE' : 'AMRAP';
    el.sub.textContent = '';
    el.rounds.textContent = `ROUNDS: ${app.amrapRounds}`;
    el.hint.textContent = app.state === 'running' ? 'tap time for +1 round' : '';

    handleCountdownTicks(remaining);

    if (remaining <= 0 && app.state === 'running') finishWorkout();
  }

  // ---------- Tick edges (beeps at integer-second boundaries) ----------
  function handlePrerollTicks(remainingMs) {
    const sec = Math.ceil(remainingMs / 1000);
    if (sec !== app.lastTickSec) {
      app.lastTickSec = sec;
      if (sec > 0 && sec <= 3) { Audio.tick(); Haptic.pulse(20); }
    }
  }

  function handleCountdownTicks(remainingMs) {
    const sec = Math.ceil(remainingMs / 1000);
    if (sec !== app.lastTickSec) {
      app.lastTickSec = sec;
      if (sec > 0 && sec <= 3) { Audio.tick(); Haptic.pulse(20); }
    }
  }

  function advanceFromPreroll() {
    // Switch from preroll to running phase: reset clocks.
    app.accumulated = 0;
    app.startedAt = nowMs();
    app.lastTickSec = -1;
    app.lastPhase = null;
    setPhase(app.mode === 'interval' ? 'work' : (app.mode === 'emom' ? 'work' : 'idle'));
    if (app.mode === 'countdown' || app.mode === 'amrap') {
      Audio.go(); Haptic.pattern([60,40,60]); flash();
    }
  }

  // ---------- Loop ----------
  function tick() {
    render();
    if (app.state === 'running' || app.mode === 'clock') {
      app.rafId = requestAnimationFrame(tick);
    }
  }

  // ---------- Control actions ----------
  function startTimer() {
    Audio.init(); Audio.resume();

    if (app.mode === 'clock') return;

    if (app.state === 'done') resetTimer();

    if (app.state === 'paused') {
      startElapsed();
      setState('running');
      Wake.request();
      tick();
      return;
    }

    // idle → preroll (if applicable) or running
    const needsPreroll = ['countdown', 'interval', 'emom', 'amrap'].includes(app.mode) && app.settings.preroll > 0;

    app.accumulated = 0;
    app.lastTickSec = -1;
    app.lastPhase = null;
    app.amrapRounds = 0;
    startElapsed();
    setState('running');
    setPhase(needsPreroll ? 'preroll' : (app.mode === 'interval' || app.mode === 'emom' ? 'work' : 'idle'));
    Wake.request();

    if (!needsPreroll && (app.mode === 'countdown' || app.mode === 'amrap')) {
      Audio.go(); Haptic.pulse(60);
    }
    tick();
  }

  function pauseTimer() {
    if (app.state !== 'running') return;
    pauseElapsed();
    setState('paused');
    cancelAnimationFrame(app.rafId);
    Wake.release();
    render();
  }

  function toggleStart() {
    if (app.state === 'running') pauseTimer();
    else startTimer();
  }

  function resetTimer() {
    cancelAnimationFrame(app.rafId);
    app.startedAt = 0;
    app.accumulated = 0;
    app.lastTickSec = -1;
    app.lastPhase = null;
    app.amrapRounds = 0;
    setState('idle');
    setPhase('idle');
    Wake.release();
    if (app.mode === 'clock') { tick(); return; }
    // show ready frame
    if (app.mode === 'stopwatch') {
      el.time.textContent = '00:00';
      el.phase.textContent = 'READY';
      el.sub.textContent = ''; el.rounds.textContent = ''; el.hint.textContent = 'tap START';
    } else if (app.mode === 'countdown') {
      el.time.textContent = fmtTime(app.settings.countdown.sec * 1000);
      el.phase.textContent = 'COUNTDOWN'; el.sub.textContent = ''; el.rounds.textContent = ''; el.hint.textContent = '';
    } else if (app.mode === 'interval') {
      const { work, rest, rounds } = app.settings.interval;
      el.time.textContent = fmtTime(work * 1000);
      el.phase.textContent = 'READY';
      el.sub.textContent = `${work}s WORK / ${rest}s REST`;
      el.rounds.textContent = `ROUNDS: ${rounds}`;
      el.hint.textContent = '';
    } else if (app.mode === 'emom') {
      const { interval, rounds } = app.settings.emom;
      el.time.textContent = fmtTime(interval * 1000);
      el.phase.textContent = 'READY';
      el.sub.textContent = `EMOM ${interval}s`;
      el.rounds.textContent = `ROUNDS: ${rounds}`;
      el.hint.textContent = '';
    } else if (app.mode === 'amrap') {
      el.time.textContent = fmtTime(app.settings.amrap.sec * 1000);
      el.phase.textContent = 'AMRAP'; el.sub.textContent = '';
      el.rounds.textContent = 'ROUNDS: 0'; el.hint.textContent = '';
    }
  }

  function finishWorkout() {
    pauseElapsed();
    setState('done');
    setPhase('done');
    cancelAnimationFrame(app.rafId);
    Wake.release();
    Audio.end();
    Haptic.pattern([200, 100, 200, 100, 400]);
    // Lock display at zero / final
    if (app.mode === 'countdown' || app.mode === 'amrap') el.time.textContent = '00:00';
    el.phase.textContent = 'DONE';
    el.hint.textContent = 'tap START to go again';
  }

  function addRound() {
    if (app.mode !== 'amrap') return;
    if (!['running', 'paused'].includes(app.state)) return;
    if (app.phase === 'preroll') return;
    app.amrapRounds++;
    el.rounds.textContent = `ROUNDS: ${app.amrapRounds}`;
    Audio.tick(); Haptic.pulse(20);
  }

  // ---------- Settings sheet ----------
  function openSheet() {
    syncSheetFromSettings();
    el.sheet.hidden = false;
    el.sheet.setAttribute('aria-hidden', 'false');
  }
  function closeSheet() {
    el.sheet.hidden = true;
    el.sheet.setAttribute('aria-hidden', 'true');
    applySheetToSettings();
    Store.save(app.settings);
    applyTheme();
    // Only refresh the ready-frame if we're not mid-workout — don't interrupt.
    if (app.state === 'idle' || app.state === 'done') resetTimer();
    else if (app.mode === 'clock') render();
  }

  function syncSheetFromSettings() {
    $('#prerollInput').value = app.settings.preroll;
    $('#soundInput').checked = app.settings.sound;
    $('#vibrateInput').checked = app.settings.vibrate;
    $('#wakelockInput').checked = app.settings.wakelock;
    $('#colorInput').value = app.settings.color;
    $('#h24Input').checked = app.settings.h24;

    const cd = app.settings.countdown.sec;
    $('#cdMin').value = Math.floor(cd / 60);
    $('#cdSec').value = cd % 60;

    const iv = app.settings.interval;
    $('#ivWorkMin').value = Math.floor(iv.work / 60);
    $('#ivWorkSec').value = iv.work % 60;
    $('#ivRestMin').value = Math.floor(iv.rest / 60);
    $('#ivRestSec').value = iv.rest % 60;
    $('#ivRounds').value = iv.rounds;

    const em = app.settings.emom;
    $('#emomMin').value = Math.floor(em.interval / 60);
    $('#emomSec').value = em.interval % 60;
    $('#emomRounds').value = em.rounds;

    const am = app.settings.amrap.sec;
    $('#amrapMin').value = Math.floor(am / 60);
    $('#amrapSec').value = am % 60;
  }

  function readInt(id, min, max, fallback) {
    const v = parseInt($(id).value, 10);
    if (Number.isFinite(v)) return Math.min(max, Math.max(min, v));
    return fallback;
  }

  function applySheetToSettings() {
    app.settings.preroll = readInt('#prerollInput', 0, 60, 10);
    app.settings.sound = $('#soundInput').checked;
    app.settings.vibrate = $('#vibrateInput').checked;
    app.settings.wakelock = $('#wakelockInput').checked;
    app.settings.color = $('#colorInput').value;
    app.settings.h24 = $('#h24Input').checked;

    app.settings.countdown.sec = Math.max(1,
      readInt('#cdMin', 0, 999, 5) * 60 + readInt('#cdSec', 0, 59, 0));

    app.settings.interval.work   = Math.max(1, readInt('#ivWorkMin', 0, 59, 0) * 60 + readInt('#ivWorkSec', 0, 59, 20));
    app.settings.interval.rest   = Math.max(0, readInt('#ivRestMin', 0, 59, 0) * 60 + readInt('#ivRestSec', 0, 59, 10));
    app.settings.interval.rounds = readInt('#ivRounds', 1, 99, 8);

    app.settings.emom.interval = Math.max(5, readInt('#emomMin', 0, 59, 1) * 60 + readInt('#emomSec', 0, 59, 0));
    app.settings.emom.rounds   = readInt('#emomRounds', 1, 99, 10);

    app.settings.amrap.sec = Math.max(1,
      readInt('#amrapMin', 0, 999, 10) * 60 + readInt('#amrapSec', 0, 59, 0));

    Audio.enabled = app.settings.sound;
    Haptic.enabled = app.settings.vibrate;
    Wake.enabled = app.settings.wakelock;
  }

  function applyTheme() {
    el.app.dataset.color = app.settings.color;
  }

  // ---------- Wire up ----------
  function bind() {
    el.modeButtons.forEach(b => {
      b.addEventListener('click', () => setMode(b.dataset.mode));
    });
    el.startBtn.addEventListener('click', () => { Audio.init(); Audio.resume(); toggleStart(); });
    el.resetBtn.addEventListener('click', resetTimer);
    el.lapBtn.addEventListener('click', addRound);
    el.settingsBtn.addEventListener('click', openSheet);
    el.sheetDone.addEventListener('click', closeSheet);
    el.sheet.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', closeSheet));

    // Tap-the-time → AMRAP round
    el.time.addEventListener('click', () => {
      if (app.mode === 'amrap') addRound();
    });

    // Presets
    $$('.presets [data-cd]').forEach(b => b.addEventListener('click', () => {
      const s = parseInt(b.dataset.cd, 10);
      app.settings.countdown.sec = s;
      Store.save(app.settings); syncSheetFromSettings();
    }));
    $$('.presets [data-iv]').forEach(b => b.addEventListener('click', () => {
      const [w, r, n] = b.dataset.iv.split(',').map(x => parseInt(x, 10));
      app.settings.interval = { work: w, rest: r, rounds: n };
      Store.save(app.settings); syncSheetFromSettings();
    }));
    $$('.presets [data-emom]').forEach(b => b.addEventListener('click', () => {
      const [iv, n] = b.dataset.emom.split(',').map(x => parseInt(x, 10));
      app.settings.emom = { interval: iv, rounds: n };
      Store.save(app.settings); syncSheetFromSettings();
    }));
    $$('.presets [data-amrap]').forEach(b => b.addEventListener('click', () => {
      const s = parseInt(b.dataset.amrap, 10);
      app.settings.amrap.sec = s;
      Store.save(app.settings); syncSheetFromSettings();
    }));

    // Fullscreen
    el.fullscreenBtn.addEventListener('click', async () => {
      try {
        if (!document.fullscreenElement) await document.documentElement.requestFullscreen();
        else await document.exitFullscreen();
      } catch (e) {}
    });

    // Keyboard shortcuts: Space = start/pause, R = reset
    window.addEventListener('keydown', (e) => {
      if (el.sheet.hidden === false) return;
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
      if (e.code === 'Space') { e.preventDefault(); toggleStart(); }
      else if (e.key === 'r' || e.key === 'R') { resetTimer(); }
      else if (app.mode === 'amrap' && (e.key === 'Enter' || e.key === '+')) { addRound(); }
    });
  }

  // ---------- Boot ----------
  function boot() {
    bind();
    Audio.enabled = app.settings.sound;
    Haptic.enabled = app.settings.vibrate;
    Wake.enabled = app.settings.wakelock;
    applyTheme();
    setMode(app.settings.mode || 'clock');
    // Clock mode renders on a loop without state change.
    if ('serviceWorker' in navigator) {
      window.addEventListener('load', () => {
        navigator.serviceWorker.register('sw.js').catch(() => {});
      });
    }
  }

  // Expose for visibility listener
  window.app = app;

  document.addEventListener('DOMContentLoaded', boot);
})();
