import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  encodeLength,
  decodeLength,
  encodeConnect,
  encodePublish,
  encodePingreq,
  parsePackets,
} from '../src/mqtt.js'

test('encodeLength följer MQTT-specen', () => {
  assert.deepEqual([...encodeLength(0)], [0])
  assert.deepEqual([...encodeLength(127)], [127])
  assert.deepEqual([...encodeLength(128)], [0x80, 0x01])
  assert.deepEqual([...encodeLength(16383)], [0xff, 0x7f])
  assert.deepEqual([...encodeLength(16384)], [0x80, 0x80, 0x01])
})

test('decodeLength rundtur och ofullständig buffert', () => {
  for (const n of [0, 1, 127, 128, 300, 16383, 16384, 2097151]) {
    const enc = encodeLength(n)
    assert.equal(decodeLength(enc).value, n)
  }
  assert.equal(decodeLength(Buffer.from([0x80])), null) // fortsättning saknas
})

test('CONNECT-paketet har rätt typ, protokoll och flaggor', () => {
  const pkt = encodeConnect({ clientId: 'abc', username: 'u', password: 'p' })
  assert.equal(pkt[0], 0x10)
  assert.ok(pkt.includes(Buffer.from('MQTT')))
  assert.ok(pkt.includes(Buffer.from([0x04]))) // protocol level
  assert.ok(pkt.includes(Buffer.from('abc')))
  const cleanPkt = encodeConnect({ clientId: 'abc' })
  const at = cleanPkt.indexOf(Buffer.from('MQTT'))
  assert.equal(cleanPkt[at + 4], 0x04) // protocol level
  assert.equal(cleanPkt[at + 5], 0x02) // clean session utan användare
})

test('PUBLISH sätter rätt flaggor för qos och retain', () => {
  const q0 = encodePublish({ topic: 'a/b', payload: 'x' })
  assert.equal(q0[0], 0x30)
  const q0r = encodePublish({ topic: 'a/b', payload: 'x', retain: true })
  assert.equal(q0r[0], 0x31)
  const q1 = encodePublish({ topic: 'a/b', payload: 'x', qos: 1, packetId: 5 })
  assert.equal(q1[0], 0x32)
  assert.ok(q1.includes(Buffer.from('a/b')))
})

test('parsePackets tolkar flera paket och behåller ofullständig svans', () => {
  const puback = Buffer.from([0x40, 0x02, 0x00, 0x05])
  const pingresp = Buffer.from([0xd0, 0x00])
  const { packets, rest } = parsePackets(Buffer.concat([pingresp, puback, Buffer.from([0xd0])]))
  assert.equal(packets.length, 2)
  assert.equal(packets[0].type, 13)
  assert.equal(packets[1].type, 4)
  assert.equal(packets[1].body.readUInt16BE(0), 5)
  assert.deepEqual([...rest], [0xd0])
})

test('pingreq är rätt två bytes', () => {
  assert.deepEqual([...encodePingreq()], [0xc0, 0x00])
})
