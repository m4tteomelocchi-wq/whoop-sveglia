// Golden frame dai test di NOOP (DeviceFamilyFramingTests.swift), incrociati con Android.
import assert from 'node:assert/strict';
import * as W from '../whoop5.js';

const hex = (u8) => Buffer.from(u8).toString('hex');

// CLIENT_HELLO statico che l'app ufficiale invia alla connessione
assert.equal(hex(W.commandFrame(W.CMD.GET_HELLO, 1, W.helloBody())), 'aa0108000001e67123019101363e5c8d');

assert.equal(hex(W.commandFrame(W.CMD.BUZZ, 1, W.buzzBody(1))),
  'aa0114000001e1e1230113012f980000000000000000000098cb83a5');

// 1_700_000_000_123 ms → 123 ms = 4030 tick da 1/32768 s
assert.equal(hex(W.commandFrame(W.CMD.SET_ALARM, 1, W.setAlarmBody(1, 1_700_000_000, { ticks: 4030 }))),
  'aa011c000001e381230142040100f15365be0f2f980000000000000000071e00392f2ac9');

assert.equal(hex(W.commandFrame(W.CMD.DISABLE_ALARM, 1, W.disableAlarmBody())),
  'aa010c000001e74123014502ff000000267ffc4f');
assert.equal(hex(W.commandFrame(W.CMD.RUN_ALARM, 2, [0x02, 0x01])),
  'aa010c000001e74123024402010000008ad7f1d3');

// Il riassemblatore ricompone un frame spezzato e scarta il rumore davanti
const meta = Uint8Array.from(Buffer.from('aa010c000001e741380300abcd00000060153281', 'hex'));
const r = new W.Reassembler();
assert.deepEqual(r.feed([0x00, 0x13, ...meta.slice(0, 7)]), []);
const [f] = r.feed(meta.slice(7));
assert.equal(hex(f), hex(meta));
assert.ok(W.frameOk(f));

// Risposta sintetica a SET_ALARM: esito SUCCESS, dettaglio 1
const inner = [36, 9, W.CMD.SET_ALARM, 5, 1, 0x04, 0x01, 0];
const head = [0xaa, 0x01, inner.length + 4, 0, 0x00, 0x01];
const c16 = W.crc16modbus(head), c32 = W.crc32(inner);
const resp = Uint8Array.from([...head, c16 & 0xff, c16 >> 8, ...inner,
  c32 & 0xff, (c32 >> 8) & 0xff, (c32 >> 16) & 0xff, c32 >>> 24]);
assert.ok(W.frameOk(resp));
const p = W.parseResponse(resp);
assert.equal(p.cmd, W.CMD.SET_ALARM);
assert.equal(p.originSeq, 5);
assert.equal(p.result, 1);
assert.deepEqual([...p.body.slice(0, 2)], [4, 1]);

console.log('ok — tutti i frame combaciano con i golden di NOOP');
