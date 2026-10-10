import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

// Exercise the real input handlers, simulation and snapshot consumer, replacing
// only the WebGL view so these regressions can run without a browser or GPU.
const sourceURL = new URL('../lib/game.js', import.meta.url);
let source = await readFile(sourceURL, 'utf8');
source = source.replace(/import\s*\{\s*createScene3D\s*\}\s*from\s*['"]\.\/scene3d\.js['"];?/, 'const createScene3D = (...args) => globalThis.__testScene3D(...args);');
source = source.replace(/from\s*(['"])(\.\/[^'"]+)\1/g, (_, quote, path) => `from ${quote}${new URL(path, sourceURL).href}${quote}`);
const { createGame, getBallHeight } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
const { X_SCALE, Z_SCALE, BALL_RADIUS, stepBallFlight } = await import('../lib/physics.js');

function setIncoming(h, overrides = {}) {
  // A legal ball approaching the near racket after its receiving-side bounce.
  const p = h.state.players[0];
  Object.assign(h.state.ball, {
    x: p.x, y: p.y - 9, vx: 0, vy: 600,
    height: p.height ?? 0.23, vh: 0,
    spin: 0, spinX: 0, spinY: 0, spinZ: 0, hop: 0,
    lastHitter: 1, receiverBounces: 1, netCrossed: true,
    serveStage: 0, visible: true,
    ...overrides,
  });
}

function playSwipe(direction) {
  const h = harness();
  h.pointer('pointerdown', 500 - direction * 90, 670);
  h.settle(400);
  h.pointer('pointermove', 500 - direction * 90, 670);
  h.game.serve();
  h.advance(60); h.pointer('pointermove', 500, 670);
  h.step(16);
  setIncoming(h, { x: h.state.players[0].x + direction * 12 });
  h.step(24);
  return h;
}

const ballSpeed = (ball) => Math.hypot(ball.vx * X_SCALE, ball.vy * Z_SCALE, ball.vh);

function forwardReturn({ duration = 120, stroke = 'drive', tilt = 0, spinX = 0 } = {}) {
  const h = harness();
  h.game.setStroke(stroke); h.game.setTilt(tilt);
  h.pointer('pointerdown', 500, 700);
  h.settle(420); h.pointer('pointerup', 500, 700);
  h.pointer('pointerdown', 500, 700, 2);
  for (let i = 1; i <= 6; i++) {
    h.advance(duration / 6 - 1);
    h.pointer('pointermove', 500, 700 - 100 * (i / 6) ** 2, 2);
    h.step(1);
  }
  h.game.serve();
  setIncoming(h, { spinX });
  h.step(16);
  assert.ok(h.hits.some((event) => event.kind === 'paddle' && event.side === 0), 'the forward stroke fixture must produce a legal racket return');
  return h;
}

function harness(mode = 'host', options = {}) {
  let clock = 1000;
  let frameID = 0;
  let state;
  const frames = new Map();
  const listeners = new Map();
  const hits = [];
  const updates = [];
  const originalGlobals = new Map(['performance', 'window', 'document', 'ResizeObserver', 'requestAnimationFrame', 'cancelAnimationFrame', '__testScene3D'].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const canvas = {
    style: {},
    addEventListener(type, listener) { listeners.set(type, listener); },
    removeEventListener(type) { listeners.delete(type); },
    setPointerCapture() {},
    releasePointerCapture() {},
  };
  Object.defineProperty(globalThis, 'performance', { configurable: true, value: { now: () => clock } });
  globalThis.window = {};
  globalThis.document = { activeElement: null, addEventListener() {}, removeEventListener() {} };
  globalThis.ResizeObserver = class { observe() {} disconnect() {} };
  globalThis.requestAnimationFrame = (callback) => { frames.set(++frameID, callback); return frameID; };
  globalThis.cancelAnimationFrame = (id) => frames.delete(id);
  globalThis.__testScene3D = () => ({
    resize() {}, destroy() {},
    pointerWorld: (x, y) => ({ x, y }),
    render: (value) => { state = value; },
  });
  const game = createGame(canvas, { onHit: (event) => hits.push({ ...event }), onUpdate: (update) => updates.push(update), ...options });
  game.setSound(false);
  game.setMode(mode);
  const fixture = {
    game, hits, updates,
    get state() { return state; },
    get clock() { return clock; },
    pointer(type, x, y, pointerID = 1, pointerType = 'touch') {
      listeners.get(type)?.({ type, clientX: x, clientY: y, pointerType, pointerId: pointerID });
    },
    advance(ms) { clock += ms; },
    step(ms = 16) {
      clock += ms;
      const callbacks = [...frames.values()]; frames.clear();
      callbacks.forEach((callback) => callback(clock));
      return state;
    },
    settle(ms = 200) { for (let i = 0; i < Math.ceil(ms / 16); i++) fixture.step(16); },
    close() {
      game.destroy();
      for (const [key, descriptor] of originalGlobals) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else delete globalThis[key];
      }
    },
  };
  fixture.step(1);
  return fixture;
}

test('a new touch starts a fresh stroke instead of reusing an old finger position', () => {
  const h = harness();
  try {
    h.pointer('pointerdown', 500, 650);
    h.advance(20); h.pointer('pointermove', 700, 650);
    assert.ok(h.game.getInput().vx > 1000, 'the first genuine swipe should have velocity');
    h.pointer('pointerup', 700, 650);
    h.advance(900);
    h.pointer('pointerdown', 200, 650, 2);
    assert.equal(h.game.getInput().vx, 0, 'placing a new finger must not create a left-spin shot');
    assert.equal(h.game.getInput().vy, 0);
  } finally { h.close(); }
});

test('movement after a long stationary touch does not use stale stroke samples', () => {
  const h = harness();
  try {
    h.pointer('pointerdown', 500, 650);
    h.advance(20); h.pointer('pointermove', 700, 650);
    h.advance(900); h.pointer('pointermove', 200, 650);
    assert.equal(h.game.getInput().vx, 0, 'the first sample after a long pause must reset the stroke');
    h.advance(40); h.pointer('pointermove', 240, 650);
    assert.ok(h.game.getInput().vx > 0, 'fresh samples must produce the intended rightward swipe');
  } finally { h.close(); }
});

test('a 180 ms touch swipe with merged movement events still produces a controlled spin return', () => {
  const spins = [];
  for (const direction of [-1, 1]) {
    const h = harness();
    try {
      h.game.serve();
      h.pointer('pointerdown', 500 - direction * 90, 670);
      h.advance(180); h.pointer('pointermove', 500 + direction * 90, 670);
      const movingVelocity = h.game.getInput().vx;
      assert.ok(movingVelocity * direction >= 500, 'merged events must preserve a genuine swipe');
      assert.ok(Math.abs(movingVelocity) <= 1900, 'the sparse-event estimate must remain bounded');
      h.advance(1); h.pointer('pointerup', 500 + direction * 90, 670);
      assert.ok(h.game.getInput().vx * direction >= 500, 'a repeated release endpoint must preserve the stroke');
      setIncoming(h, { x: 500 + direction * 35, y: 661, vy: 120 });
      h.step(45);
      assert.ok(h.hits.some((event) => event.kind === 'paddle' && event.side === 0));
      const spin = h.game.snapshot().ball.spinY;
      assert.ok(Math.abs(spin) > 5, 'the returned ball must actually have sidespin');
      spins.push(spin);
    } finally { h.close(); }
  }
  assert.ok(spins[0] * spins[1] < 0, 'opposite sparse swipes must create opposite rotation');
});

test('left and right touch swipes create opposite real spin and curved flights', () => {
  const results = [];
  for (const direction of [-1, 1]) {
    let shot, curved;
    const h = playSwipe(direction);
    try {
      assert.ok(h.hits.some((event) => event.kind === 'paddle' && event.side === 0));
      shot = h.game.snapshot().ball;
      assert.ok(Math.abs(shot.spinY) > 5);
      assert.ok(shot.vy < 0, 'a successful return must travel toward the opponent');
      h.settle(160);
      assert.equal(h.game.snapshot().phase, 'playing');
      curved = h.game.snapshot().ball;
    } finally { h.close(); }
    // Replay the same outgoing state without spin through another real game.
    // Comparing against a straight tangent would also count drag as curvature.
    const control = harness();
    try {
      control.game.serve(); Object.assign(control.state.ball, shot, { spin: 0, spinX: 0, spinY: 0, spinZ: 0 });
      control.settle(160);
      const departure = curved.x - control.game.snapshot().ball.x;
      assert.ok(Math.abs(departure) > 0.5, 'rotation must alter the actual path beyond drag and the initial diagonal heading');
      results.push({ spin: shot.spinY, departure });
    } finally { control.close(); }
  }
  assert.ok(results[0].spin * results[1].spin < 0);
  assert.ok(results[0].departure * results[1].departure < 0);
});

test('a moving racket sweeping across an arriving ball registers contact', () => {
  const h = harness();
  try {
    h.pointer('pointerdown', 350, 670); h.settle(420);
    h.pointer('pointermove', 350, 670); h.game.serve();
    setIncoming(h, { x: 500, y: 665, vy: 90 });
    h.advance(20); h.pointer('pointermove', 650, 670); h.step(45);
    assert.ok(h.hits.some((event) => event.kind === 'paddle' && event.side === 0), 'contact between two visible racket positions must not be skipped');
    assert.ok(h.game.snapshot().ball.vy < 0);
  } finally { h.close(); }
});

test('a racket return preserves physical height without jumping to a preset arc', () => {
  const h = harness();
  try {
    h.game.serve(); setIncoming(h, { y: 663, height: 0.29, vh: 0 });
    const heightBefore = getBallHeight(h.state.ball, 'playing');
    h.step(16);
    assert.ok(h.hits.some((event) => event.kind === 'paddle' && event.side === 0));
    const shot = h.game.snapshot().ball;
    assert.ok(Math.abs(shot.height - heightBefore) < 0.04, `the ball jumped at contact: ${heightBefore} -> ${shot.height}`);
    assert.equal(getBallHeight(shot, 'playing'), shot.height);
    assert.equal(shot.receiverBounces, 0, 'the new opponent has not received a bounce yet');
    assert.equal(shot.lastHitter, 0);
  } finally { h.close(); }
});

test('accelerating a fast forward swipe sends a materially faster ball than a slow push', () => {
  const results = [];
  for (const duration of [360, 90]) {
    const h = forwardReturn({ duration });
    try {
      const input = h.game.getInput(), shot = h.game.snapshot().ball;
      assert.ok(Number.isFinite(input.ax) && Number.isFinite(input.ay), 'gesture acceleration must be measured');
      results.push({ speed: ballSpeed(shot), gestureSpeed: Math.abs(input.vy) });
    } finally { h.close(); }
  }
  assert.ok(results[1].gestureSpeed > results[0].gestureSpeed * 2);
  assert.ok(results[1].speed > results[0].speed * 1.35, `fast/slow ball speed difference is too small: ${results[1].speed}/${results[0].speed}`);
});

test('topspin and backspin stroke choices produce different physical rotation and flight', () => {
  const results = {};
  for (const stroke of ['topspin', 'backspin']) {
    const h = forwardReturn({ stroke, tilt: 14 });
    try {
      const initial = h.game.snapshot().ball;
      assert.ok(Math.abs(initial.spinX) > 5, `${stroke} must create actual angular velocity`);
      h.settle(160);
      assert.equal(h.game.snapshot().phase, 'playing');
      const final = h.game.snapshot().ball;
      results[stroke] = { spin: initial.spinX, drop: final.vh - initial.vh };
    } finally { h.close(); }
  }
  assert.ok(results.topspin.spin * results.backspin.spin < 0, 'the two strokes must not share a label-only spin');
  assert.ok(results.topspin.drop < results.backspin.drop - 0.1, 'topspin must dive more strongly than backspin');
});

test('closing the racket suppresses topspin lift while opening it lifts a backspin return', () => {
  const results = {};
  for (const [name, spinX, tilt] of [['topNeutral', 180, 0], ['topClosed', 180, -18], ['backNeutral', -180, 0], ['backOpen', -180, 18]]) {
    const h = forwardReturn({ duration: 160, spinX, tilt });
    try { results[name] = h.game.snapshot().ball.vh; }
    finally { h.close(); }
  }
  assert.ok(results.topClosed < results.topNeutral - 0.15, 'a closed face must help control an incoming topspin ball');
  assert.ok(results.backOpen > results.backNeutral + 0.15, 'an open face must help lift an incoming backspin ball');
});

test('one receiver-side table bounce is legal and a second bounce loses the receiver the point', () => {
  const h = harness();
  try {
    h.game.serve(); setIncoming(h, { y: 550, height: BALL_RADIUS + 0.002, vh: -1, receiverBounces: 0 });
    h.step(16);
    let snapshot = h.game.snapshot();
    assert.equal(snapshot.phase, 'playing'); assert.deepEqual(snapshot.score, [0, 0]);
    assert.equal(snapshot.ball.receiverBounces, 1); assert.ok(snapshot.ball.vh > 0);
    Object.assign(h.state.ball, { y: 580, height: BALL_RADIUS + 0.002, vh: -1 });
    h.step(16); snapshot = h.game.snapshot();
    assert.deepEqual(snapshot.score, [0, 1], 'the receiver must return before the second bounce');
    assert.equal(snapshot.phase, 'ready');
  } finally { h.close(); }
});

test('racket contact before a first or second table bounce uses chronological collision order', () => {
  for (const priorBounces of [0, 1]) {
    const h = harness();
    try {
      h.game.serve();
      Object.assign(h.state.input, { height: 0.10, tilt: 18 });
      Object.assign(h.state.players[0], { height: 0.10, tilt: 18 });
      // The low open face touches at the start of this 4 ms frame; the
      // descending ball would reach the tabletop about 1 ms afterwards.
      setIncoming(h, { y: 663, height: BALL_RADIUS + 0.001, vh: -1, receiverBounces: priorBounces });
      h.step(4);
      const result = h.game.snapshot();
      if (priorBounces === 0) {
        assert.deepEqual(result.score, [0, 1], 'a later table bounce must not retroactively legalize an earlier volley');
        assert.equal(result.rally, 0);
      } else {
        assert.deepEqual(result.score, [0, 0], 'a racket return preceding the second bounce must not be judged too late');
        assert.equal(result.rally, 1); assert.equal(result.ball.lastHitter, 0); assert.ok(result.ball.vh > 0);
      }
    } finally { h.close(); }
  }
});

test('a spinning ball returning to the hitter after a legal opponent bounce still wins the hitter the point', () => {
  const h = harness();
  try {
    h.game.serve();
    setIncoming(h, { y: 550, height: BALL_RADIUS + 0.002, vh: -1, lastHitter: 0, receiverBounces: 1 });
    h.step(16);
    assert.deepEqual(h.game.snapshot().score, [1, 0], 'the opponent failed to return after the legal first bounce');
  } finally { h.close(); }
});

test('an ordinary serve physically bounces on both halves before the receiver may hit', () => {
  for (const server of [0, 1]) {
    const h = harness();
    try {
      if (server === 1) for (let i = 0; i < 2; i++) {
        h.game.serve(); setIncoming(h, { x: 120, y: 500, height: -0.72, vh: -2, lastHitter: 0, receiverBounces: 0 }); h.step(24);
      }
      const startingScore = h.game.snapshot().score;
      assert.equal(h.game.snapshot().serveSide, server);
      h.game.serve(); let sawOwnBounce = false, received = null;
      const trace = [];
      for (let i = 0; i < 90; i++) {
        h.step(16); const snapshot = h.game.snapshot();
        if (snapshot.ball.serveStage === 2) sawOwnBounce = true;
        if (snapshot.ball.serveStage === 0 && snapshot.ball.receiverBounces === 1) { received = snapshot; break; }
        trace.push({ ms: (i + 1) * 16, y: snapshot.ball.y, h: snapshot.ball.height, vh: snapshot.ball.vh, stage: snapshot.ball.serveStage, net: snapshot.ball.netTouched });
        assert.deepEqual(snapshot.score, startingScore, `player ${server}'s default serve must clear the net and reach the opponent: ${JSON.stringify(trace.slice(-6))}`);
      }
      assert.ok(sawOwnBounce, 'the serve must touch the server half first');
      assert.ok(received, 'the same serve must then touch the receiver half');
      assert.ok(server === 0 ? received.ball.y < 400 : received.ball.y > 400); assert.equal(received.ball.netTouched, false);
    } finally { h.close(); }
  }
});

test('the practice opponent can return a real legal serve instead of a scripted arc', () => {
  const h = harness('practice');
  const originalRandom = Math.random;
  Math.random = () => 0.5;
  try {
    h.game.setDifficulty('hard'); h.game.start(); h.game.serve();
    for (let i = 0; i < 110 && h.game.snapshot().rally === 0; i++) h.step(16);
    const result = h.game.snapshot();
    assert.ok(result.rally >= 1, 'the practice opponent must be able to return the initial serve');
    assert.equal(result.ball.lastHitter, 1);
    assert.ok(result.ball.vy > 0);
  } finally { Math.random = originalRandom; h.close(); }
});

test('the practice opponent return clears the net and lands on the human half', () => {
  for (const difficulty of ['easy', 'normal', 'hard']) {
    const h = harness('practice'), originalRandom = Math.random;
    Math.random = () => 0.5;
    try {
      h.game.setDifficulty(difficulty); h.game.start(); h.game.serve();
      let crossed = false, landed = false;
      for (let i = 0; i < 220; i++) {
        h.step(16); const snapshot = h.game.snapshot();
        if (snapshot.ball.lastHitter === 1 && snapshot.rally >= 1) {
          crossed ||= snapshot.ball.netCrossed;
          landed ||= snapshot.ball.receiverBounces >= 1;
        }
        if (landed || snapshot.score[0] + snapshot.score[1] > 0) break;
      }
      assert.ok(crossed, `${difficulty} AI must send its return over the net`);
      assert.ok(landed, `${difficulty} AI must land its return on the human half`);
    } finally { Math.random = originalRandom; h.close(); }
  }
});

test('tapping to serve after moving the racket forward still starts a legal two-bounce serve', () => {
  const h = harness();
  try {
    h.pointer('pointerdown', 500, 470); h.settle(420); h.pointer('pointerup', 500, 470);
    h.pointer('pointerdown', 500, 470, 2); h.advance(40); h.pointer('pointerup', 500, 470, 2);
    assert.equal(h.game.snapshot().phase, 'playing', 'a short real touch tap should serve');
    let received = false;
    for (let i = 0; i < 90; i++) {
      h.step(16); const snapshot = h.game.snapshot();
      if (snapshot.ball.serveStage === 0 && snapshot.ball.receiverBounces === 1) { received = true; break; }
      assert.deepEqual(snapshot.score, [0, 0], 'moving the racket forward must not make the automatic serve illegal');
    }
    assert.ok(received, 'the automatic serve must still reach the opponent after both required bounces');
  } finally { h.close(); }
});

test('a serve landing first on the opponent half is a fault and a valid net serve is replayed', () => {
  for (const netLet of [false, true]) {
    const h = harness();
    try {
      h.game.serve();
      setIncoming(h, { y: 250, height: BALL_RADIUS + 0.002, vh: -1, vy: -100, lastHitter: 0, receiverBounces: 0, serveStage: netLet ? 2 : 1, netTouched: netLet });
      h.step(16); const result = h.game.snapshot();
      assert.equal(result.phase, 'ready');
      assert.deepEqual(result.score, netLet ? [0, 0] : [0, 1]);
      if (netLet) assert.match(result.lastShot, /重发/);
    } finally { h.close(); }
  }
});

test('a receiver cannot volley an incoming ball before its first table bounce', () => {
  const h = harness();
  try {
    h.game.serve(); setIncoming(h, { receiverBounces: 0 }); h.step(24);
    const snapshot = h.game.snapshot();
    assert.deepEqual(snapshot.score, [0, 1]);
    assert.equal(snapshot.rally, 0, 'an illegal volley must not count as a successful return');
  } finally { h.close(); }
});

test('a low shot hits the real net while a sufficiently high shot crosses it', () => {
  for (const height of [0.08, 0.4]) {
    const h = harness();
    try {
      h.game.serve();
      setIncoming(h, { y: 414, height, vh: 0, vy: -1000, lastHitter: 0, receiverBounces: 0, netCrossed: false });
      h.step(16);
      let snapshot = h.game.snapshot();
      if (height < 0.2) {
        assert.ok(snapshot.ball.vy > 0, 'a low ball must rebound from the net instead of crossing it');
        assert.equal(snapshot.ball.netTouched, true);
        h.settle(300); snapshot = h.game.snapshot();
        assert.deepEqual(snapshot.score, [0, 1], 'a ball below net clearance must not pass through');
        assert.equal(snapshot.phase, 'ready');
      } else {
        assert.deepEqual(snapshot.score, [0, 0]); assert.equal(snapshot.phase, 'playing');
        assert.ok(snapshot.ball.y < 400); assert.equal(snapshot.ball.netCrossed, true);
      }
    } finally { h.close(); }
  }
});

test('a ball can fly beyond the table edge but cannot bounce from an invisible floor there', () => {
  for (const x of [120, 880]) {
    const h = harness();
    try {
      h.game.serve(); setIncoming(h, { x, y: 500, height: 0.5, vh: 0, vx: 0, vy: 0, lastHitter: 0, receiverBounces: 0 });
      h.step(16);
      assert.deepEqual(h.game.snapshot().score, [0, 0], 'a ball merely flying over an edge is not immediately dead');
      Object.assign(h.state.ball, { height: -0.72, vh: -2 }); h.step(24);
      const snapshot = h.game.snapshot();
      assert.deepEqual(snapshot.score, [0, 1], 'an outgoing ball missing the opponent table loses the last hitter the point');
      assert.equal(snapshot.ball.spinX, 0); assert.equal(snapshot.ball.spinY, 0); assert.equal(snapshot.ball.spinZ, 0);
    } finally { h.close(); }
  }
});

test('guest snapshots preserve full physical spin, height, bounce rules and racket controls', () => {
  let snapshot;
  const host = forwardReturn({ stroke: 'backspin', tilt: 17 });
  try {
    snapshot = JSON.parse(JSON.stringify(host.game.snapshot()));
    Object.assign(snapshot.ball, { height: 0.34, vh: 0.8, spinX: 123, spinY: -45, spinZ: 12, receiverBounces: 1, netCrossed: true, serveStage: 0 });
  } finally { host.close(); }
  const guest = harness('guest');
  try {
    guest.game.applySnapshot(snapshot); guest.step(1);
    assert.equal(guest.state.mode, 'guest');
    for (const key of ['height', 'vh', 'spinX', 'spinY', 'spinZ']) assert.ok(Math.abs(guest.state.ball[key] - snapshot.ball[key]) < 0.03, `guest lost physical field ${key}`);
    for (const key of ['lastHitter', 'receiverBounces', 'netCrossed', 'serveStage', 'flightId']) assert.equal(guest.state.ball[key], snapshot.ball[key], `guest lost rule field ${key}`);
    assert.equal(guest.state.players[0].stroke, 'backspin'); assert.equal(guest.state.players[0].tilt, 17);
    assert.equal(guest.state.ballHeight, getBallHeight(guest.state.ball, 'playing'));
  } finally { guest.close(); }
});

test('remote gestures preserve acceleration and face controls while rotating the court', () => {
  const h = harness();
  try {
    h.game.setRemoteInput({ x: 420, y: 680, vx: 200, vy: -600, ax: 3000, ay: -4000, stroke: 'backspin', tilt: 12, height: 0.27 });
    h.step(16);
    const remote = h.game.snapshot().players[1];
    assert.equal(remote.x, 580); assert.equal(remote.y, 120);
    assert.equal(remote.vx, -200); assert.equal(remote.vy, 600);
    assert.equal(remote.ax, -3000); assert.equal(remote.ay, 4000);
    assert.equal(remote.stroke, 'backspin'); assert.equal(remote.tilt, 12); assert.equal(remote.height, 0.27);
  } finally { h.close(); }
});

test('a guest starts each new flight at contact instead of blending through the old trajectory', () => {
  let incoming;
  const host = harness();
  try { host.game.serve(); setIncoming(host, { y: 600 }); incoming = host.game.snapshot(); }
  finally { host.close(); }
  const guest = harness('guest');
  try {
    guest.game.applySnapshot(incoming); guest.step(1);
    const returned = structuredClone(incoming); returned.rally = 1;
    Object.assign(returned.ball, { y: 658, vy: -800, height: 0.26, vh: 1, lastHitter: 0, receiverBounces: 0, netCrossed: false, flightId: incoming.ball.flightId + 1 });
    returned.event = { id: 1, kind: 'paddle', side: 0, x: 500, y: 658 };
    guest.game.applySnapshot(returned); guest.step(1);
    assert.ok(guest.state.ball.y > 650, 'the guest must not combine an old incoming position with the new return');
    assert.ok(Math.abs(guest.state.ballHeight - returned.ball.height) < 0.025);
  } finally { guest.close(); }
});

test('opposite bare touch gestures create top and backspin without selecting a stroke or angle', () => {
  const spins = [];
  for (const direction of [-1, 1]) {
    const h = harness();
    try {
      h.pointer('pointerdown', 500, 630); h.settle(420);
      h.game.serve();
      for (let i = 1; i <= 5; i++) {
        h.advance(17); h.pointer('pointermove', 500, 630 + direction * 85 * (i / 5) ** 2); h.step(1);
      }
      setIncoming(h, { y: h.state.players[0].y - 12, vy: 1200, vh: -0.4 });
      h.step(16);
      const shot = h.game.snapshot().ball;
      assert.equal(shot.lastHitter, 0, 'both up and down gestures must return the arriving ball');
      assert.ok(shot.vy < 0, 'a downward chop must return toward the opponent');
      assert.ok(shot.spinX * direction > 10, `wrong gesture spin: ${direction}, ${shot.spinX}`);
      spins.push(shot.spinX);
      const trial = { ...shot }; let firstContact;
      for (let i = 0; i < 360 && !firstContact; i++) firstContact = stepBallFlight(trial, 1 / 240)[0];
      assert.equal(firstContact?.type, 'table', 'automatic face assistance must make ordinary gestures playable');
      assert.equal(firstContact?.side, 1, 'an ordinary return should land on the opponent half');
    } finally { h.close(); }
  }
  assert.ok(spins[0] * spins[1] < 0);
});

test('touch height assistance catches an aligned high ball without moving the ball onto a fake arc', () => {
  const h = harness();
  try {
    h.game.serve();
    setIncoming(h, { y: 650, height: 0.6, vh: -0.2, vy: 1200 });
    h.step(30);
    const shot = h.game.snapshot().ball;
    assert.equal(shot.lastHitter, 0);
    assert.ok(h.state.players[0].height > 0.45, 'the visible racket must rise with the assisted reach');
    assert.ok(shot.height > 0.5, 'the physical ball must retain its real impact height');
  } finally { h.close(); }
});


test('a brush beyond the reach boundary keeps its real hand velocity', () => {
  const h=harness();
  try {
    h.pointer('pointerdown',820,670);h.advance(20);h.pointer('pointermove',870,670);
    h.advance(20);h.pointer('pointermove',920,670);
    assert.equal(h.game.getInput().x,830);
    assert.ok(h.game.getInput().vx>1500,'clamping reach must not erase an edge brush');
  } finally {h.close()}
});
test('interrupted system touch cannot leave a ghost power stroke', () => {
  const h=harness();
  try {
    h.pointer('pointerdown',500,670);h.advance(20);h.pointer('pointermove',600,670);
    assert.ok(h.game.getInput().vx>0);
    h.pointer('pointercancel',600,670);
    const input=h.game.getInput();
    assert.equal(input.vx,0);assert.equal(input.vy,0);assert.equal(input.ax,0);assert.equal(input.ay,0);
  } finally {h.close()}
});

function brushServe(h, dy, duration = 120, pointerType = 'touch') {
  h.pointer('pointerdown', 500, 650 - dy / 2, 1, pointerType);
  h.advance(duration);
  h.pointer('pointermove', 500, 650 + dy / 2, 1, pointerType);
  assert.ok(['ready', 'idle'].includes(h.game.snapshot().phase), 'a brush must not launch before release');
  h.pointer('pointerup', 500, 650 + dy / 2, 1, pointerType);
}

test('upward and downward serve brushes create opposite physical spin and legal two-bounce flights', () => {
  for (const pointerType of ['touch', 'mouse']) for (const dy of [-160, 160]) {
    const h = harness();
    try {
      brushServe(h, dy, 80, pointerType);
      const initial = h.game.snapshot().ball;
      assert.equal(h.game.snapshot().phase, 'playing');
      assert.ok(initial.spinX * Math.sign(initial.vy) * -Math.sign(dy) > 250);
      assert.match(h.game.snapshot().lastShot, dy < 0 ? /上旋发球/ : /下旋发球/);
      const replay = { ...initial }, bounces = [];
      let net = false;
      for (let i = 0; i < 300 && bounces.length < 2; i++) for (const event of stepBallFlight(replay, 1 / 240)) {
        if (event.type === 'table') bounces.push(event.side);
        if (event.type === 'net') net = true;
      }
      assert.deepEqual(bounces, [0, 1], 'spin serve must land on own half and then the opponent half');
      assert.equal(net, false);
      const spinning = { ...initial }, flat = { ...initial, spinX: 0 };
      stepBallFlight(spinning, 0.07);stepBallFlight(flat, 0.07);
      assert.ok(Math.abs(spinning.height - flat.height) > 0.001, 'serve spin must change flight, not just the HUD');
    } finally { h.close(); }
  }
});

test('faster serve brushing creates stronger spin and a faster ball', () => {
  const results=[];
  for (const duration of [400, 80]) {
    const h=harness();
    try {brushServe(h, -160, duration);results.push(h.game.snapshot().ball)} finally {h.close()}
  }
  assert.ok(Math.abs(results[1].spinX) > Math.abs(results[0].spinX) * 1.5);
  assert.ok(ballSpeed(results[1]) > ballSpeed(results[0]));
});

test('the last brush direction wins and a cancelled or stationary drag cannot accidentally serve', () => {
  const h=harness();
  try {
    h.pointer('pointerdown',500,650);
    h.advance(60);h.pointer('pointermove',500,570);
    h.advance(140);h.pointer('pointermove',500,650);
    h.pointer('pointerup',500,650);
    assert.equal(h.game.snapshot().phase,'playing');
    assert.ok(h.game.snapshot().ball.spinX>0,'the final downward brush must serve backspin');
    h.game.restart();
    h.pointer('pointerdown',500,650);h.advance(60);h.pointer('pointermove',500,570);
    h.pointer('pointercancel',500,570);
    assert.equal(h.game.snapshot().phase,'ready');
    h.pointer('pointerdown',500,650);h.advance(60);h.pointer('pointermove',500,570);
    h.advance(500);h.pointer('pointerup',500,570);
    assert.equal(h.game.snapshot().phase,'ready','holding after a stroke must not reuse stale velocity');
  } finally {h.close()}
});

test('a human server keeps the ball ready until choosing a serve gesture', () => {
  const h=harness();
  try {
    h.game.serve();setIncoming(h,{x:120,y:500,height:-0.72,vh:-2,lastHitter:0,receiverBounces:0});h.step(24);
    assert.equal(h.game.snapshot().serveSide,0);
    h.settle(2000);
    assert.equal(h.game.snapshot().phase,'ready','the timer must leave time to brush a human serve');
    brushServe(h,-80);assert.equal(h.game.snapshot().phase,'playing');
  } finally {h.close()}
});

test('guest serve carries its own brush through the action callback and rotates spin for the far server', () => {
  let state,command;
  const h=harness();
  try {
    for(let i=0;i<2;i++){h.game.serve();setIncoming(h,{x:120,y:500,height:-0.72,vh:-2,lastHitter:0,receiverBounces:0});h.step(24)}
    state=h.game.snapshot();
    h.game.serve({brushY:-2},0);
    assert.equal(h.game.snapshot().phase,'ready','the host cannot serve on the guest turn');
  } finally {h.close()}
  const guest=harness('guest',{onAction:(action,gesture)=>{command={action,gesture};return true}});
  try {
    guest.game.applySnapshot(state);guest.step(1);
    brushServe(guest,-160,80);
    assert.equal(command.action,'serve');assert.ok(command.gesture.brushY<0);
    assert.equal(guest.game.snapshot().phase,'ready','the guest must wait for the authoritative serve');
  } finally {guest.close()}
  const host=harness();
  try {
    for(let i=0;i<2;i++){host.game.serve();setIncoming(host,{x:120,y:500,height:-0.72,vh:-2,lastHitter:0,receiverBounces:0});host.step(24)}
    host.game.serve(command.gesture,1);
    const ball=host.game.snapshot().ball;
    assert.equal(host.game.snapshot().phase,'playing');assert.ok(ball.vy>0&&ball.spinX>250,'upward guest brush remains topspin after court rotation');
  } finally {host.close()}
});
