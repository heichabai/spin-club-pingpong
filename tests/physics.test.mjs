import test from 'node:test';
import assert from 'node:assert/strict';
import { BALL_RADIUS, GRAVITY, NET_HEIGHT, RACKET_HEIGHT, X_SCALE, Z_SCALE, bounceOnTable, computeShot, getBallHeight, racketNormal, stepBallFlight, sweptRacketContact } from '../lib/physics.js';

const close = (actual, expected, tolerance = 1e-7) => assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} differs from ${expected}`);
const ball = (overrides = {}) => ({ x: 500, y: 680, height: 0.7, vx: 0, vy: -7 / Z_SCALE, vh: 0, spinX: 0, spinY: 0, spinZ: 0, spin: 0, hop: 0, ...overrides });
const paddle = (overrides = {}) => ({ x: 500, y: 670, height: RACKET_HEIGHT, vx: 0, vy: 0, ax: 0, ay: 0, tilt: 0, stroke: 'drive', ...overrides });
const speed = (b) => Math.hypot(b.vx * X_SCALE, b.vy * Z_SCALE, b.vh);
const mirrorBall = (b) => ({ ...b, x: 1000 - b.x, y: 800 - b.y, vx: -b.vx, vy: -b.vy, spinX: -b.spinX, spinY: b.spinY, spinZ: -b.spinZ });
const mirrorPaddle = (p) => ({ ...p, x: 1000 - p.x, y: 800 - p.y, vx: -p.vx, vy: -p.vy, ax: -p.ax, ay: -p.ay });
const standardIncoming = () => ball({ height: RACKET_HEIGHT, vy: 7 / Z_SCALE, vh: -0.5 });

function firstWorldContact(shot) {
  const b = ball({ y: 665, height: RACKET_HEIGHT, ...shot });
  for (let frame = 0; frame < 400; frame++) {
    const events = stepBallFlight(b, 1 / 240);
    if (events.length) return events[0];
  }
  return null;
}

test('racket tilt is a unit world normal: positive opens the face upwards at either end', () => {
  const near = racketNormal(paddle({ tilt: 15 }), 0);
  const far = racketNormal(paddle({ tilt: 15 }), 1);
  close(Math.hypot(near.x, near.y, near.z), 1);
  assert.ok(near.y > 0 && near.z < 0 && far.y > 0 && far.z > 0);
  close(near.y, far.y); close(near.z, -far.z);
  assert.ok(racketNormal(paddle({ tilt: -10 }), 0).y < 0);
});

test('flight integrates real gravity and air resistance instead of a predefined arc', () => {
  const falling = ball({ height: 1, vy: 0 });
  stepBallFlight(falling, 0.03);
  assert.ok(falling.vh < -0.29 && falling.vh > -GRAVITY * 0.031);
  assert.ok(falling.height < 1 && falling.height > 0.99);
  const flying = ball({ height: 1 });
  stepBallFlight(flying, 0.1);
  assert.ok(Math.abs(flying.vy * Z_SCALE) < 6.5);
  assert.ok(speed(flying) < 7);
});

test('topspin dips and backspin floats through the Magnus force with identical launch velocity', () => {
  const neutral = ball();
  const top = ball({ spinX: -300 });
  const back = ball({ spinX: 300 });
  stepBallFlight(neutral, 0.12);
  stepBallFlight(top, 0.12);
  stepBallFlight(back, 0.12);
  assert.ok(top.height < neutral.height - 0.015);
  assert.ok(back.height > neutral.height + 0.015);
  assert.ok(top.vh < neutral.vh && back.vh > neutral.vh);
});

test('side spin changes the actual flight path in opposite directions without an initial diagonal velocity', () => {
  const right = ball({ height: 1, spinY: -350 });
  const left = ball({ height: 1, spinY: 350 });
  stepBallFlight(right, 0.2);
  stepBallFlight(left, 0.2);
  assert.ok(right.x > 515 && left.x < 485);
  assert.ok(right.vx > 0 && left.vx < 0);
  close(right.x - 500, 500 - left.x, 1e-5);
});

test('descending contact produces exactly one table event and a physical upward bounce', () => {
  const b = ball({ y: 600, height: 0.06, vy: 0, vh: -2 });
  const events = stepBallFlight(b, 0.04);
  assert.equal(events.filter((event) => event.type === 'table').length, 1);
  const hit = events[0];
  assert.equal(hit.side, 0); close(hit.height, BALL_RADIUS);
  assert.ok(hit.time > 0 && hit.time < 0.04);
  assert.ok(b.vh > 0 && b.height > BALL_RADIUS);
  assert.equal(stepBallFlight(b, 0.01).filter((event) => event.type === 'table').length, 0);
});

test('a ball already on the table and descending resolves contact instead of falling through', () => {
  const b = ball({ y: 200, height: BALL_RADIUS, vy: 0, vh: -1 });
  const events = stepBallFlight(b, 0.01);
  assert.equal(events[0]?.type, 'table');
  assert.equal(events[0]?.side, 1);
  assert.ok(b.vh > 0);
});

test('the table only supports its actual footprint, while an airborne side ball remains in flight', () => {
  const b = ball({ x: 100, y: 600, height: 0.04, vy: 0, vh: -1 });
  const events = stepBallFlight(b, 0.04);
  assert.equal(events.length, 0);
  assert.ok(b.height < BALL_RADIUS);
  const outside = ball({ x: 900, height: 1 });
  assert.equal(stepBallFlight(outside, 0.01).length, 0);
});

test('low shots collide with the physical net and lose energy, high shots cross freely', () => {
  const low = ball({ y: 420, height: 0.1 });
  const high = ball({ y: 420, height: 0.35 });
  const events = stepBallFlight(low, 0.025);
  assert.equal(events.filter((event) => event.type === 'net').length, 1);
  assert.ok(events[0].height <= NET_HEIGHT + BALL_RADIUS);
  assert.ok(low.vy > 0 && speed(low) < 2);
  assert.equal(stepBallFlight(high, 0.025).filter((event) => event.type === 'net').length, 0);
  assert.ok(high.y < 400);
});

test('a descending ball can hit the top tape after crossing the front net plane', () => {
  const b = ball({ y: 400, height: 0.2, vy: 0, vh: -2 });
  const events = stepBallFlight(b, 0.025);
  assert.equal(events[0]?.type, 'net');
  assert.ok(b.height >= NET_HEIGHT + BALL_RADIUS);
  assert.ok(b.vh > 0);
});

test('off-table descent reaches the actual floor below the table', () => {
  const b = ball({ y: 900, height: -0.7, vy: 0, vh: -2 });
  const events = stepBallFlight(b, 0.04);
  assert.equal(events[0]?.type, 'floor');
  close(events[0].height, -0.76 + BALL_RADIUS);
  assert.ok(b.vh > 0);
});

test('table friction converts rolling spin into translation without a fictitious side-spin kick', () => {
  const top = ball({ vy: -1 / Z_SCALE, vh: -2, spinX: -150 });
  const back = ball({ vy: -1 / Z_SCALE, vh: -2, spinX: 150 });
  const neutral = ball({ vy: -1 / Z_SCALE, vh: -2 });
  bounceOnTable(top); bounceOnTable(back); bounceOnTable(neutral);
  assert.ok(Math.abs(top.vy) > Math.abs(neutral.vy));
  assert.ok(Math.abs(back.vy) < Math.abs(neutral.vy));
  const side = ball({ vh: -2, spinY: 500 });
  bounceOnTable(side);
  close(side.vx, 0);
  close(side.spinY, 500);
});

test('a stationary flat block reflects the arriving ball without manufacturing new topspin', () => {
  const incoming = standardIncoming(); incoming.vh = 0;
  const shot = computeShot(paddle(), 500, 0, 0, incoming);
  close(shot.vy * Z_SCALE, -7 * 0.82);
  close(shot.vh, 0); close(shot.spinX, 0); close(shot.spinY, 0); close(shot.spinZ, 0);
  assert.ok(speed(shot) > 5);
});

test('faster forward motion and bounded acceleration increase the physical impact speed', () => {
  const incoming = standardIncoming();
  const slow = computeShot(paddle({ vy: -0.5 / Z_SCALE, tilt: 3 }), 500, 0, 0, incoming);
  const fast = computeShot(paddle({ vy: -3 / Z_SCALE, tilt: 3 }), 500, 0, 0, incoming);
  const constant = computeShot(paddle({ vy: -1 / Z_SCALE, tilt: 3 }), 500, 0, 0, incoming);
  const accelerating = computeShot(paddle({ vy: -1 / Z_SCALE, ay: -50 / Z_SCALE, tilt: 3 }), 500, 0, 0, incoming);
  assert.ok(speed(fast) > speed(slow) + 3);
  assert.ok(speed(accelerating) > speed(constant) + 1);
  const capped = computeShot(paddle({ vy: -6 / Z_SCALE, ay: -1e9, tilt: 3 }), 500, 0, 0, incoming);
  assert.ok(speed(capped) <= 14.00001);
});

test('top and back strokes generate the correct angular direction and calibrated playable shots', () => {
  const incoming = standardIncoming();
  const drive = computeShot(paddle({ vy: -2 / Z_SCALE, tilt: 3 }), 500, 0, 0, incoming);
  const top = computeShot(paddle({ vy: -2 / Z_SCALE, tilt: 0, stroke: 'topspin' }), 500, 0, 0, incoming);
  const back = computeShot(paddle({ vy: -2 / Z_SCALE, tilt: 7, stroke: 'backspin' }), 500, 0, 0, incoming);
  assert.ok(top.spinX < -70 && back.spinX > 50);
  assert.ok(Math.abs(drive.spinX) < 10);
  for (const shot of [drive, top, back]) {
    assert.ok(speed(shot) >= 8 && speed(shot) <= 11);
    const event = firstWorldContact(shot);
    assert.equal(event?.type, 'table');
    assert.equal(event?.side, 1);
    assert.ok(event.y >= 82 && event.y < 400);
  }
});

test('incoming spin changes the return through rubber friction and must be compensated by the face', () => {
  const neutral = standardIncoming(); neutral.vh = 0;
  const incomingBack = { ...neutral, spinX: -300 };
  const incomingTop = { ...neutral, spinX: 300 };
  const blockedBack = computeShot(paddle(), 500, 0, 0, incomingBack);
  const blockedTop = computeShot(paddle(), 500, 0, 0, incomingTop);
  assert.ok(blockedBack.vh < -1);
  assert.ok(blockedTop.vh > 1);
  assert.ok(computeShot(paddle({ tilt: 12 }), 500, 0, 0, incomingBack).vh > blockedBack.vh);
});

test('a forward stroke catches a ball even when the final racket plane has swept past it', () => {
  const start = ball({ x: 500, y: 601.5, height: RACKET_HEIGHT, vy: 7 / Z_SCALE });
  const end = { ...start, y: 605.37 };
  const previous = paddle({ y: 615, vy: -1500 });
  const current = paddle({ y: 590, vy: -1500 });
  assert.equal(start.y <= current.y - 12 && end.y >= current.y - 12, false);
  const hit = sweptRacketContact(start, end, previous, current, 0);
  assert.ok(hit && hit.time > 0 && hit.time < 1);
  close(hit.paddle.y, previous.y + (current.y - previous.y) * hit.time);
});

test('a fast sideways sweep catches a contact between its two rendered positions', () => {
  const start = ball({ y: 665, height: RACKET_HEIGHT, vy: 7 / Z_SCALE });
  const end = { ...start, y: 669 };
  const hit = sweptRacketContact(start, end, paddle({ x: 650, vx: -1900 }), paddle({ x: 350, vx: -1900 }), 0);
  assert.ok(hit && hit.time > 0 && hit.time < 1);
});

test('the real disk permits visible edge grazes but cannot return a ball above its reach', () => {
  const start = ball({ x: 547, y: 655, height: RACKET_HEIGHT, vy: 7 / Z_SCALE });
  const end = { ...start, y: 670 };
  assert.ok(sweptRacketContact(start, end, paddle(), paddle(), 0));
  assert.equal(sweptRacketContact({ ...start, height: 0.4 }, { ...end, height: 0.4 }, paddle(), paddle(), 0), null);
  assert.equal(sweptRacketContact({ ...start, x: 575 }, { ...end, x: 575 }, paddle(), paddle(), 0), null);
});

test('a visibly tilted disk has the same contact plane as its face normal', () => {
  const start = ball({ y: 658, height: RACKET_HEIGHT + 0.08, vy: 7 / Z_SCALE });
  const end = { ...start, y: 672 };
  assert.ok(sweptRacketContact(start, end, paddle(), paddle(), 0));
  const open = paddle({ tilt: 40 });
  assert.equal(sweptRacketContact(start, end, open, open, 0), null);
  assert.ok(sweptRacketContact(start, { ...end, y: 685 }, open, open, 0));
});

test('both players and the rotated guest view obey the same contact and vector-spin transformation', () => {
  const start = ball({ x: 515, y: 601.5, height: RACKET_HEIGHT, vy: 7 / Z_SCALE, spinX: 100, spinY: 40, spinZ: -20 });
  const end = { ...start, x: 516, y: 605.37 };
  const previous = paddle({ y: 615, vy: -1000, vx: 500, tilt: 3, stroke: 'topspin' });
  const current = { ...previous, x: 505, y: 590 };
  const near = sweptRacketContact(start, end, previous, current, 0);
  const far = sweptRacketContact(mirrorBall(start), mirrorBall(end), mirrorPaddle(previous), mirrorPaddle(current), 1);
  assert.ok(near && far);
  close(near.time, far.time); close(near.height, far.height);
  close(near.x, 1000 - far.x); close(near.y, 800 - far.y);
  const nearShot = computeShot(near.paddle, near.x, 0, 0, start);
  const farShot = computeShot(far.paddle, far.x, 1, 0, mirrorBall(start));
  close(nearShot.vx, -farShot.vx); close(nearShot.vy, -farShot.vy); close(nearShot.vh, farShot.vh);
  close(nearShot.spinX, -farShot.spinX); close(nearShot.spinY, farShot.spinY); close(nearShot.spinZ, -farShot.spinZ);
});

test('a ball departing the face cannot be hit repeatedly, and height is never replaced by a cosmetic arc', () => {
  const start = ball({ y: 665, height: RACKET_HEIGHT, vy: -7 / Z_SCALE });
  const end = { ...start, y: 660 };
  assert.equal(sweptRacketContact(start, end, paddle(), paddle(), 0), null);
  assert.equal(sweptRacketContact(start, start, paddle(), paddle(), 0), null);
  for (const phase of ['playing', 'paused', 'ready']) close(getBallHeight({ height: 0.37 }, phase, 100), 0.37);
});
