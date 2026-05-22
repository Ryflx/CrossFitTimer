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

  // ---------- 7-segment LED renderer ----------
  // Segment map: which segments are lit per character.
  const SEG_MAP = {
    '0': 'abcdef',
    '1': 'bc',
    '2': 'abdeg',
    '3': 'abcdg',
    '4': 'bcfg',
    '5': 'acdfg',
    '6': 'acdefg',
    '7': 'abc',
    '8': 'abcdefg',
    '9': 'abcdfg',
    'A': 'abcefg',
    'b': 'cdefg',
    'C': 'adef',
    'd': 'bcdeg',
    'E': 'adefg',
    'F': 'aefg',
    'G': 'acdef',
    'P': 'abefg',
    'r': 'eg',
    'o': 'cdeg',
    'M': 'aceg',
    ' ': '',
    '-': 'g',
  };
  // Polygon paths for each segment in a 60×100 viewBox.
  const SEG_PATHS = {
    a: 'M10,4 L50,4 L44,12 L16,12 Z',
    b: 'M52,6 L52,46 L46,42 L46,14 Z',
    c: 'M52,54 L52,94 L46,86 L46,58 Z',
    d: 'M16,88 L44,88 L50,96 L10,96 Z',
    e: 'M8,54 L8,94 L14,86 L14,58 Z',
    f: 'M8,6 L8,46 L14,42 L14,14 Z',
    g: 'M10,50 L16,46 L44,46 L50,50 L44,54 L16,54 Z',
  };
  const SVG_NS = 'http://www.w3.org/2000/svg';

  const DIGIT_W = 60, COLON_W = 22, H = 100, GAP = 6;

  function drawDigit(parent, ch) {
    const on = new Set(SEG_MAP[ch] || '');
    // Ghost (all segments dim) layer + on layer on top.
    for (const [key, d] of Object.entries(SEG_PATHS)) {
      const p = document.createElementNS(SVG_NS, 'path');
      p.setAttribute('d', d);
      p.setAttribute('class', 'seg seg-' + key + (on.has(key) ? ' on' : ''));
      parent.appendChild(p);
    }
  }
  function drawColon(parent) {
    for (const y of [32, 68]) {
      const c = document.createElementNS(SVG_NS, 'circle');
      c.setAttribute('cx', 11); c.setAttribute('cy', y); c.setAttribute('r', 5.5);
      c.setAttribute('class', 'dot-on');
      parent.appendChild(c);
    }
  }
  function drawDot(parent) {
    const c = document.createElementNS(SVG_NS, 'circle');
    c.setAttribute('cx', 11); c.setAttribute('cy', 88); c.setAttribute('r', 5.5);
    c.setAttribute('class', 'dot-on');
    parent.appendChild(c);
  }

  // Render a string as one SVG with viewBox sized to content so it scales
  // uniformly inside the available display area, regardless of length.
  const Display = {
    last: '',
    set(text) {
      text = String(text);
      if (text === this.last) return;
      this.last = text;

      const widths = [];
      const kinds = [];
      for (const ch of text) {
        if (ch === ':')      { widths.push(COLON_W); kinds.push({ k: 'colon' }); }
        else if (ch === '.') { widths.push(COLON_W); kinds.push({ k: 'dot' }); }
        else                 { widths.push(DIGIT_W); kinds.push({ k: 'digit', ch: ch.toUpperCase() }); }
      }
      const totalW = widths.reduce((a, b) => a + b, 0) + GAP * Math.max(0, widths.length - 1);

      const svg = document.createElementNS(SVG_NS, 'svg');
      svg.setAttribute('viewBox', `0 0 ${totalW} ${H}`);
      svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
      svg.setAttribute('class', 'time-svg');
      svg.setAttribute('aria-hidden', 'true');
      svg.setAttribute('role', 'img');

      let x = 0;
      kinds.forEach((it, i) => {
        const g = document.createElementNS(SVG_NS, 'g');
        g.setAttribute('transform', `translate(${x}, 0)`);
        if (it.k === 'digit') drawDigit(g, it.ch);
        else if (it.k === 'colon') drawColon(g);
        else drawDot(g);
        svg.appendChild(g);
        x += widths[i] + GAP;
      });

      el.ledText.replaceChildren(svg);
    },
  };

  const el = {
    app: $('#app'),
    display: $('#display'),
    phase: $('#phase'),
    time: $('#time'),
    ledText: $('#ledText'),
    sub: $('#sub'),
    rounds: $('#rounds'),
    hint: $('#hint'),
    startBtn: $('#startBtn'),
    resetBtn: $('#resetBtn'),
    lapBtn: $('#lapBtn'),
    prevStepBtn: $('#prevStepBtn'),
    nextStepBtn: $('#nextStepBtn'),
    settingsBtn: $('#settingsBtn'),
    fullscreenBtn: $('#fullscreenBtn'),
    modeButtons: $$('.mode'),
    sheet: $('#sheet'),
    sheetDone: $('#sheetDone'),
    remoteGuide: $('#remoteGuide'),
    remoteSummary: $('#remoteSummary'),
    remoteKeypad: $('#remoteKeypad'),
    stepCounter: $('#stepCounter'),
    stepText: $('#stepText'),
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
    remote:    { model: 'echo2', type: 'interval' },
  };

  // One-time migration: older versions only supported the BT-7000 model.
  // Move anyone still on it onto the new Echo 2.0 layout.
  (() => {
    const s = Store.load();
    if (s.remote && s.remote.model === 'bt7000') {
      s.remote.model = 'echo2';
      Store.save(s);
    }
  })();

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
    if (mode === 'remote') {
      app.remote = { step: 0 };
      cancelAnimationFrame(app.rafId);
      setState('idle');
      renderRemote();
    } else {
      resetTimer();
    }
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
      case 'remote':    return renderRemote();
    }
  }

  // ---------- Remote sequence module ----------
  // Each generator returns an array of [button, instruction] pairs.
  // Buttons are matched against the keypad layout below by label.
  const RemoteSeq = {
    models: {
      echo2: {
        name: 'Rogue Echo Gym Timer 2.0',
        // Keypad mirrors the physical Echo 2.0 remote, flattened into a 3-col grid.
        keypad: [
          [{ label: 'INT', cls: 'mode' }, { label: 'TBT', cls: 'mode' }, { label: 'FGB', cls: 'mode' }],
          [{ label: 'COUNT UP',   cls: 'mode', span: 'wide' }],
          [{ label: 'COUNT DOWN', cls: 'mode', span: 'wide' }],
          [{ label: 'EMOM',       cls: 'mode', span: 'wide' }],
          [{ label: 'CLOCK', cls: 'mode' }, { label: 'RESET', cls: 'stop' }, { label: 'EXIT', cls: 'clr' }],
          [{ label: '◄' }, { label: '▲' }, { label: '►' }],
          [{ label: 'VOL−' }, { label: '▼' }, { label: 'VOL+' }],
          [{ label: '1' }, { label: '2' }, { label: '3' }],
          [{ label: '4' }, { label: '5' }, { label: '6' }],
          [{ label: '7' }, { label: '8' }, { label: '9' }],
          [{ label: 'POWER', cls: 'power' }, { label: '0' }, { label: 'SET', cls: 'set' }],
          [{ label: 'START/STOP', cls: 'start', span: 'wide' }],
        ],
        seq: {
          stopwatch: () => [
            ['COUNT UP',   'Press COUNT UP. The display shows 0:00.'],
            ['START/STOP', 'Press START/STOP to begin counting up. Press again to pause; RESET clears to 0:00.'],
          ],
          countdown: (cfg) => {
            const mmss = pad(cfg.min) + pad(cfg.sec);
            const steps = [
              ['COUNT DOWN', 'Press COUNT DOWN.'],
              ['SET',        'Press SET to enter the duration.'],
            ];
            for (let i = 0; i < 4; i++) {
              steps.push([mmss[i], `Enter ${mmss[i]} — digit ${i + 1} of 4 (MMSS = ${pad(cfg.min)}:${pad(cfg.sec)}).`]);
            }
            steps.push(['SET',        `Press SET to save ${pad(cfg.min)}:${pad(cfg.sec)}.`]);
            steps.push(['START/STOP', 'Press START/STOP to begin the countdown.']);
            return steps;
          },
          interval: (cfg) => {
            const rounds = pad(cfg.rounds);
            const workMmss = pad(Math.floor(cfg.work / 60)) + pad(cfg.work % 60);
            const restMmss = pad(Math.floor(cfg.rest / 60)) + pad(cfg.rest % 60);
            const steps = [
              ['INT', 'Press INT to start interval programming. First field is ROUNDS.'],
            ];
            for (let i = 0; i < 2; i++) {
              steps.push([rounds[i], `Enter ${rounds[i]} — digit ${i + 1} of 2 for ROUNDS (${cfg.rounds}).`]);
            }
            steps.push(['INT', 'Press INT a 2nd time to move to WORK time.']);
            for (let i = 0; i < 4; i++) {
              steps.push([workMmss[i], `Enter ${workMmss[i]} — digit ${i + 1} of 4 for WORK (${workMmss.slice(0,2)}:${workMmss.slice(2)}).`]);
            }
            steps.push(['INT', 'Press INT a 3rd time to move to REST time.']);
            for (let i = 0; i < 4; i++) {
              steps.push([restMmss[i], `Enter ${restMmss[i]} — digit ${i + 1} of 4 for REST (${restMmss.slice(0,2)}:${restMmss.slice(2)}).`]);
            }
            steps.push(['INT', 'Press INT a 4th time to save the program.']);
            steps.push(['START/STOP', 'Press START/STOP. Work counts down, beep, rest counts down, repeat for all rounds.']);
            return steps;
          },
          emom: (cfg) => {
            // Echo 2.0 has a dedicated EMOM button; per the manual, an EMOM is
            // equivalent to INT with rest = 00:00, so we drive it through INT.
            const rounds = pad(cfg.rounds);
            const intMmss = pad(Math.floor(cfg.interval / 60)) + pad(cfg.interval % 60);
            const steps = [
              ['INT', 'Press INT to start interval programming (EMOM = interval with 0 rest). First field is ROUNDS.'],
            ];
            for (let i = 0; i < 2; i++) {
              steps.push([rounds[i], `Enter ${rounds[i]} — digit ${i + 1} of 2 for ROUNDS (${cfg.rounds}).`]);
            }
            steps.push(['INT', 'Press INT a 2nd time to move to WORK time (this is your EMOM interval).']);
            for (let i = 0; i < 4; i++) {
              steps.push([intMmss[i], `Enter ${intMmss[i]} — digit ${i + 1} of 4 for INTERVAL (${intMmss.slice(0,2)}:${intMmss.slice(2)}).`]);
            }
            steps.push(['INT', 'Press INT a 3rd time to move to REST. Enter all zeros for EMOM behaviour.']);
            for (let i = 0; i < 4; i++) {
              steps.push(['0', `Enter 0 — digit ${i + 1} of 4 for REST (0:00).`]);
            }
            steps.push(['INT', 'Press INT a 4th time to save.']);
            steps.push(['START/STOP', 'Press START/STOP. Each round runs the full interval, then beeps and continues.']);
            return steps;
          },
          amrap: (cfg) => {
            return RemoteSeq.models.echo2.seq.countdown(cfg).map(([b, t], i, arr) => {
              if (i === arr.length - 1) return [b, t + ' (Count rounds on the floor — the clock just shows remaining time.)'];
              return [b, t];
            });
          },
        },
      },
    },

    generate(modelId, type) {
      const model = this.models[modelId] || this.models.echo2;
      const fn = model.seq[type];
      if (!fn) return { model, steps: [], cfg: null };
      const cfg = this.cfgFor(type);
      return { model, cfg, steps: fn(cfg) };
    },

    cfgFor(type) {
      const s = app.settings;
      if (type === 'countdown' || type === 'amrap') {
        const sec = (type === 'amrap' ? s.amrap.sec : s.countdown.sec);
        return { min: Math.floor(sec / 60), sec: sec % 60 };
      }
      if (type === 'interval') {
        return { work: s.interval.work, rest: s.interval.rest, rounds: s.interval.rounds };
      }
      if (type === 'emom') {
        return { interval: s.emom.interval, rounds: s.emom.rounds };
      }
      return {};
    },

    summaryChips(type, cfg) {
      const label = ({
        stopwatch: 'STOPWATCH',
        countdown: 'COUNTDOWN',
        interval:  'INTERVAL',
        emom:      'EMOM',
        amrap:     'AMRAP',
      })[type] || type.toUpperCase();
      const chips = [`<span class="chip"><strong>${label}</strong></span>`];
      if (type === 'countdown' || type === 'amrap') {
        chips.push(`<span class="chip">${pad(cfg.min)}:${pad(cfg.sec)}</span>`);
      } else if (type === 'interval') {
        chips.push(`<span class="chip">${cfg.work}s work</span>`);
        chips.push(`<span class="chip">${cfg.rest}s rest</span>`);
        chips.push(`<span class="chip">${cfg.rounds} rounds</span>`);
      } else if (type === 'emom') {
        const m = Math.floor(cfg.interval / 60), s = cfg.interval % 60;
        chips.push(`<span class="chip">${m}:${pad(s)} interval</span>`);
        chips.push(`<span class="chip">${cfg.rounds} rounds</span>`);
      }
      return chips.join('');
    },
  };

  // ---------- Remote mode render ----------
  function renderRemoteKeypad(activeBtn) {
    const model = RemoteSeq.models[app.settings.remote.model] || RemoteSeq.models.echo2;
    el.remoteKeypad.innerHTML = '';
    for (const row of model.keypad) {
      for (const btn of row) {
        const div = document.createElement('div');
        const classes = ['key'];
        if (btn.cls) classes.push(btn.cls);
        if (btn.span === 'medium') classes.push('medium');
        if (btn.span === 'wide') classes.push('wide');
        if (btn.label === activeBtn) classes.push('active');
        div.className = classes.join(' ');
        div.textContent = btn.label;
        el.remoteKeypad.appendChild(div);
      }
    }
  }

  function renderRemote() {
    // Make sure we have remote settings.
    if (!app.settings.remote) app.settings.remote = { model: 'echo2', type: 'interval' };
    const { model: modelId, type } = app.settings.remote;
    const result = RemoteSeq.generate(modelId, type);
    app.remote = app.remote || { step: 0 };
    if (app.remote.step >= result.steps.length) app.remote.step = Math.max(0, result.steps.length - 1);
    const step = result.steps[app.remote.step] || ['', 'No sequence available.'];

    el.remoteSummary.innerHTML = RemoteSeq.summaryChips(type, result.cfg || {});
    el.stepCounter.textContent = result.steps.length
      ? `STEP ${app.remote.step + 1} OF ${result.steps.length}`
      : 'NO STEPS';
    el.stepText.textContent = step[1];

    renderRemoteKeypad(step[0]);

    el.prevStepBtn.disabled = app.remote.step <= 0;
    el.nextStepBtn.disabled = app.remote.step >= result.steps.length - 1;
    el.prevStepBtn.style.opacity = el.prevStepBtn.disabled ? 0.4 : 1;
    el.nextStepBtn.style.opacity = el.nextStepBtn.disabled ? 0.4 : 1;
  }

  function stepRemote(delta) {
    if (app.mode !== 'remote') return;
    app.remote = app.remote || { step: 0 };
    const { model: modelId, type } = app.settings.remote || { model: 'echo2', type: 'interval' };
    const result = RemoteSeq.generate(modelId, type);
    const next = Math.min(result.steps.length - 1, Math.max(0, app.remote.step + delta));
    if (next === app.remote.step) return;
    app.remote.step = next;
    Audio.init(); Audio.resume(); Audio.tick(); Haptic.pulse(15);
    renderRemote();
  }

  function renderClock() {
    // Use a compact format so all digits fit on the LED display.
    const d = new Date();
    let h = d.getHours();
    const ampm = h >= 12 ? 'P' : 'A';
    if (!app.settings.h24) h = h % 12 || 12;
    const text = (app.settings.h24 ? pad(h) : (h < 10 ? ' ' + h : String(h)))
      + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
    Display.set(text);
    el.phase.textContent = app.settings.h24 ? '' : (ampm === 'P' ? 'PM' : 'AM');
    el.sub.textContent = d.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' });
    el.rounds.textContent = '';
    el.hint.textContent = '';
    setPhase('idle');
  }

  function renderStopwatch() {
    const e = elapsedMs();
    Display.set(fmtTime(e, app.state !== 'idle'));
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
      Display.set(pad(Math.ceil(left / 1000)));
      el.sub.textContent = 'starting…';
      el.rounds.textContent = '';
      el.hint.textContent = '';
      handlePrerollTicks(left);
      if (left <= 0) advanceFromPreroll();
      return;
    }

    const remaining = Math.max(0, total - e);
    Display.set(fmtTime(remaining, remaining < 10000));
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
      Display.set(pad(Math.ceil(left / 1000)));
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
    Display.set(fmtTime(phaseLeft, phaseLeft < 10000));
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
      Display.set(pad(Math.ceil(left / 1000)));
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
    Display.set(fmtTime(left, left < 10000));
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
      Display.set(pad(Math.ceil(left / 1000)));
      el.sub.textContent = `AMRAP ${fmtTime(total)}`;
      el.rounds.textContent = `ROUNDS: ${app.amrapRounds}`;
      el.hint.textContent = '';
      handlePrerollTicks(left);
      if (left <= 0) advanceFromPreroll();
      return;
    }

    const remaining = Math.max(0, total - e);
    Display.set(fmtTime(remaining, remaining < 10000));
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
    if (app.mode === 'remote') { renderRemote(); return; }
    // show ready frame
    if (app.mode === 'stopwatch') {
      Display.set('00:00');
      el.phase.textContent = 'READY';
      el.sub.textContent = ''; el.rounds.textContent = ''; el.hint.textContent = 'tap START';
    } else if (app.mode === 'countdown') {
      Display.set(fmtTime(app.settings.countdown.sec * 1000));
      el.phase.textContent = 'COUNTDOWN'; el.sub.textContent = ''; el.rounds.textContent = ''; el.hint.textContent = '';
    } else if (app.mode === 'interval') {
      const { work, rest, rounds } = app.settings.interval;
      Display.set(fmtTime(work * 1000));
      el.phase.textContent = 'READY';
      el.sub.textContent = `${work}s WORK / ${rest}s REST`;
      el.rounds.textContent = `ROUNDS: ${rounds}`;
      el.hint.textContent = '';
    } else if (app.mode === 'emom') {
      const { interval, rounds } = app.settings.emom;
      Display.set(fmtTime(interval * 1000));
      el.phase.textContent = 'READY';
      el.sub.textContent = `EMOM ${interval}s`;
      el.rounds.textContent = `ROUNDS: ${rounds}`;
      el.hint.textContent = '';
    } else if (app.mode === 'amrap') {
      Display.set(fmtTime(app.settings.amrap.sec * 1000));
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
    if (app.mode === 'countdown' || app.mode === 'amrap') Display.set('00:00');
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
    if (app.mode === 'remote') { app.remote = { step: 0 }; renderRemote(); }
    else if (app.state === 'idle' || app.state === 'done') resetTimer();
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

    if (!app.settings.remote) app.settings.remote = { model: 'echo2', type: 'interval' };
    $('#remoteType').value  = app.settings.remote.type;
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

    if (!app.settings.remote) app.settings.remote = { model: 'echo2', type: 'interval' };
    app.settings.remote.model = 'echo2';
    app.settings.remote.type  = $('#remoteType').value  || 'interval';

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
    el.prevStepBtn.addEventListener('click', () => stepRemote(-1));
    el.nextStepBtn.addEventListener('click', () => stepRemote(+1));
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

    // Keyboard shortcuts: Space = start/pause (or next step in remote), R = reset, arrows in remote
    window.addEventListener('keydown', (e) => {
      if (el.sheet.hidden === false) return;
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
      if (app.mode === 'remote') {
        if (e.code === 'Space' || e.key === 'ArrowRight' || e.key === 'ArrowDown') { e.preventDefault(); stepRemote(+1); }
        else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') { e.preventDefault(); stepRemote(-1); }
        else if (e.key === 'r' || e.key === 'R') { app.remote = { step: 0 }; renderRemote(); }
        return;
      }
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
