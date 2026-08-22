import { createSocket, type Socket } from 'node:dgram';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';

import type { AnsiLogger } from 'matterbridge/logger';

import { CONNECT_RESULTS, LOCAL_API_PORT, LOCAL_CLIENT_TYPES, LocalApiCategories } from '../constants.js';
import { delay, errorMessage } from '../utils.js';

import { packMessage, unpackMessage, type MessageSession } from './message.js';
import { SgCrypto } from './sgcrypto.js';
import { packConnectRequest, packDiscoveryRequest, packPowerOn, unpackSimple } from './simple.js';

/** How long the console may stay silent before the session is given up, in milliseconds. */
const INACTIVITY_TIMEOUT_MS = 14_000;

/** How often the watchdog looks at how long the console has been silent, in milliseconds. */
const WATCHDOG_INTERVAL_MS = 1000;

/** How many wake packets are sent before powering on is called a failure. */
const POWER_ON_ATTEMPTS = 15;

/** How long to wait between wake packets, in milliseconds. */
const POWER_ON_INTERVAL_MS = 1000;

/** What the local protocol reports about the console. */
export interface LocalDeviceInfo {
  /** The dashboard version, e.g. `10.0.26100`. */
  firmwareRevision: string;
  locale: string;
}

/** What the local protocol reports about the state of the console. */
export interface LocalState {
  /** Whether the console is running a title, which is what being on means here. */
  power: boolean;
  titleId: string;
  /** The AUMID of the foreground title. */
  reference: string;
}

/** The Xbox Live credentials a session can be authenticated with. */
export interface LocalCredentials {
  /** The user hash of the account. */
  userHash: string;
  /** The XSTS token. */
  token: string;
}

/** What the client needs to reach one console. */
export interface LocalApiOptions {
  /** The console name, for the log. */
  name: string;
  /** The console IP address or hostname. */
  host: string;
  /** The Xbox Live device id, which the wake and shutdown packets carry. */
  liveId: string;
  log: AnsiLogger;
  /**
   * Hands over the Xbox Live credentials of the moment, or `undefined` to connect anonymously.
   *
   * It is a callback rather than a value because the XSTS token is refreshed
   * every so often, and a session opened tomorrow needs tomorrow's token.
   *
   * @returns {LocalCredentials | undefined} The credentials, when there are any.
   */
  credentials: () => LocalCredentials | undefined;
}

/** The events the client emits. */
interface LocalApiEvents {
  /** The console reported its dashboard version and locale. */
  deviceInfo: [LocalDeviceInfo];
  /** The console reported what it is running. */
  state: [LocalState];
  /** A session was accepted. */
  connected: [];
  /** The session ended, whether politely or by falling silent. */
  disconnected: [];
}

/**
 * The SmartGlass client of one Xbox console.
 *
 * The protocol is a UDP one on port 5050 with three steps. A discovery request
 * asks every console on the network to announce itself; the announcement carries
 * a certificate, and an ECDH exchange against its public key produces the session
 * key. A connect request opens the session, optionally carrying an Xbox Live
 * token, and from then on the console sends its state every few seconds and
 * expects each of those messages to be acknowledged.
 *
 * The connection is therefore never established once and for all: the console
 * falls silent whenever it is switched off, and the client goes back to sending
 * discovery requests until it answers again. That is also why powering on is the
 * one thing that needs no session — a console in standby answers nothing but the
 * wake packet.
 */
export class XboxLocalApi extends EventEmitter<LocalApiEvents> {
  private readonly log: AnsiLogger;
  private readonly name: string;
  private readonly host: string;
  private readonly liveId: string;
  private readonly credentials: () => LocalCredentials | undefined;

  private socket?: Socket;
  private binding?: Promise<void>;
  private crypto?: SgCrypto;

  private connected = false;
  private connecting = false;
  private stopped = false;
  /** Set once the current session was opened with an Xbox Live token rather than anonymously. */
  private authorized = false;

  private sequenceNumber = 0;
  private sourceParticipantId = 0;
  private targetParticipantId = 0;

  private lastSeen = 0;
  private watchdog?: NodeJS.Timeout;

  constructor(options: LocalApiOptions) {
    super();
    this.name = options.name;
    this.host = options.host;
    this.liveId = options.liveId;
    this.log = options.log;
    this.credentials = options.credentials;
  }

  /** @returns {boolean} Whether a session is open. */
  get isConnected(): boolean {
    return this.connected;
  }

  /** @returns {boolean} Whether the open session carries an Xbox Live token. */
  get isAuthorized(): boolean {
    return this.connected && this.authorized;
  }

  /**
   * Looks for the console, opening a session when it answers.
   *
   * Called on every heartbeat: a console that is switched off simply does not
   * answer, and the next heartbeat tries again.
   *
   * @returns {Promise<void>} Resolves once the discovery request has been sent.
   */
  async discover(): Promise<void> {
    if (this.stopped || this.connected || this.connecting) return;
    await this.send(packDiscoveryRequest(), 'discoveryRequest');
  }

  /**
   * Wakes the console.
   *
   * The wake packet needs no session and no key: it is the one thing a console in
   * standby listens for. It is sent repeatedly, because a console coming out of
   * standby misses the first few, and stops as soon as a session comes up.
   *
   * @returns {Promise<boolean>} Whether the console came up.
   */
  async powerOn(): Promise<boolean> {
    const packet = packPowerOn(this.liveId);

    for (let attempt = 0; attempt < POWER_ON_ATTEMPTS; attempt++) {
      if (this.stopped) return false;
      if (this.connected) return true;

      await this.send(packet, 'powerOn');
      // The console only answers a discovery request once it has actually booted,
      // so both are sent on every attempt: the wake packet to bring it up, the
      // discovery request to notice that it is up.
      await this.discover();
      await delay(POWER_ON_INTERVAL_MS);
    }

    return this.connected;
  }

  /**
   * Shuts the console down.
   *
   * @returns {Promise<boolean>} Whether the request could be sent, which needs an open session.
   */
  async powerOff(): Promise<boolean> {
    if (!this.connected || !this.crypto) {
      this.log.debug(`${this.name} | cannot shut the console down over the local protocol without an open session`);
      return false;
    }

    await this.sendMessage('powerOff', { liveId: this.liveId });
    return true;
  }

  /**
   * Asks the console to keep the last minute of play as a clip.
   *
   * @returns {Promise<boolean>} Whether the request could be sent, which needs a session opened with an Xbox Live token.
   */
  async recordGameDvr(): Promise<boolean> {
    if (!this.connected || !this.authorized) {
      this.log.warn(`${this.name} | recording a clip needs a local session opened with an Xbox Live token`);
      return false;
    }

    await this.sendMessage('recordGameDvr', { startTimeDelta: -60, endTimeDelta: 0 });
    return true;
  }

  /** Closes the socket and stops everything pending. */
  stop(): void {
    this.stopped = true;
    clearInterval(this.watchdog);
    this.watchdog = undefined;
    this.endSession(false);

    const socket = this.socket;
    this.socket = undefined;
    this.binding = undefined;
    if (socket) {
      socket.removeAllListeners();
      try {
        socket.close();
      } catch {
        // Already closed, which is the state we wanted.
      }
    }
  }

  // --- socket ---------------------------------------------------------------

  /**
   * Binds the socket, once.
   *
   * One socket serves every session of this console: binding a new one per
   * attempt leaks an ephemeral port for every console that happens to be off.
   *
   * @returns {Promise<void>} Resolves once the socket is listening.
   */
  private async bind(): Promise<void> {
    if (this.binding) return this.binding;

    this.binding = new Promise<void>((resolve, reject) => {
      const socket = createSocket('udp4');
      this.socket = socket;

      socket.on('error', (error) => {
        this.log.debug(`${this.name} | socket error: ${errorMessage(error)}`);
        this.binding = undefined;
        this.socket = undefined;
        socket.removeAllListeners();
        socket.close();
        this.endSession(true);
        reject(new Error(errorMessage(error)));
      });

      socket.on('message', (data) => {
        this.handle(data).catch((error: unknown) => {
          this.log.debug(`${this.name} | could not handle a packet: ${errorMessage(error)}`);
        });
      });

      socket.once('listening', () => {
        // Broadcast is enabled so that the wake packet can also be sent to a
        // broadcast address, which is what reaches a console whose address
        // changed while it was off.
        socket.setBroadcast(true);
        this.log.debug(`${this.name} | listening on ${socket.address().address}:${socket.address().port}`);
        resolve();
      });

      socket.bind();
    });

    return this.binding;
  }

  /**
   * Sends one packet to the console.
   *
   * @param {Buffer} packet The packet to send.
   * @param {string} type What it is, for the log.
   * @returns {Promise<void>} Resolves once the datagram has been handed to the network.
   */
  private async send(packet: Buffer, type: string): Promise<void> {
    await this.bind();
    const socket = this.socket;
    if (!socket) throw new Error('the socket is closed');

    await new Promise<void>((resolve, reject) => {
      socket.send(packet, 0, packet.length, LOCAL_API_PORT, this.host, (error, bytes) => {
        if (error) {
          reject(new Error(`could not send ${type}: ${errorMessage(error)}`));
          return;
        }
        this.log.debug(`${this.name} | sent ${type} to ${this.host}:${LOCAL_API_PORT}, ${bytes}B`);
        resolve();
      });
    });
  }

  /**
   * Sends one message of the open session.
   *
   * @param {string} type The message name.
   * @param {Record<string, unknown>} [values] The fields to set.
   * @returns {Promise<void>} Resolves once the datagram has been handed to the network.
   */
  private async sendMessage(type: string, values: Record<string, unknown> = {}): Promise<void> {
    if (!this.crypto) throw new Error(`cannot send ${type} without a session`);

    const session: MessageSession = {
      sequenceNumber: this.nextSequenceNumber(),
      targetParticipantId: this.targetParticipantId,
      sourceParticipantId: this.sourceParticipantId,
    };

    await this.send(packMessage(this.crypto, type, session, values), type);
  }

  /** @returns {number} The next sequence number of this session. */
  private nextSequenceNumber(): number {
    const current = this.sequenceNumber;
    this.sequenceNumber = (this.sequenceNumber + 1) >>> 0;
    return current;
  }

  // --- incoming -------------------------------------------------------------

  /**
   * Routes one incoming packet.
   *
   * @param {Buffer} data The packet as it arrived.
   * @returns {Promise<void>} Resolves once the packet has been dealt with.
   */
  private async handle(data: Buffer): Promise<void> {
    if (this.stopped || data.length < 4) return;

    const typeHex = data.subarray(0, 2).toString('hex');
    const category = LocalApiCategories[typeHex];
    if (!category) {
      this.log.debug(`${this.name} | ignoring a packet of unknown type ${typeHex}`);
      return;
    }

    if (category === 'message') {
      await this.handleMessage(data);
      return;
    }

    const packet = unpackSimple(data, this.crypto);
    switch (packet.type) {
      case 'discoveryResponse':
        await this.handleDiscoveryResponse(packet.fields);
        return;
      case 'connectResponse':
        await this.handleConnectResponse(packet.protectedFields ?? {}, packet.fields);
        return;
      default:
        this.log.debug(`${this.name} | ignoring a ${packet.type} packet`);
    }
  }

  /**
   * Answers a console that announced itself by asking for a session.
   *
   * @param {Record<string, unknown>} fields The fields of the announcement.
   * @returns {Promise<void>} Resolves once the connect request has been sent.
   */
  private async handleDiscoveryResponse(fields: Record<string, unknown>): Promise<void> {
    if (this.connected || this.connecting) return;

    const certificate = fields.certificate;
    if (!Buffer.isBuffer(certificate) || certificate.length === 0) {
      this.log.error(`${this.name} | announced itself without a certificate, so no session can be opened`);
      return;
    }

    const clientType = typeof fields.clientType === 'number' ? fields.clientType : 0;
    this.log.debug(`${this.name} | announced itself as "${String(fields.consoleName)}", a ${LOCAL_CLIENT_TYPES[clientType] ?? 'console'}`);

    this.connecting = true;
    try {
      const crypto = new SgCrypto();
      const { publicKey, iv } = crypto.exchangeKeys(certificate);
      this.crypto = crypto;

      const credentials = this.credentials();
      this.authorized = credentials !== undefined;

      const packet = packConnectRequest(crypto, {
        uuid: Buffer.from(randomUUID().replace(/-/g, ''), 'hex'),
        publicKey,
        iv,
        userHash: credentials?.userHash ?? '',
        token: credentials?.token ?? '',
        connectRequestNum: this.nextSequenceNumber(),
      });

      this.log.debug(`${this.name} | opening a session ${this.authorized ? 'with an Xbox Live token' : 'anonymously'}`);
      await this.send(packet, 'connectRequest');
    } catch (error) {
      this.connecting = false;
      this.crypto = undefined;
      this.log.error(`${this.name} | could not open a session: ${errorMessage(error)}`);
    }
  }

  /**
   * Takes the answer to a connect request and joins the session it opened.
   *
   * @param {Record<string, unknown>} protectedFields The decrypted fields of the answer.
   * @param {Record<string, unknown>} _fields The plain fields, which carry only the initialization vector.
   * @returns {Promise<void>} Resolves once the join message has been sent.
   */
  private async handleConnectResponse(protectedFields: Record<string, unknown>, _fields: Record<string, unknown>): Promise<void> {
    this.connecting = false;

    const result = typeof protectedFields.connectResult === 'number' ? protectedFields.connectResult : 2;
    if (result !== 0) {
      this.log.error(`${this.name} | refused the session: ${CONNECT_RESULTS[result] ?? String(result)}`);
      this.endSession(false);
      return;
    }

    this.connected = true;
    this.sourceParticipantId = typeof protectedFields.participantId === 'number' ? protectedFields.participantId : 0;
    this.lastSeen = Date.now();
    this.startWatchdog();

    try {
      await this.sendMessage('localJoin');
      this.log.info(`${this.name} | connected over the local protocol`);
      this.emit('connected');
    } catch (error) {
      this.log.error(`${this.name} | could not join the session: ${errorMessage(error)}`);
      this.endSession(true);
    }
  }

  /**
   * Handles one message of the open session.
   *
   * @param {Buffer} data The message as it arrived.
   * @returns {Promise<void>} Resolves once the message has been dealt with and acknowledged.
   */
  private async handleMessage(data: Buffer): Promise<void> {
    if (!this.crypto?.ready) return;

    const message = unpackMessage(this.crypto, data);

    // A message addressed to another participant of the console is none of our
    // business; a message addressed to nobody in particular is broadcast state.
    if (message.targetParticipantId !== 0 && message.targetParticipantId !== this.sourceParticipantId) {
      this.log.debug(`${this.name} | ignoring a ${message.flags.type} message for participant ${message.targetParticipantId}`);
      return;
    }

    this.targetParticipantId = message.sourceParticipantId || this.targetParticipantId;

    if (message.flags.needAcknowledge) {
      await this.acknowledge(message.sequenceNumber).catch((error: unknown) => {
        this.log.debug(`${this.name} | could not acknowledge a ${message.flags.type} message: ${errorMessage(error)}`);
      });
    }

    switch (message.flags.type) {
      case 'consoleStatus':
        this.handleConsoleStatus(message.payload);
        break;
      case 'acknowledge':
        this.lastSeen = Date.now();
        break;
      case 'disconnect':
        this.log.debug(`${this.name} | the console ended the session`);
        this.endSession(true);
        break;
      case 'pairedIdentityStateChanged':
        this.log.debug(`${this.name} | the pairing state of the console changed`);
        break;
      default:
        this.log.debug(`${this.name} | received a ${message.flags.type} message`);
    }
  }

  /**
   * Takes a state report and turns it into what the accessory needs.
   *
   * @param {Record<string, unknown>} payload The fields of the report.
   */
  private handleConsoleStatus(payload: Record<string, unknown>): void {
    this.lastSeen = Date.now();

    const titles = Array.isArray(payload.activeTitles) ? (payload.activeTitles as Record<string, unknown>[]) : [];
    const foreground = titles[0];

    // A console with nothing running is a console in standby: it still answers
    // the network, which is why the title list rather than reachability is what
    // says whether it is on.
    const state: LocalState = {
      power: titles.length > 0,
      titleId: foreground ? String(foreground.titleId ?? '') : '',
      reference: foreground ? String(foreground.aumId ?? '') : '',
    };

    const firmwareRevision = `${String(payload.majorVersion ?? 0)}.${String(payload.minorVersion ?? 0)}.${String(payload.buildNumber ?? 0)}`;
    this.emit('deviceInfo', { firmwareRevision, locale: String(payload.locale ?? '') });
    this.emit('state', state);
  }

  /**
   * Acknowledges one message, which is what keeps the session alive.
   *
   * @param {number} sequenceNumber The number of the message to acknowledge.
   * @returns {Promise<void>} Resolves once the acknowledgement has been sent.
   */
  private async acknowledge(sequenceNumber: number): Promise<void> {
    await this.sendMessage('acknowledge', {
      lowWatermark: sequenceNumber,
      processedList: [{ id: sequenceNumber }],
      rejectedList: [],
    });
  }

  // --- session --------------------------------------------------------------

  /** Starts watching how long the console has been silent. */
  private startWatchdog(): void {
    if (this.watchdog) return;

    this.watchdog = setInterval(() => {
      if (!this.connected) return;

      const elapsed = Date.now() - this.lastSeen;
      if (elapsed < INACTIVITY_TIMEOUT_MS) return;

      // A console being switched off stops answering without saying anything, so
      // silence is the only sign of it. Pings would not do: a console in standby
      // keeps answering those for minutes.
      this.log.debug(`${this.name} | silent for ${Math.round(elapsed / 1000)}s, giving up the session`);
      void this.sendMessage('disconnect', { reason: 2, errorCode: 0 }).catch(() => {
        // The console is already gone; there is nothing to tell.
      });
      this.endSession(true);
    }, WATCHDOG_INTERVAL_MS);

    this.watchdog.unref();
  }

  /**
   * Drops the session, keeping the socket for the next one.
   *
   * @param {boolean} announce Whether anyone should hear about it, which is not the case for a session that never opened.
   */
  private endSession(announce: boolean): void {
    const wasConnected = this.connected;

    this.connected = false;
    this.connecting = false;
    this.authorized = false;
    this.crypto = undefined;
    this.sequenceNumber = 0;
    this.sourceParticipantId = 0;
    this.targetParticipantId = 0;

    clearInterval(this.watchdog);
    this.watchdog = undefined;

    if (announce && wasConnected) {
      this.emit('state', { power: false, titleId: '', reference: '' });
      this.emit('disconnected');
    }
  }
}
