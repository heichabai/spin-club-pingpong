import { createScene3D } from './scene3d.js';
import { BALL_RADIUS, X_SCALE, Z_SCALE, RACKET_HEIGHT, computeShot, getBallHeight, stepBallFlight, sweptRacketContact } from './physics.js';
export { computeShot, getBallHeight } from './physics.js';

// A deterministic court simulation, shared by the practice game and room host.
// The room guest sends input in its own view and renders the host's court rotated.
export const COURT = Object.freeze({ width: 1000, height: 800, left: 150, right: 850, top: 82, bottom: 718 });
export const PADDLE_REACH = Object.freeze({ left: 70, right: 930, front: 415, back: 870 });
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const lerp = (a, b, t) => a + (b - a) * t;
const now = () => performance.now();

export function rotateInput(input) {
  return { x: 1000 - input.x, y: 800 - input.y, vx: -input.vx, vy: -input.vy };
}

export function matchWinner(score) {
  if (Math.max(...score) >= 11 && Math.abs(score[0] - score[1]) >= 2) return score[0] > score[1] ? 0 : 1;
  return null;
}

export function createGame(canvas, options = {}) {
  const view = createScene3D(canvas);
  const settings = { difficulty: 'normal', sound: true, trails: true, stroke: 'drive', tilt: 3, gesture: true };
  let mode = 'practice';
  let phase = 'idle';
  let beforePause = 'playing';
  let score = [0, 0];
  let rally = 0;
  let bestRally = 0;
  let winner = null;
  let lastShot = '等待发球';
  let serveSide = 0;
  let serveAt = 0;
  let lastFrame = now();
  let lastUpdate = 0;
  let elapsed = 0;
  let frameId = 0;
  let destroyed = false;
  let shake = 0;
  let flash = 0;
  let eventId = 0;
  let lastEvent = null;
  let seenEvent = 0;
  let receivedAt = 0;
  let remoteSeenAt = 0;
  let audioContext = null;
  let activeTouch = null;
  let lastTrailAt = 0;
  let flightId = 0;
  let touchStart = null;
  const samples = [];
  const particles = [];
  const trail = [];
  const input = { x: 500, y: 670, vx: 0, vy: 0, ax: 0, ay: 0, stroke: 'drive', tilt: 3, height: RACKET_HEIGHT, gesture: true };
  const remote = { ...input, y: 130 };
  const players = [{ ...input, glow: 0 }, { ...remote, glow: 0 }];
  const ball = { x: 500, y: 640, height: 0.14, vx: 0, vy: 0, vh: 0, spinX: 0, spinY: 0, spinZ: 0, spin: 0, hop: 0, lastHitter: 0, receiverBounces: 0, serveStage: 0, netCrossed: false, netTouched: false, flightId: 0, visible: true };
  const guestBall = { ...ball };
  const aiPlayers = [0, 1].map(() => ({ aim: 500, nextThink: 0, error: 0, tilt: 6 }));

  function emit(force = false) {
    const t = now();
    if (!force && t - lastUpdate < 100) return;
    lastUpdate = t;
    const self = mode === 'guest' ? 1 : 0;
    options.onUpdate?.({
      score: self === 0 ? [...score] : [score[1], score[0]],
      rally, bestRally,
      speed: Math.round(Math.hypot(ball.vx * X_SCALE, ball.vy * Z_SCALE, ball.vh) * 3.6),
      spin: clamp(Math.hypot(ball.spinX, ball.spinY, ball.spinZ) / 400, 0, 1),
      spinLabel: spinLabel(ball, self),
      rpm: Math.round(Math.hypot(ball.spinX, ball.spinY, ball.spinZ) * 60 / (2 * Math.PI)),
      lastShot,
      phase: mode === 'demo' ? 'idle' : phase,
      canServe: serveSide === self,
      winner: winner === null ? null : winner === self ? 'self' : 'opponent',
    });
  }

  function unlockAudio() {
    if (!settings.sound) return;
    try {
      const AudioClass = window.AudioContext || window.webkitAudioContext;
      if (AudioClass && !audioContext) audioContext = new AudioClass();
      if (audioContext?.state === 'suspended') audioContext.resume().catch(() => {});
    } catch { /* Sound is optional on browsers without Web Audio. */ }
  }

  function tone(kind, side = 0) {
    if (!settings.sound || !audioContext || audioContext.state !== 'running') return;
    try {
      const oscillator = audioContext.createOscillator();
      const gain = audioContext.createGain();
      const t = audioContext.currentTime;
      oscillator.type = 'sine';
      const frequency = kind === 'point' ? 390 : kind === 'wall' ? 400 : side === 0 ? 720 : 610;
      oscillator.frequency.setValueAtTime(frequency, t);
      oscillator.frequency.exponentialRampToValueAtTime(frequency * 0.6, t + 0.07);
      gain.gain.setValueAtTime(0.055, t);
      gain.gain.exponentialRampToValueAtTime(0.001, t + (kind === 'point' ? 0.22 : 0.075));
      oscillator.connect(gain);
      gain.connect(audioContext.destination);
      oscillator.start(t);
      oscillator.stop(t + 0.23);
    } catch { /* Keep the match running if an audio device disappears. */ }
  }

  function spark(x, y, color, amount = 12) {
    for (let i = 0; i < amount; i++) {
      const angle = (Math.PI * 2 * i) / amount + Math.random() * 0.2;
      const speed = 40 + Math.random() * 140;
      particles.push({ x, y, vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed, age: 0, life: 0.3 + Math.random() * 0.3, color, size: 1.8 + Math.random() * 2.2 });
    }
  }

  function announce(kind, side, x, y) {
    lastEvent = { id: ++eventId, kind, side, x, y };
    tone(kind, side);
    if (kind === 'paddle') {
      spark(x, y, side === 0 ? '#ff9a74' : '#fff0c5');
      players[side].glow = 1;
      shake = 2;
    } else if (kind === 'wall') {
      spark(x, y, '#d4edb7', 5);
    } else {
      spark(x, y, '#ffab7d', 22);
      flash = 0.5;
    }
    options.onHit?.(lastEvent);
  }

  function spinLabel(b, self = 0) {
    const total = Math.hypot(b.spinX || 0, b.spinY || 0, b.spinZ || 0);
    if (total < 25) return '不转球';
    const longitudinal = (b.spinX || 0) * Math.sign(b.vy || (self === 0 ? -1 : 1));
    const top = Math.abs(longitudinal) > Math.abs(b.spinY || 0) * 0.7;
    const side = Math.abs(b.spinY || 0) > Math.abs(longitudinal) * 0.7;
    if (top && side) return longitudinal > 0 ? '侧上旋' : '侧下旋';
    if (top) return longitudinal > 0 ? '上旋' : '下旋';
    const turn = (b.spinY || 0) * Math.sign(b.vy || -1) * (self === 1 ? -1 : 1);
    return turn > 0 ? '右侧旋' : '左侧旋';
  }

  function parkBall() {
    const paddle = players[serveSide];
    Object.assign(ball, {
      x: clamp(paddle.x, 190, 810), y: serveSide === 0 ? 738 : 62, height: 0.25,
      vx: 0, vy: 0, vh: 0, spinX: 0, spinY: 0, spinZ: 0, spin: 0, hop: 0,
      lastHitter: serveSide, receiverBounces: 0, serveStage: 0, netCrossed: false, netTouched: false, visible: true,
    });
  }

  function reset(nextPhase = 'ready') {
    score = [0, 0];
    rally = 0;
    bestRally = 0;
    winner = null;
    lastShot = '等待发球';
    serveSide = 0;
    serveAt = 0;
    phase = nextPhase;
    players[0].x = 500;
    players[0].y = 670;
    players[0].vx = players[0].vy = players[0].glow = 0;
    players[1].x = 500;
    players[1].y = 130;
    players[1].vx = players[1].vy = players[1].glow = 0;
    input.x = 500;
    input.y = 670;
    input.vx = input.vy = input.ax = input.ay = 0;
    input.stroke = settings.stroke; input.tilt = settings.tilt; input.height = strokeHeight(settings.stroke); input.gesture = settings.gesture;
    remote.x = 500;
    remote.y = 130;
    remote.vx = remote.vy = remote.ax = remote.ay = 0;
    Object.assign(players[0], { stroke: input.stroke, tilt: input.tilt, height: input.height, ax: 0, ay: 0 });
    Object.assign(players[1], { stroke: 'drive', tilt: 3, height: RACKET_HEIGHT, ax: 0, ay: 0 });
    samples.length = trail.length = particles.length = 0;
    touchStart = null;
    lastTrailAt = elapsed;
    parkBall();
    Object.assign(guestBall, ball);
    emit(true);
  }

  function serve(gesture = null, actor = null) {
    if (mode === 'guest' || phase === 'paused' || phase === 'over') return;
    if (actor !== null && actor !== serveSide) return;
    if (phase === 'idle') phase = 'ready';
    if (phase !== 'ready') return;
    unlockAudio(); parkBall();
    ball.vx = (Math.random() - 0.5) * 25;
    ball.vy = (serveSide === 0 ? -1 : 1) * 5.1 / Z_SCALE;
    ball.vh = -1.5;
    const brush = Number.isFinite(gesture?.brushY) ? clamp(gesture.brushY, -8, 8) : 0;
    if (Math.abs(brush) >= 0.08) {
      const strength = clamp(Math.abs(brush) / 2.4, 0, 1);
      // Gesture directions are in the server's own screen coordinates on both
      // phones. Rotate the spin axis, not the meaning of an upward brush.
      const direction = serveSide === 0 ? -1 : 1;
      ball.spinX = direction * -Math.sign(brush) * (45 + strength * 255);
      ball.vy = direction * (5.1 + strength * 0.55) / Z_SCALE;
      ball.vx = 0;
    }
    ball.serveStage = 1;
    ball.flightId = ++flightId;
    phase = 'playing'; lastShot = `${spinLabel(ball)}发球：先落本方，再落对方`; serveAt = 0;
    trail.length = 0; emit(true);
  }

  function point(side) {
    score[side]++;
    bestRally = Math.max(bestRally, rally);
    announce('point', side, ball.x, clamp(ball.y, 100, 700));
    rally = 0;
    winner = matchWinner(score);
    if (winner !== null) {
      phase = 'over';
      lastShot = '比赛结束';
      ball.visible = false;
    } else {
      phase = 'ready';
      serveSide = Math.floor((score[0] + score[1]) / (Math.min(...score) >= 10 ? 1 : 2)) % 2;
      serveAt = mode === 'demo' || (mode === 'practice' && serveSide === 1) ? elapsed + 1.3 : 0;
      lastShot = side === 0 ? '漂亮得分' : '继续加油';
      parkBall();
    }
    emit(true);
  }

  function strokeHeight(stroke) { return stroke === 'backspin' ? 0.17 : stroke === 'topspin' ? 0.20 : RACKET_HEIGHT; }

  function setPointer(event) {
    const point = view.pointerWorld(event.clientX, event.clientY, event.pointerType === 'touch' ? 32 : 0);
    const x = point.x, y = point.y, t = now();
    const last = samples[samples.length - 1];
    if (last && t - last.t > 250) samples.length = 0;
    const previousVx = input.vx, previousVy = input.vy;
    // Constrain reach, not the measured hand motion: brushing at the edge
    // must keep its speed and direction even when the racket cannot travel farther.
    input.x = clamp(x, PADDLE_REACH.left, PADDLE_REACH.right); input.y = clamp(y, PADDLE_REACH.front, PADDLE_REACH.back);
    // A repeated release coordinate must not erase an otherwise valid stroke.
    if (last && x === last.x && y === last.y && event.type === 'pointerup') return;
    samples.push({ x, y, t });
    while (samples.length > 2 && samples[1].t < t - 45) samples.shift();
    const first = samples[0];
    const delta = Math.max(12, t - first.t) / 1000;
    const vx = clamp((x - first.x) / delta, -3000, 3000);
    const vy = clamp((y - first.y) / delta, -2400, 2400);
    const sampleDt = last && t > last.t ? (t - last.t) / 1000 : 0;
    if (sampleDt > 0 && samples.length > 1) {
      input.ax = clamp(lerp(input.ax, (vx - previousVx) / sampleDt, 0.45), -30000, 30000);
      input.ay = clamp(lerp(input.ay, (vy - previousVy) / sampleDt, 0.45), -25000, 25000);
    } else input.ax = input.ay = 0;
    input.vx = vx; input.vy = vy;
  }

  function requestAction(action, gesture = null) {
    if (action === 'serve' && serveSide !== (mode === 'guest' ? 1 : 0)) return;
    if (options.onAction?.(action, gesture) === true) return;
    if (action === 'serve') serve(gesture, 0);
    else if (action === 'pause') pause();
  }

  function pointerMove(event) {
    if (event.pointerType === 'touch' && activeTouch !== event.pointerId) return;
    setPointer(event);
    recordServePointer(event);
    tryBrushServe();
  }

  function recordServePointer(event) {
    if (!touchStart || event.pointerId !== activeTouch) return;
    touchStart.distance = Math.max(touchStart.distance, Math.hypot(event.clientX - touchStart.x, event.clientY - touchStart.y));
    const path = touchStart.path, last = path[path.length - 1], t = now();
    if (last.x === event.clientX && last.y === event.clientY) return;
    path.push({ x: event.clientX, y: event.clientY, t });
    while (path.length > 2 && path[1].t < t - 100) path.shift();
  }

  function tryBrushServe() {
    if (!touchStart?.serve || !['ready', 'idle'].includes(phase)) return;
    const path = touchStart.path, first = path[0], last = path[path.length - 1];
    const height = canvas.getBoundingClientRect?.().height || 800;
    if (now() - last.t > 160 || Math.abs(last.y - first.y) < clamp(height * 0.035, 12, 22)) return;
    const brushY = clamp((last.y - first.y) / height / (Math.max(16, last.t - first.t) / 1000), -8, 8);
    if (Math.abs(brushY) < 0.08) return;
    // Fire once while the finger is brushing; a held touch and its later release
    // must not enqueue a second serve or reuse this gesture on the next point.
    touchStart.serve = false;
    requestAction('serve', { brushY });
  }

  function pointerDown(event) {
    if (event.pointerType === 'touch' || phase === 'ready' || phase === 'idle') {
      if (activeTouch !== null) return;
      activeTouch = event.pointerId;
      touchStart = { x: event.clientX, y: event.clientY, t: now(), distance: 0,
        serve: phase === 'ready' || phase === 'idle', path: [{ x: event.clientX, y: event.clientY, t: now() }] };
      samples.length = 0;
      input.vx = input.vy = input.ax = input.ay = 0;
      input.stroke = settings.stroke; input.tilt = settings.tilt; input.height = strokeHeight(settings.stroke); input.gesture = settings.gesture;
      if (mode !== 'guest') players[0].vx = players[0].vy = 0;
      try { canvas.setPointerCapture(event.pointerId); } catch { /* The pointer can end during capture. */ }
    }
    setPointer(event);
    unlockAudio();
  }

  function pointerUp(event) {
    if (event.pointerId !== activeTouch) return;
    if (event.type !== 'pointercancel') { setPointer(event); recordServePointer(event); tryBrushServe(); }
    else { samples.length = 0; input.vx = input.vy = input.ax = input.ay = 0; }
    activeTouch = null;
    touchStart = null;
    try { canvas.releasePointerCapture(event.pointerId); } catch { /* Capture may already have been released. */ }
  }

  function keyDown(event) {
    if (event.code !== 'Space' || event.repeat) return;
    const active = document.activeElement;
    if (active && (['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON'].includes(active.tagName) || active.isContentEditable)) return;
    event.preventDefault();
    if (phase === 'playing' || phase === 'paused') requestAction('pause');
  }

  function updateLocalPaddle(dt) {
    const p = players[0];
    if (samples.length && now() - samples[samples.length - 1].t > 90) {
      input.vx *= Math.exp(-dt * 19);
      input.vy *= Math.exp(-dt * 19);
      input.ax *= Math.exp(-dt * 25); input.ay *= Math.exp(-dt * 25);
    }
    const smoothing = 1 - Math.exp(-dt * 110);
    p.x = lerp(p.x, input.x, smoothing);
    p.y = lerp(p.y, input.y, smoothing);
    p.vx = input.vx;
    p.vy = input.vy;
    p.ax = input.ax; p.ay = input.ay; p.stroke = input.stroke; p.tilt = input.tilt; p.height = input.height; p.gesture = input.gesture;
    assistTouchPose(p, ball, dt);
    input.stroke = p.stroke; input.tilt = p.tilt; input.height = p.height;
  }

  function assistTouchPose(p, incoming, dt) {
    if (!p.gesture) return;
    const forward = -p.vy * Z_SCALE;
    p.stroke = forward > 0.25 ? 'topspin' : forward < -0.25 ? 'backspin' : 'drive';
    const coming = incoming.vy > 0 && incoming.lastHitter !== 0;
    const top = (incoming.spinX || 0) * Math.sign(incoming.vy || 1);
    const base = p.stroke === 'backspin' ? 9 : p.stroke === 'topspin' ? 2 : 7;
    // Broad automatic face assistance leaves spin/strength to the hand gesture.
    p.tilt = elapsed < (p.angleUntil || 0) ? p.assistAngle : clamp(base - (coming ? top / 100 : 0), -8, 18);
    const inReach = coming && incoming.receiverBounces === 1 && Math.abs(incoming.y - p.y) < 200 && Math.abs(incoming.x - p.x) < 180;
    if (inReach) { p.assistHeight = clamp(incoming.height, 0.08, 1.1); p.assistUntil = elapsed + 0.14; }
    const targetHeight = inReach || elapsed < (p.assistUntil || 0) ? p.assistHeight : RACKET_HEIGHT;
    p.height = lerp(p.height || RACKET_HEIGHT, targetHeight, 1 - Math.exp(-dt * 95));
  }

  function updateAI(side, dt) {
    const p = players[side];
    const ai = aiPlayers[side];
    const difficulty = mode === 'demo' ? 'hard' : settings.difficulty;
    const params = difficulty === 'easy' ? { speed: 620, error: 42, reaction: 0.12 } : difficulty === 'hard' ? { speed: 1450, error: 8, reaction: 0.035 } : { speed: 1000, error: 22, reaction: 0.065 };
    const coming = ball.lastHitter !== side && (side === 0 ? ball.vy > 0 : ball.vy < 0);
    if (elapsed > ai.nextThink) {
      ai.nextThink = elapsed + params.reaction;
      const predicted = { ...ball };
      const destination = side === 0 ? 654 : 146;
      if (coming) for (let i = 0; i < 180; i++) {
        stepBallFlight(predicted, 1 / 240);
        if ((side === 0 ? predicted.y >= destination : predicted.y <= destination) || predicted.height < -0.2) break;
      }
      ai.error = (Math.random() - 0.5) * params.error * 2;
      ai.aim = clamp((coming ? predicted.x : 500) + ai.error, 175, 825);
      ai.height = clamp(coming ? predicted.height : RACKET_HEIGHT, 0.10, 0.55);
      if (coming && predicted.height >= BALL_RADIUS) {
        let bestCost = Infinity;
        // The practice partner tests a few real racket angles against the same
        // flight model. No scripted return velocity or automatic net clearance.
        for (const tilt of [-12, -6, 0, 3, 6, 9, 12, 18, 24]) {
          const shot = computeShot({ vx: 0, vy: (side === 0 ? -1 : 1) * 2.2 / Z_SCALE, tilt, stroke: 'drive' }, predicted.x, side, rally, predicted);
          const trial = { ...predicted, ...shot };
          let cost = 10000;
          for (let i = 0; i < 180; i++) {
            const contacts = stepBallFlight(trial, 1 / 240);
            if (!contacts.length) continue;
            const hit = contacts[0];
            if (hit.type === 'table' && hit.side !== side) cost = Math.abs(hit.y - (side === 0 ? 200 : 600)) + Math.abs(tilt) * 0.1;
            break;
          }
          if (cost < bestCost) { bestCost = cost; ai.tilt = tilt; }
        }
      }
    }
    const dx = clamp(ai.aim - p.x, -params.speed * dt, params.speed * dt);
    p.x += dx;
    // The practice partner actively blocks at a controlled angle; the human
    // racket remains fully governed by its selected stroke and hand motion.
    p.vx = coming ? clamp(dx / dt * 0.35, -650, 650) : 0;
    p.vy = coming && ball.receiverBounces === 1 ? (side === 0 ? -1 : 1) * 2.2 / Z_SCALE : 0;
    p.ax = p.ay = 0; p.stroke = 'drive'; p.gesture = false;
    p.tilt = ai.tilt;
    p.height = lerp(p.height || RACKET_HEIGHT, ai.height || RACKET_HEIGHT, 1 - Math.exp(-dt * 35));
    p.y = side === 0 ? 670 : 130;
  }

  function updateRemote(dt) {
    const p = players[1];
    const freshness = now() - remoteSeenAt;
    // The guest already renders its immediate input. Adding another smoothing
    // delay here made the authoritative racket trail the one the guest saw.
    // Swept collision below covers the path between received positions;
    // shot velocity remains the measured gesture, never a network jump.
    p.x = remote.x;
    p.y = remote.y;
    p.vx = freshness < 160 ? remote.vx : 0;
    p.vy = freshness < 180 ? remote.vy : 0;
    p.ax = freshness < 180 ? remote.ax : 0; p.ay = freshness < 180 ? remote.ay : 0;
    p.stroke = remote.stroke; p.tilt = remote.tilt; p.height = remote.height; p.gesture = remote.gesture;
  }

  function touchReturn(paddle, side, incoming) {
    if (!paddle.gesture) return computeShot(paddle, incoming.x, side, rally, incoming);
    let best = computeShot(paddle, incoming.x, side, rally, incoming);
    let bestTilt = paddle.tilt, bestCost = Infinity;
    const target = side === 0 ? (paddle.stroke === 'backspin' ? 290 : 200) : (paddle.stroke === 'backspin' ? 510 : 600);
    // Coarse face assistance is evaluated only at an actual hit. It compensates
    // for the pitch that a two-dimensional finger cannot express; speed, spin,
    // sideways direction and whether contact happens still come from the hand.
    for (let tilt = -12; tilt <= 36; tilt += 2) {
      const shot = computeShot({ ...paddle, tilt }, incoming.x, side, rally, incoming);
      const trial = { ...incoming, ...shot }; let cost = Infinity;
      for (let i = 0; i < 300; i++) {
        const contact = stepBallFlight(trial, 1 / 240)[0];
        if (!contact) continue;
        if (contact.type === 'table' && contact.side !== side) cost = Math.abs(contact.y - target) + Math.abs(tilt - paddle.tilt) * 0.3;
        break;
      }
      if (cost < bestCost) { bestCost = cost; best = shot; bestTilt = tilt; }
    }
    players[side].tilt = bestTilt;
    players[side].assistAngle = bestTilt; players[side].angleUntil = elapsed + 0.14;
    return best;
  }

  function escapedWinner() { return ball.receiverBounces >= 1 ? ball.lastHitter : 1 - ball.lastHitter; }

  function updateBall(dt, previousPlayers) {
    let remaining = dt;
    let consumed = 0;
    function paddleAt(side, fraction) {
      const from = previousPlayers[side], to = players[side];
      const result = { ...to };
      for (const key of ['x', 'y', 'height', 'tilt']) {
        const a = Number.isFinite(from[key]) ? from[key] : key === 'height' ? RACKET_HEIGHT : 0;
        const b = Number.isFinite(to[key]) ? to[key] : a;
        result[key] = lerp(a, b, fraction);
      }
      return result;
    }
    function noteCrossing(before) {
      if ((before.y - 400) * (ball.y - 400) < 0) ball.netCrossed = true;
    }
    function worldEvents(events) {
      for (const event of events) {
        if (event.type === 'net') { ball.netTouched = true; lastShot = '触网'; tone('wall'); }
        if (event.type === 'floor') { point(escapedWinner()); return true; }
        if (event.type !== 'table') continue;
        tone('wall');
        const side = event.side;
        if (ball.serveStage === 1) {
          if (side !== ball.lastHitter) { point(1 - ball.lastHitter); return true; }
          ball.serveStage = 2;
        } else if (ball.serveStage === 2) {
          if (side === ball.lastHitter) { point(1 - ball.lastHitter); return true; }
          if (ball.netTouched) { phase = 'ready'; serveAt = mode === 'demo' || (mode === 'practice' && serveSide === 1) ? elapsed + 0.8 : 0; lastShot = '擦网重发'; parkBall(); emit(true); return true; }
          ball.serveStage = 0; ball.receiverBounces = 1;
        } else if (ball.receiverBounces >= 1) { point(ball.lastHitter); return true; }
        else if (side === ball.lastHitter) { lastShot = '回球未过网'; point(1 - ball.lastHitter); return true; }
        else ball.receiverBounces++;
      }
      return false;
    }
    // Work only on the continuous trajectory up to the next physical event.
    // Testing a racket against a whole step containing a later bounce would
    // grant an illegal volley or award a second bounce before a legal return.
    for (let segment = 0; remaining > 1e-9 && segment < 8; segment++) {
      const before = { ...ball };
      const forecast = { ...before };
      const forecastEvents = stepBallFlight(forecast, remaining) || [];
      let continuousDuration = remaining;
      let continuousEnd = forecast;
      let worldDuration = remaining;
      let worldEnd = forecast;
      let nextWorldEvents = forecastEvents;
      if (forecastEvents.length) {
        // Locate both sides of the first TOI using the same integrator. This
        // preserves exact impact velocity and avoids evaluating CCD through
        // a discontinuous net/table rebound. Error is under 1 microsecond at
        // the 240 Hz simulation rate, only on steps containing a world hit.
        let low = 0, high = remaining;
        continuousEnd = { ...before };
        for (let iteration = 0; iteration < 12; iteration++) {
          const middle = (low + high) / 2;
          const candidate = { ...before };
          const candidateEvents = stepBallFlight(candidate, middle) || [];
          if (candidateEvents.length) { high = middle; worldEnd = candidate; nextWorldEvents = candidateEvents; }
          else { low = middle; continuousEnd = candidate; }
        }
        continuousDuration = low;
        worldDuration = high;
      }
      let earliest = null;
      if (continuousDuration > 1e-10) {
        const startFraction = consumed / dt;
        const endFraction = (consumed + continuousDuration) / dt;
        for (let side = 0; side < 2; side++) {
          if (side === ball.lastHitter) continue;
          const contact = sweptRacketContact(before, continuousEnd, paddleAt(side, startFraction), paddleAt(side, endFraction), side);
          if (contact && (!earliest || contact.time < earliest.contact.time)) earliest = { side, contact };
        }
      }
      if (earliest) {
        const { side, contact } = earliest;
        const travel = continuousDuration * contact.time;
        // No world event precedes this contact. Integrate from the real prior
        // state, so drag, Magnus force and incoming spin are evaluated at the
        // impact itself rather than after a later table/net collision.
        stepBallFlight(ball, travel);
        noteCrossing(before);
        if (ball.serveStage !== 0 || ball.receiverBounces !== 1) { lastShot = '请等球落台后再接'; point(ball.lastHitter); return; }
        const incoming = { ...ball };
        Object.assign(ball, touchReturn(contact.paddle, side, incoming));
        ball.lastHitter = side; ball.receiverBounces = 0; ball.serveStage = 0;
        ball.netCrossed = false; ball.netTouched = false; ball.hop = 0; ball.flightId = ++flightId;
        rally++; bestRally = Math.max(bestRally, rally);
        lastShot = spinLabel(ball) + ' · ' + Math.round(Math.hypot(ball.vx * X_SCALE, ball.vy * Z_SCALE, ball.vh) * 3.6) + ' km/h';
        announce('paddle', side, ball.x, ball.y);
        trail.length = 0;
        consumed += travel;
        remaining -= travel;
        continue;
      }
      Object.assign(ball, forecastEvents.length ? worldEnd : forecast);
      noteCrossing(before);
      consumed += forecastEvents.length ? worldDuration : remaining;
      remaining -= forecastEvents.length ? worldDuration : remaining;
      if (forecastEvents.length && worldEvents(nextWorldEvents)) return;
    }
    // The bound protects malformed restored states that repeatedly overlap a
    // surface. Ordinary rallies use one or two segments per simulation step.
    if (remaining > 1e-9) {
      const before = { ...ball };
      const events = stepBallFlight(ball, remaining) || [];
      noteCrossing(before);
      if (worldEvents(events)) return;
    }
    const outside = ball.x < COURT.left - BALL_RADIUS / X_SCALE || ball.x > COURT.right + BALL_RADIUS / X_SCALE || ball.y < COURT.top - 5 || ball.y > COURT.bottom + 5;
    if ((outside && ball.height < BALL_RADIUS && ball.vh < 0) || ball.height < -0.6 || ball.y < -280 || ball.y > 1080 || ball.x < -300 || ball.x > 1300 || ball.hop > 5) point(escapedWinner());
  }

  function update(dt) {
    elapsed += dt;
    if (mode === 'guest') {
      // A local cursor stays immediate while the authoritative ball is smoothed.
      if (samples.length && now() - samples[samples.length - 1].t > 90) {
        input.vx *= Math.exp(-dt * 19);
        input.vy *= Math.exp(-dt * 19);
        input.ax *= Math.exp(-dt * 25); input.ay *= Math.exp(-dt * 25);
      }
      assistTouchPose(input, { ...ball, x: 1000 - ball.x, y: 800 - ball.y, vy: -ball.vy, spinX: -ball.spinX, lastHitter: 1 - ball.lastHitter }, dt);
      const ahead = phase === 'playing' ? Math.min((now() - receivedAt) / 1000, 0.07) : 0;
      const predictedBall = { ...ball };
      if (ahead > 0) stepBallFlight(predictedBall, ahead);
      const targetX = predictedBall.x;
      const targetY = predictedBall.y;
      const blend = 1 - Math.exp(-dt * 30);
      guestBall.x = lerp(guestBall.x, targetX, blend);
      guestBall.y = lerp(guestBall.y, targetY, blend);
      const smoothedX = guestBall.x, smoothedY = guestBall.y;
      const smoothedHeight = lerp(guestBall.height, predictedBall.height, blend);
      Object.assign(guestBall, predictedBall, { x: smoothedX, y: smoothedY, height: smoothedHeight });
    } else if (phase !== 'paused' && phase !== 'over') {
      const previousPlayers = players.map((p) => ({ ...p }));
      if (mode === 'demo') updateAI(0, dt);
      else updateLocalPaddle(dt);
      if (mode === 'practice' || mode === 'demo') updateAI(1, dt);
      else updateRemote(dt);
      if (phase === 'playing') updateBall(dt, previousPlayers);
      else {
        parkBall();
        if (serveAt && elapsed >= serveAt) serve();
      }
    } else if (mode === 'demo' && phase === 'over') {
      reset('ready');
      serveAt = elapsed + 0.7;
    }
    players.forEach((p) => { p.glow = Math.max(0, p.glow - dt * 4); });
    for (let i = particles.length - 1; i >= 0; i--) {
      const particle = particles[i];
      particle.age += dt;
      particle.x += particle.vx * dt;
      particle.y += particle.vy * dt;
      particle.vx *= Math.exp(-dt * 3);
      particle.vy *= Math.exp(-dt * 3);
      if (particle.age >= particle.life) particles.splice(i, 1);
    }
    shake *= Math.exp(-dt * 20);
    flash *= Math.exp(-dt * 5);
    if (phase === 'playing' && settings.trails && elapsed - lastTrailAt >= 0.02) {
      const b = mode === 'guest' ? guestBall : ball;
      trail.push({ x: b.x, y: b.y, height: b.height, spinX: b.spinX, spinY: b.spinY, spinZ: b.spinZ, vx: b.vx, vy: b.vy, age: 0 });
      if (trail.length > 36) trail.shift();
      lastTrailAt = elapsed;
    }
    for (let i = trail.length - 1; i >= 0; i--) {
      trail[i].age += dt;
      if (trail[i].age > 0.7) trail.splice(i, 1);
    }
    emit();
  }

  function draw() {
    const activeBall = mode === 'guest' ? guestBall : ball;
    view.render({ players, input, ball: activeBall, ballHeight: getBallHeight(activeBall, phase, elapsed), phase, mode, elapsed, trail, particles, shake, flash });
  }

  function resize() { view.resize(); draw(); }

  function frame(t) {
    if (destroyed) return;
    const dt = Math.min(Math.max((t - lastFrame) / 1000, 0.001), 0.045);
    lastFrame = t;
    // Substeps avoid a fast shot skipping a paddle on a busy frame.
    const steps = Math.ceil(dt / (1 / 240));
    for (let i = 0; i < steps; i++) update(dt / steps);
    draw();
    frameId = requestAnimationFrame(frame);
  }

  function pause() {
    if (mode === 'guest' || mode === 'demo' || phase === 'idle' || phase === 'over') return;
    if (phase === 'paused') phase = beforePause;
    else { beforePause = phase; phase = 'paused'; }
    emit(true);
  }

  function snapshot() {
    return {
      version: 2, phase, score: [...score], rally, bestRally, winner, lastShot,
      serveSide, players: players.map((p) => ({ ...p })),
      ball: { ...ball }, event: lastEvent ? { ...lastEvent } : null,
    };
  }

  function applySnapshot(state) {
    if (mode !== 'guest' || !state || state.version !== 2 || !Array.isArray(state.players) || state.players.length !== 2 || !state.ball) return;
    if (!['idle', 'ready', 'playing', 'paused', 'over'].includes(state.phase)) return;
    if (!Array.isArray(state.score) || state.score.length !== 2 || !state.score.every(Number.isFinite)) return;
    if (!state.players.every((p) => p && typeof p === 'object')) return;
    if (![state.ball.x, state.ball.y, state.ball.vx, state.ball.vy, state.ball.height, state.ball.vh, state.ball.spinX, state.ball.spinY, state.ball.spinZ, state.ball.spin, ...state.players.flatMap((p) => [p.x, p.y, p.vx, p.vy])].every(Number.isFinite)) return;
    phase = state.phase;
    score = state.score.map((value) => clamp(Math.floor(value), 0, 999));
    rally = Number(state.rally) || 0;
    bestRally = Number(state.bestRally) || 0;
    winner = state.winner === 0 || state.winner === 1 ? state.winner : null;
    lastShot = typeof state.lastShot === 'string' ? state.lastShot : '';
    serveSide = state.serveSide === 1 ? 1 : 0;
    state.players.forEach((p, i) => Object.assign(players[i], p));
    const initial = !receivedAt;
    // A new shot changes the entire height curve and travel direction. Do not
    // evaluate that new curve at the old flight's interpolated ball position.
    const newFlight = phase === 'playing' &&
      (ball.flightId !== state.ball.flightId || Math.sign(ball.vy) !== Math.sign(state.ball.vy));
    Object.assign(ball, state.ball);
    if (newFlight) trail.length = 0;
    if (initial || newFlight || phase !== 'playing') Object.assign(guestBall, ball);
    receivedAt = now();
    if (state.event && Number.isFinite(state.event.id) && [state.event.x, state.event.y].every(Number.isFinite) && [0, 1].includes(state.event.side) && ['paddle', 'wall', 'point'].includes(state.event.kind) && state.event.id !== seenEvent) {
      seenEvent = state.event.id;
      const e = state.event;
      if (e.kind === 'paddle') { spark(e.x, e.y, e.side === 1 ? '#ff9a74' : '#fff0c5'); players[e.side].glow = 1; }
      if (!initial) { tone(e.kind, e.side === 1 ? 0 : 1); options.onHit?.(e); }
    }
    emit();
  }

  const observer = new ResizeObserver(resize);
  observer.observe(canvas);
  canvas.style.touchAction = 'none';
  canvas.addEventListener('pointermove', pointerMove);
  canvas.addEventListener('pointerdown', pointerDown);
  canvas.addEventListener('pointerup', pointerUp);
  canvas.addEventListener('pointercancel', pointerUp);
  document.addEventListener('keydown', keyDown);
  resize();
  emit(true);
  frameId = requestAnimationFrame(frame);

  return {
    setMode(nextMode) {
      if (!['practice', 'host', 'guest', 'demo'].includes(nextMode)) return;
      mode = nextMode;
      receivedAt = 0;
      remoteSeenAt = 0;
      reset(nextMode === 'demo' || nextMode === 'host' ? 'ready' : 'idle');
      if (nextMode === 'demo') serveAt = elapsed + 0.8;
    },
    setStroke(stroke) { if (!['drive', 'topspin', 'backspin'].includes(stroke)) return; settings.gesture = input.gesture = false; settings.stroke = input.stroke = stroke; input.height = strokeHeight(stroke); settings.tilt = input.tilt = stroke === 'backspin' ? 7 : stroke === 'topspin' ? 0 : 3; },
    setTilt(degrees) { if (Number.isFinite(degrees)) settings.tilt = input.tilt = clamp(degrees, -30, 35); },
    setDifficulty(difficulty) { if (['easy', 'normal', 'hard'].includes(difficulty)) settings.difficulty = difficulty; },
    start() {
      if (mode === 'demo') mode = 'practice';
      if (phase === 'idle' || phase === 'over') reset('ready');
      else if (phase === 'paused') pause();
      unlockAudio();
      emit(true);
    },
    pause,
    restart() { if (mode !== 'guest') { reset('ready'); if (mode === 'demo') serveAt = elapsed + 0.8; } },
    serve,
    setRemoteInput(value) {
      if (mode !== 'host' || !value || ![value.x, value.y, value.vx, value.vy].every(Number.isFinite)) return;
      const normalized = rotateInput({ x: clamp(value.x, PADDLE_REACH.left, PADDLE_REACH.right), y: clamp(value.y, PADDLE_REACH.front, PADDLE_REACH.back), vx: clamp(value.vx, -3000, 3000), vy: clamp(value.vy, -2400, 2400) });
      Object.assign(remote, normalized, {
        ax: Number.isFinite(value.ax) ? clamp(-value.ax, -30000, 30000) : 0,
        ay: Number.isFinite(value.ay) ? clamp(-value.ay, -25000, 25000) : 0,
        gesture: value.gesture === true,
        stroke: ['drive', 'topspin', 'backspin'].includes(value.stroke) ? value.stroke : 'drive',
        tilt: Number.isFinite(value.tilt) ? clamp(value.tilt, -30, 35) : 3,
        height: Number.isFinite(value.height) ? clamp(value.height, 0.08, 1.1) : RACKET_HEIGHT,
      });
      remoteSeenAt = now();
    },
    getInput() { return { ...input }; },
    snapshot,
    applySnapshot,
    setSound(enabled) { settings.sound = !!enabled; if (enabled) unlockAudio(); },
    setTrails(enabled) { settings.trails = !!enabled; if (!enabled) trail.length = 0; },
    destroy() {
      destroyed = true;
      cancelAnimationFrame(frameId);
      observer.disconnect();
      canvas.removeEventListener('pointermove', pointerMove);
      canvas.removeEventListener('pointerdown', pointerDown);
      canvas.removeEventListener('pointerup', pointerUp);
      canvas.removeEventListener('pointercancel', pointerUp);
      document.removeEventListener('keydown', keyDown);
      audioContext?.close().catch(() => {});
      view.destroy();
    },
  };
}
