import test from 'node:test';
import assert from 'node:assert/strict';
import { RoomConnection } from '../lib/network.js';

function connected(callbacks = {}) {
  const c = new RoomConnection(callbacks);
  Object.assign(c, { closed: false, room: { code: 'ABC234', role: 'guest' }, token: 'test', peerConnected: true, session: 'session', status: 'connected' });
  c._schedule = () => {};
  return c;
}

test('congested transports discard old motion while retaining the latest recovery state and commands', () => {
  const c = connected(), sent = [];
  const channel = { readyState: 'open', bufferedAmount: 8_000, send: value => sent.push(JSON.parse(value)) };
  c.fast = c.control = channel;
  c.socketBound = true;
  c.socket = { readyState: 1, bufferedAmount: 8_000, send: value => sent.push(JSON.parse(value)) };
  for (let i = 0; i < 20; i++) c.send({ type: 'input', input: { x: i } });
  assert.equal(sent.length, 0, 'old positions must not join an already delayed queue');
  assert.equal(c.realtime.data.input.x, 19, 'HTTP recovery must keep the newest position');
  c.send({ type: 'serve', gesture: { brushY: -2 } });
  assert.equal(sent.length, 1); assert.equal(sent[0].kind, 'reliable');
  assert.equal(c.reliable.length, 1, 'serve remains pending until acknowledged');
  channel.bufferedAmount = 0;
  c.send({ type: 'input', input: { x: 21 } });
  assert.equal(sent.at(-1).data.input.x, 21);
  c._receive({ kind: 'ack', session: c.session, seq: 1 });
  assert.equal(c.reliable.length, 0);
});

test('live traffic keeps a match connected when the independent HTTP heartbeat fails', async () => {
  const c = connected();
  c.lastSuccess = performance.now() - 20_000;
  c._receive({ kind: 'realtime', session: c.session, seq: 1, data: { type: 'state' } });
  c._request = async () => { throw new Error('HTTP unavailable'); };
  await c._sync();
  assert.equal(c.status, 'connected');
  c.status = 'connecting';
  c._receive({ kind: 'pong', session: c.session, t: performance.now() });
  assert.equal(c.status, 'connected', 'a recovered live channel resumes without waiting for HTTP');
});

test('wrong-session and malformed messages cannot fake live connectivity', () => {
  const c = connected(); c.lastSuccess = 123; c.status = 'connecting';
  c._receive({ kind: 'realtime', session: 'old-session', seq: 1 });
  c._receive({ kind: 'realtime', session: c.session, seq: NaN });
  c._receive({ kind: 'pong', session: c.session, t: NaN });
  c._receive({ kind: 'unknown', session: c.session, seq: 1 });
  assert.equal(c.lastSuccess, 123); assert.equal(c.status, 'connecting');
});

test('motion drops reordered snapshots while reliable commands remain ordered and deduplicated', () => {
  const delivered = [], c = connected({ onMessage: data => delivered.push(data) });
  const receive = (kind, seq) => c._receive({ kind, session: c.session, seq, data: `${kind}:${seq}` });
  receive('realtime', 8); receive('realtime', 3); receive('realtime', 8);
  receive('reliable', 2); receive('reliable', 1); receive('reliable', 1);
  assert.deepEqual(delivered, ['realtime:8', 'reliable:1', 'reliable:2']);
});
