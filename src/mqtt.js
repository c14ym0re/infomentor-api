// Minimal MQTT 3.1.1-klient (publicera + keepalive + reconnect).
// Handskriven för att hålla projektet beroendefritt. Stödjer QoS 0 och 1.
import net from 'node:net'
import tls from 'node:tls'

// ---------------------------------------------------------------- kodning
/** Varibellängd-kodning av "remaining length" (MQTT 3.1.1 §2.2.3). */
export function encodeLength(n) {
  const out = []
  do {
    let byte = n % 128
    n = Math.floor(n / 128)
    if (n > 0) byte |= 0x80
    out.push(byte)
  } while (n > 0)
  return Buffer.from(out)
}

/** Läser en varibellängd. Returnerar null om bufferten är ofullständig. */
export function decodeLength(buf, offset = 0) {
  let multiplier = 1
  let value = 0
  let i = offset
  while (i < buf.length) {
    const byte = buf[i]
    value += (byte & 0x7f) * multiplier
    if ((byte & 0x80) === 0) return { value, bytes: i - offset + 1 }
    multiplier *= 128
    i++
    if (multiplier > 128 ** 3) throw new Error('Ogiltig remaining length')
  }
  return null
}

function encodeString(s) {
  const b = Buffer.from(s ?? '', 'utf8')
  const len = Buffer.alloc(2)
  len.writeUInt16BE(b.length, 0)
  return Buffer.concat([len, b])
}

function packet(type, flags, body) {
  return Buffer.concat([Buffer.from([(type << 4) | flags]), encodeLength(body.length), body])
}

export function encodeConnect({ clientId, username, password, keepalive = 60, clean = true } = {}) {
  let flags = 0
  if (clean) flags |= 0x02
  const payloads = [encodeString(clientId ?? '')]
  if (username != null) {
    flags |= 0x80
    payloads.push(encodeString(username))
    if (password != null) {
      flags |= 0x40
      payloads.push(encodeString(password))
    }
  }
  const body = Buffer.concat([
    encodeString('MQTT'),
    Buffer.from([0x04]), // protocol level 4
    Buffer.from([flags]),
    (() => {
      const k = Buffer.alloc(2)
      k.writeUInt16BE(keepalive, 0)
      return k
    })(),
    ...payloads,
  ])
  return packet(1, 0, body)
}

export function encodePublish({ topic, payload = '', qos = 0, retain = false, dup = false, packetId = 0 }) {
  let flags = (dup ? 0x08 : 0) | (qos << 1) | (retain ? 0x01 : 0)
  const parts = [encodeString(topic)]
  if (qos > 0) {
    const id = Buffer.alloc(2)
    id.writeUInt16BE(packetId, 0)
    parts.push(id)
  }
  parts.push(Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf8'))
  return packet(3, flags, Buffer.concat(parts))
}

export const encodePingreq = () => Buffer.from([0xc0, 0x00])
export const encodeDisconnect = () => Buffer.from([0xe0, 0x00])

/** Delar upp en inkommande buffer i kompletta paket. */
export function parsePackets(buf) {
  const packets = []
  let offset = 0
  while (offset < buf.length) {
    const head = buf[offset]
    const len = decodeLength(buf, offset + 1)
    if (!len) break
    const total = 1 + len.bytes + len.value
    if (offset + total > buf.length) break
    packets.push({
      type: head >> 4,
      flags: head & 0x0f,
      body: buf.subarray(offset + 1 + len.bytes, offset + total),
    })
    offset += total
  }
  return { packets, rest: buf.subarray(offset) }
}

// ---------------------------------------------------------------- klient
export class MqttClient {
  /**
   * @param {object} opts
   * @param {string} opts.url  mqtt://host:port eller mqtts://host:port
   * @param {string} [opts.username]
   * @param {string} [opts.password]
   * @param {string} [opts.clientId]
   * @param {number} [opts.keepalive]
   * @param {() => void} [opts.onReconnect]  anropas efter lyckad återanslutning
   */
  constructor(opts) {
    this.opts = opts
    const u = new URL(opts.url)
    this.secure = u.protocol === 'mqtts:'
    this.host = u.hostname
    this.port = Number(u.port || (this.secure ? 8883 : 1883))
    this.clientId = opts.clientId || `infomentor-${Math.random().toString(16).slice(2, 10)}`
    this.keepalive = opts.keepalive ?? 60

    this.socket = null
    this.connected = false
    this.buf = Buffer.alloc(0)
    this.packetId = 0
    this.pending = new Map()
    this.keepaliveTimer = null
    this.reconnectDelay = 1000
    this.closing = false
    this.connectResolve = null
    this.connectReject = null
  }

  connect() {
    this.closing = false
    return new Promise((resolve, reject) => {
      this.connectResolve = resolve
      this.connectReject = reject
      const onConnect = () => {
        this.socket.write(
          encodeConnect({
            clientId: this.clientId,
            username: this.opts.username,
            password: this.opts.password,
            keepalive: this.keepalive,
          })
        )
      }
      this.socket = this.secure
        ? tls.connect({ host: this.host, port: this.port, servername: this.host }, onConnect)
        : net.connect({ host: this.host, port: this.port }, onConnect)

      this.socket.on('data', (chunk) => this._onData(chunk))
      this.socket.on('error', (err) => this._onError(err))
      this.socket.on('close', () => this._onClose())
    })
  }

  _onData(chunk) {
    this.buf = Buffer.concat([this.buf, chunk])
    const { packets, rest } = parsePackets(this.buf)
    this.buf = rest
    for (const p of packets) {
      if (p.type === 2) {
        // CONNACK
        const rc = p.body[1]
        if (rc === 0) {
          this.connected = true
          this.reconnectDelay = 1000
          this._startKeepalive()
          const resolve = this.connectResolve
          this.connectResolve = this.connectReject = null
          if (this.opts.onReconnect) this.opts.onReconnect()
          if (resolve) resolve()
        } else {
          this._onError(new Error(`MQTT CONNACK rc=${rc} (5 = not authorized)`))
        }
      } else if (p.type === 4) {
        // PUBACK
        const id = p.body.readUInt16BE(0)
        const r = this.pending.get(id)
        if (r) {
          this.pending.delete(id)
          r()
        }
      }
      // PINGRESP (13) och övriga ignoreras tyst
    }
  }

  _startKeepalive() {
    this._stopKeepalive()
    this.keepaliveTimer = setInterval(() => {
      if (this.socket && !this.socket.destroyed) this.socket.write(encodePingreq())
    }, Math.max(5, Math.floor(this.keepalive / 2)) * 1000)
    if (this.keepaliveTimer.unref) this.keepaliveTimer.unref()
  }

  _stopKeepalive() {
    if (this.keepaliveTimer) clearInterval(this.keepaliveTimer)
    this.keepaliveTimer = null
  }

  _onError(err) {
    const rej = this.connectReject
    this.connectReject = this.connectResolve = null
    if (rej) rej(err)
    else if (this.opts.onError) this.opts.onError(err)
  }

  _onClose() {
    this.connected = false
    this._stopKeepalive()
    if (this.closing) return
    if (this.opts.onError) this.opts.onError(new Error(`MQTT-anslutning stängd, återansluter om ${this.reconnectDelay}ms`))
    const delay = this.reconnectDelay
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, 60000)
    const t = setTimeout(() => {
      this.connect().catch(() => {})
    }, delay)
    if (t.unref) t.unref()
  }

  /** Publicerar ett meddelande. QoS 1 väntar på PUBACK. */
  publish(topic, payload = '', { qos = 0, retain = false } = {}) {
    if (!this.socket || this.socket.destroyed) return Promise.reject(new Error('MQTT ej ansluten'))
    const packetId = qos > 0 ? ++this.packetId : 0
    const buf = encodePublish({ topic, payload, qos, retain, packetId })
    if (qos === 0) {
      this.socket.write(buf)
      return Promise.resolve()
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(packetId)
        reject(new Error('PUBACK timeout'))
      }, 10000)
      this.pending.set(packetId, () => {
        clearTimeout(timer)
        resolve()
      })
      this.socket.write(buf)
    })
  }

  end() {
    this.closing = true
    this._stopKeepalive()
    if (this.socket && !this.socket.destroyed) {
      try {
        this.socket.write(encodeDisconnect())
      } catch {}
      this.socket.end()
    }
  }
}
