// The simulation stores court x/y in screen-independent court units. All
// forces, surface contacts, heights and angular velocities use SI units.
export const X_SCALE = 1.525 / 700;
export const Z_SCALE = 2.74 / 636;
export const RACKET_HEIGHT = 0.23;
export const RACKET_RADIUS = 0.105;
export const BALL_RADIUS = 0.02;
export const RACKET_FACE_DEPTH = 0.006;
export const CONTACT_OFFSET = BALL_RADIUS / Z_SCALE;
export const NET_HEIGHT = 0.1525;
export const GRAVITY = 9.81;
export const MAX_PHYSICS_STEP = 1 / 240;

const MASS = 0.0027;
const SHELL_INERTIA = 2 / 3;
const AIR_DENSITY = 1.225;
const AREA = Math.PI * BALL_RADIUS * BALL_RADIUS;
const AIR_FACTOR = 0.5 * AIR_DENSITY * AREA / MASS;
const DRAG_COEFFICIENT = 0.5;
const SPIN_DECAY = 0.08;
const CONTACT_TOLERANCE = 0.014;
const FLOOR_HEIGHT = -0.76;
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const lerp = (a, b, t) => a + (b - a) * t;
const finite = (value, fallback = 0) => Number.isFinite(value) ? value : fallback;
const vector = (x = 0, y = 0, z = 0) => ({ x, y, z });
const dot = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;
const length = (v) => Math.hypot(v.x, v.y, v.z);
const cross = (a, b) => vector(a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x);
const multiply = (v, factor) => vector(v.x * factor, v.y * factor, v.z * factor);
const subtract = (a, b) => vector(a.x - b.x, a.y - b.y, a.z - b.z);
const velocity = (ball) => vector(ball.vx * X_SCALE, finite(ball.vh), ball.vy * Z_SCALE);
const angularVelocity = (ball) => vector(finite(ball.spinX), finite(ball.spinY), finite(ball.spinZ));

export function getBallHeight(ball) {
  return finite(ball.height, finite(ball.launchHeight, RACKET_HEIGHT));
}

export function racketNormal(paddle, side) {
  const tilt = clamp(finite(paddle.tilt), -65, 65) * Math.PI / 180;
  return vector(0, Math.sin(tilt), (side === 0 ? -1 : 1) * Math.cos(tilt));
}

function setVelocity(ball, v) {
  ball.vx = v.x / X_SCALE;
  ball.vh = v.y;
  ball.vy = v.z / Z_SCALE;
}

function setSpin(ball, spin) {
  ball.spinX = spin.x;
  ball.spinY = spin.y;
  ball.spinZ = spin.z;
  // The compact HUD keeps its previous signed side-spin range. The renderer
  // and physics always use the complete angular-velocity vector.
  ball.spin = clamp(spin.y * Math.sign(ball.vy || -1) / 400, -1, 1);
}

function acceleration(v, omega) {
  const speed = length(v);
  if (speed < 1e-8) return vector(0, -GRAVITY, 0);
  const rotationCrossVelocity = cross(omega, v);
  const crossMagnitude = length(rotationCrossVelocity);
  const perpendicularSpin = crossMagnitude / speed;
  const spinRatio = BALL_RADIUS * perpendicularSpin / speed;
  // A bounded spin-ratio lift curve avoids unbounded forces at very high RPM.
  // This is a mobile-game approximation to measured table-tennis aerodynamics.
  const liftCoefficient = Math.min(0.68, 0.9 * spinRatio / (1 + spinRatio));
  const magnus = crossMagnitude > 1e-9 ? AIR_FACTOR * liftCoefficient * speed * speed / crossMagnitude : 0;
  const drag = AIR_FACTOR * DRAG_COEFFICIENT * speed;
  return vector(
    -drag * v.x + magnus * rotationCrossVelocity.x,
    -GRAVITY - drag * v.y + magnus * rotationCrossVelocity.y,
    -drag * v.z + magnus * rotationCrossVelocity.z,
  );
}

function integrateAir(ball, dt) {
  const v = velocity(ball);
  const spin = angularVelocity(ball);
  const a0 = acceleration(v, spin);
  const midV = vector(v.x + a0.x * dt / 2, v.y + a0.y * dt / 2, v.z + a0.z * dt / 2);
  const a = acceleration(midV, multiply(spin, Math.exp(-SPIN_DECAY * dt / 2)));
  ball.x += (v.x * dt + a.x * dt * dt / 2) / X_SCALE;
  ball.y += (v.z * dt + a.z * dt * dt / 2) / Z_SCALE;
  ball.height = getBallHeight(ball) + v.y * dt + a.y * dt * dt / 2;
  setVelocity(ball, vector(v.x + a.x * dt, v.y + a.y * dt, v.z + a.z * dt));
  setSpin(ball, multiply(spin, Math.exp(-SPIN_DECAY * dt)));
}

// Instantaneous point contact for a thin hollow sphere. Friction is limited by
// the normal impulse and acts on the slipping contact point, not on its centre.
function surfaceImpact(v, spin, normal, surfaceVelocity, restitution, friction) {
  const radiusVector = multiply(normal, -BALL_RADIUS);
  const rotationVelocity = cross(spin, radiusVector);
  const relative = vector(v.x + rotationVelocity.x - surfaceVelocity.x, v.y + rotationVelocity.y - surfaceVelocity.y, v.z + rotationVelocity.z - surfaceVelocity.z);
  const normalSpeed = dot(relative, normal);
  if (normalSpeed >= 0) return { v, spin };
  const normalImpulse = -(1 + restitution) * normalSpeed;
  const tangent = subtract(relative, multiply(normal, normalSpeed));
  const tangentSpeed = length(tangent);
  const tangentImpulse = Math.min(tangentSpeed / (1 + 1 / SHELL_INERTIA), friction * normalImpulse);
  const tangentDelta = tangentSpeed > 1e-10 ? multiply(tangent, -tangentImpulse / tangentSpeed) : vector();
  const spinDelta = multiply(cross(radiusVector, tangentDelta), 1 / (SHELL_INERTIA * BALL_RADIUS * BALL_RADIUS));
  return {
    v: vector(v.x + normalImpulse * normal.x + tangentDelta.x, v.y + normalImpulse * normal.y + tangentDelta.y, v.z + normalImpulse * normal.z + tangentDelta.z),
    spin: vector(spin.x + spinDelta.x, spin.y + spinDelta.y, spin.z + spinDelta.z),
  };
}

export function bounceOnTable(ball) {
  const v = velocity(ball);
  if (v.y >= 0) return false;
  const restitution = clamp(0.94 - 0.012 * Math.abs(v.y), 0.82, 0.94);
  const result = surfaceImpact(v, angularVelocity(ball), vector(0, 1, 0), vector(), restitution, 0.28);
  setVelocity(ball, result.v);
  setSpin(ball, result.spin);
  ball.height = BALL_RADIUS + 1e-6;
  ball.bounceApplied = true;
  return true;
}

function contactEvent(type, ball, time) {
  return { type, side: ball.y >= 400 ? 0 : 1, x: ball.x, y: ball.y, height: getBallHeight(ball), time };
}

function findWorldContact(start, end) {
  let contact = null;
  function accept(type, fraction) {
    if (fraction >= 0 && fraction <= 1 && (!contact || fraction < contact.fraction)) contact = { type, fraction };
  }
  const startHeight = getBallHeight(start);
  const endHeight = getBallHeight(end);
  if (startHeight >= BALL_RADIUS - 1e-8 && endHeight <= BALL_RADIUS && end.vh < 0) {
    const fraction = clamp((startHeight - BALL_RADIUS) / (startHeight - endHeight || 1), 0, 1);
    const x = lerp(start.x, end.x, fraction);
    const y = lerp(start.y, end.y, fraction);
    if (x >= 150 && x <= 850 && y >= 82 && y <= 718) accept('table', fraction);
  }
  const floorContactHeight = FLOOR_HEIGHT + BALL_RADIUS;
  if (startHeight >= floorContactHeight - 1e-8 && endHeight <= floorContactHeight && end.vh < 0) {
    accept('floor', (startHeight - floorContactHeight) / (startHeight - endHeight));
  }
  // Sweep the sphere against the net volume, including a ball dropping onto
  // its top tape after the centre has already crossed the front face.
  const netStart = vector((start.x - 500) * X_SCALE, startHeight, (start.y - 400) * Z_SCALE);
  const netEnd = vector((end.x - 500) * X_SCALE, endHeight, (end.y - 400) * Z_SCALE);
  const netDelta = subtract(netEnd, netStart);
  const netLow = vector(-0.82 - BALL_RADIUS, -BALL_RADIUS, -0.004 - BALL_RADIUS);
  const netHigh = vector(0.82 + BALL_RADIUS, NET_HEIGHT + BALL_RADIUS, 0.004 + BALL_RADIUS);
  let entry = 0;
  let exit = 1;
  let netNormal = null;
  let overlaps = true;
  for (const axis of ['x', 'y', 'z']) {
    if (Math.abs(netDelta[axis]) < 1e-12) {
      if (netStart[axis] < netLow[axis] || netStart[axis] > netHigh[axis]) { overlaps = false; break; }
    } else {
      const t0 = (netLow[axis] - netStart[axis]) / netDelta[axis];
      const t1 = (netHigh[axis] - netStart[axis]) / netDelta[axis];
      const near = Math.min(t0, t1);
      const far = Math.max(t0, t1);
      if (near > entry) {
        entry = near;
        netNormal = vector(); netNormal[axis] = -Math.sign(netDelta[axis]);
      }
      exit = Math.min(exit, far);
      if (entry > exit) { overlaps = false; break; }
    }
  }
  if (overlaps && entry >= 0 && entry <= 1 && exit >= 0) {
    if (!netNormal) {
      // A restored state may already slightly overlap the cloth. Resolve it
      // towards the face it is approaching rather than tunnelling through.
      netNormal = Math.abs(netDelta.z) > Math.abs(netDelta.y) ? vector(0, 0, -Math.sign(netDelta.z || 1)) : vector(0, -Math.sign(netDelta.y || -1), 0);
    }
    if (!contact || entry < contact.fraction) contact = { type: 'net', fraction: entry, normal: netNormal };
  }
  return contact;
}

// Contact times are seconds from the start of this call. The helper advances
// every remainder after an impact and can be used identically for prediction.
export function stepBallFlight(ball, dt) {
  if (!(dt > 0)) return [];
  ball.height = getBallHeight(ball);
  ball.vh = finite(ball.vh);
  ball.spinX = finite(ball.spinX);
  ball.spinY = finite(ball.spinY);
  ball.spinZ = finite(ball.spinZ);
  const events = [];
  let elapsed = 0;
  while (elapsed < dt - 1e-10) {
    const step = Math.min(MAX_PHYSICS_STEP, dt - elapsed);
    let remaining = step;
    let consumed = 0;
    for (let contacts = 0; remaining > 1e-10 && contacts < 4; contacts++) {
      const predicted = { ...ball };
      integrateAir(predicted, remaining);
      const contact = findWorldContact(ball, predicted);
      if (!contact) { Object.assign(ball, predicted); consumed += remaining; remaining = 0; break; }
      const travel = remaining * contact.fraction;
      integrateAir(ball, travel);
      consumed += travel;
      remaining -= travel;
      if (contact.type === 'table') {
        ball.height = BALL_RADIUS;
        events.push(contactEvent('table', ball, elapsed + consumed));
        bounceOnTable(ball);
      } else if (contact.type === 'net') {
        events.push(contactEvent('net', ball, elapsed + consumed));
        const normal = contact.normal;
        const v = velocity(ball);
        const into = dot(v, normal);
        const normalVelocity = multiply(normal, into);
        const tangentVelocity = subtract(v, normalVelocity);
        setVelocity(ball, vector(tangentVelocity.x * 0.6 - normalVelocity.x * 0.12, tangentVelocity.y * 0.6 - normalVelocity.y * 0.12, tangentVelocity.z * 0.6 - normalVelocity.z * 0.12));
        if (normal.z) ball.y = 400 + normal.z * ((BALL_RADIUS + 0.004) / Z_SCALE + 1e-4);
        if (normal.x) ball.x = 500 + normal.x * ((0.82 + BALL_RADIUS) / X_SCALE + 1e-4);
        if (normal.y) ball.height = normal.y > 0 ? NET_HEIGHT + BALL_RADIUS + 1e-6 : -BALL_RADIUS - 1e-6;
        setSpin(ball, multiply(angularVelocity(ball), 0.55));
      } else {
        ball.height = FLOOR_HEIGHT + BALL_RADIUS;
        events.push(contactEvent('floor', ball, elapsed + consumed));
        const result = surfaceImpact(velocity(ball), angularVelocity(ball), vector(0, 1, 0), vector(), 0.25, 0.35);
        setVelocity(ball, result.v);
        setSpin(ball, result.spin);
        ball.height += 1e-6;
      }
    }
    if (remaining > 1e-10) integrateAir(ball, remaining);
    elapsed += step;
  }
  ball.hop = finite(ball.hop) + dt;
  return events;
}

function effectivePaddleVelocity(paddle, side) {
  const predict = (speed, accelerationValue, scale) => speed * scale + clamp(accelerationValue * scale * 0.02, -1.5, 1.5);
  const x = predict(finite(paddle.vx), finite(paddle.ax), X_SCALE);
  const z = predict(finite(paddle.vy), finite(paddle.ay), Z_SCALE);
  if (paddle.gesture) {
    // A touch screen measures a two-dimensional sweep, not a six-axis racket.
    // Up/down encodes the vertical brush; its magnitude supplies a modest
    // forward drive so a downward chop is not mistaken for retreating in 3D.
    const brush = z * (side === 0 ? -1 : 1);
    return vector(x * 0.9, clamp(brush * 1.45, -6.5, 7.5), (side === 0 ? -1 : 1) * (Math.abs(z) * 0.62 + Math.abs(x) * 0.1));
  }
  const forward = Math.max(0, z * (side === 0 ? -1 : 1));
  const stroke = paddle.stroke || 'drive';
  // Touch only provides two coordinates. The selected stroke supplies the
  // missing vertical brushing motion while its strength follows the swipe.
  const y = stroke === 'topspin' ? Math.min(7, forward * 1.3) : stroke === 'backspin' ? -Math.min(5, forward * 0.9) : finite(paddle.vh);
  return vector(x, y, z);
}

export function computeShot(paddle, ballX, side, rally = 0, incomingBall) {
  const normal = racketNormal(paddle, side);
  const incoming = incomingBall ? velocity(incomingBall) : vector(0, -0.35, side === 0 ? 6.5 : -6.5);
  const spin = incomingBall ? angularVelocity(incomingBall) : vector();
  const result = surfaceImpact(incoming, spin, normal, effectivePaddleVelocity(paddle, side), 0.82, 0.85);
  if (paddle.gesture) {
    // Boost only the spin contributed by the hand, preserving an idle block's
    // response to incoming rotation. Forward speed is calibrated separately.
    const idle = surfaceImpact(incoming, spin, normal, vector(), 0.82, 0.85);
    result.spin = vector(
      result.spin.x + (result.spin.x - idle.spin.x) * 1.1,
      result.spin.y + (result.spin.y - idle.spin.y) * 1.1,
      result.spin.z + (result.spin.z - idle.spin.z) * 1.1,
    );
  }
  const speed = length(result.v);
  if (speed > 12.5) result.v = multiply(result.v, 12.5 / speed);
  const angularSpeed = length(result.spin);
  if (angularSpeed > 1000) result.spin = multiply(result.spin, 1000 / angularSpeed);
  const shot = { vx: result.v.x / X_SCALE, vy: result.v.z / Z_SCALE, vh: result.v.y, spinX: result.spin.x, spinY: result.spin.y, spinZ: result.spin.z, spin: 0 };
  shot.spin = clamp(shot.spinY * Math.sign(shot.vy || -1) / 400, -1, 1);
  return shot;
}

function interpolatePaddle(start, end, t) {
  return {
    ...end,
    x: lerp(start.x, end.x, t), y: lerp(start.y, end.y, t),
    height: lerp(finite(start.height, RACKET_HEIGHT), finite(end.height, RACKET_HEIGHT), t),
    vx: lerp(finite(start.vx), finite(end.vx), t), vy: lerp(finite(start.vy), finite(end.vy), t),
    ax: lerp(finite(start.ax), finite(end.ax), t), ay: lerp(finite(start.ay), finite(end.ay), t),
    tilt: lerp(finite(start.tilt), finite(end.tilt), t),
  };
}

// Distance to an actual finite tilted disk, expanded only by the ball radius
// and a small touch tolerance. Conservative advancement solves
// moving contacts without letting a high ball hit an imaginary tall racket.
export function sweptRacketContact(ballStart, ballEnd, paddleStart, paddleEnd, side) {
  const relativeStart = vector((ballStart.x - paddleStart.x) * X_SCALE, getBallHeight(ballStart) - finite(paddleStart.height, RACKET_HEIGHT), (ballStart.y - paddleStart.y) * Z_SCALE);
  const relativeEnd = vector((ballEnd.x - paddleEnd.x) * X_SCALE, getBallHeight(ballEnd) - finite(paddleEnd.height, RACKET_HEIGHT), (ballEnd.y - paddleEnd.y) * Z_SCALE);
  const relativeDelta = subtract(relativeEnd, relativeStart);
  const bound = Math.hypot(RACKET_RADIUS, RACKET_FACE_DEPTH) + BALL_RADIUS + CONTACT_TOLERANCE;
  const a = dot(relativeDelta, relativeDelta);
  const b = 2 * dot(relativeStart, relativeDelta);
  const c = dot(relativeStart, relativeStart) - bound * bound;
  let entry = 0;
  let exit = 1;
  if (a > 1e-14) {
    const discriminant = b * b - 4 * a * c;
    if (discriminant < 0) return null;
    entry = Math.max(0, (-b - Math.sqrt(discriminant)) / (2 * a));
    exit = Math.min(1, (-b + Math.sqrt(discriminant)) / (2 * a));
    if (entry > exit) return null;
  } else if (c > 0) return null;
  const tiltTravel = Math.abs(finite(paddleEnd.tilt) - finite(paddleStart.tilt)) * Math.PI / 180;
  const speedBound = length(relativeDelta) + RACKET_RADIUS * tiltTravel;
  function separation(t) {
    const paddle = interpolatePaddle(paddleStart, paddleEnd, t);
    const normal = racketNormal(paddle, side);
    const relative = vector(lerp(relativeStart.x, relativeEnd.x, t), lerp(relativeStart.y, relativeEnd.y, t), lerp(relativeStart.z, relativeEnd.z, t));
    const signedDistance = dot(relative, normal);
    const radial = Math.sqrt(Math.max(0, dot(relative, relative) - signedDistance * signedDistance));
    return { distance: Math.hypot(Math.max(0, Math.abs(signedDistance) - RACKET_FACE_DEPTH), Math.max(0, radial - RACKET_RADIUS)) - BALL_RADIUS - CONTACT_TOLERANCE, signedDistance, normal, paddle };
  }
  let t = entry;
  for (let iteration = 0; iteration < 40 && t <= exit + 1e-9; iteration++) {
    const contact = separation(t);
    if (contact.distance <= 2e-6) {
      // Only the front face returning towards the opponent counts. A ball
      // departing the racket cannot be returned repeatedly from an overlap.
      if (contact.signedDistance < -RACKET_FACE_DEPTH - CONTACT_TOLERANCE || dot(relativeDelta, contact.normal) >= -1e-12) return null;
      return { time: clamp(t, 0, 1), x: lerp(ballStart.x, ballEnd.x, t), y: lerp(ballStart.y, ballEnd.y, t), height: lerp(getBallHeight(ballStart), getBallHeight(ballEnd), t), paddle: contact.paddle };
    }
    if (speedBound < 1e-12) return null;
    t += Math.max(1e-7, contact.distance / speedBound * 0.95);
  }
  return null;
}
