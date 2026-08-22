import { LocalApiFlags, LocalApiMessageTypes } from '../constants.js';

import { packetDef, packPayload, unpackFrom } from './packets.js';
import { applyPadding, SgCrypto } from './sgcrypto.js';
import { Structure } from './structure.js';

/** How long the signature every message ends with is. */
const SIGNATURE_LENGTH = 32;

/** How long the header of a message is. The message initialization vector is derived from its first 16 bytes. */
const HEADER_LENGTH = 26;

/** The channel every message of this plugin goes over: the one the session itself is on. */
const BASE_CHANNEL = Buffer.alloc(8);

/** What the two flag bytes of a message say. */
export interface MessageFlags {
  version: number;
  /** Whether the console expects an acknowledgement, which it does for anything that matters. */
  needAcknowledge: boolean;
  /** Whether this is one fragment of a message too large for a datagram. */
  isFragment: boolean;
  /** The message name, e.g. `consoleStatus`. */
  type: string;
}

/** One message of an open session. */
export interface DecodedMessage {
  typeHex: string;
  payloadLength: number;
  sequenceNumber: number;
  targetParticipantId: number;
  sourceParticipantId: number;
  flags: MessageFlags;
  channelId: Buffer;
  /** The decrypted fields, empty when the plugin has no definition for this message. */
  payload: Record<string, unknown>;
}

/** Where a message is going and what number it carries. */
export interface MessageSession {
  sequenceNumber: number;
  targetParticipantId: number;
  sourceParticipantId: number;
}

/**
 * Reads the two flag bytes of a message.
 *
 * @param {Buffer} flags The two bytes.
 * @returns {MessageFlags} What they say.
 */
export function readFlags(flags: Buffer): MessageFlags {
  const value = flags.readUInt16BE(0);
  return {
    version: value >> 14,
    needAcknowledge: ((value >> 13) & 1) === 1,
    isFragment: ((value >> 12) & 1) === 1,
    type: LocalApiMessageTypes[value & 0x0fff] ?? `unknown(${value & 0x0fff})`,
  };
}

/**
 * Builds one message of an open session.
 *
 * The payload is padded, encrypted with an initialization vector derived from the
 * header, and signed — so a message cannot be replayed against another session and
 * cannot be altered in flight.
 *
 * @param {SgCrypto} crypto The session crypto.
 * @param {string} type The message name, which must be one the plugin has flags for.
 * @param {MessageSession} session The sequence number and the two participant ids.
 * @param {Record<string, unknown>} [values] The fields to set, where the defaults are not wanted.
 * @returns {Buffer} The message, ready to be sent.
 * @throws {Error} When the message name is not one the plugin can build.
 */
export function packMessage(crypto: SgCrypto, type: string, session: MessageSession, values: Record<string, unknown> = {}): Buffer {
  const def = packetDef(type);
  const flags = LocalApiFlags[type];
  if (!def || !flags) throw new Error(`cannot build a ${type} message`);

  const payload = applyPadding(packPayload(def, values));

  const header = new Structure()
    .writeBytes(Buffer.from('d00d', 'hex'))
    .writeUInt16(payload.length)
    .writeUInt32(session.sequenceNumber)
    .writeUInt32(session.targetParticipantId)
    .writeUInt32(session.sourceParticipantId)
    .writeBytes(flags)
    .writeBytes(BASE_CHANNEL)
    .toBuffer();

  const encrypted = crypto.encrypt(payload, crypto.getKey(), crypto.messageIv(header));
  const message = Buffer.concat([header, encrypted]);

  return Buffer.concat([message, crypto.sign(message)]);
}

/**
 * Takes one message of an open session apart.
 *
 * @param {SgCrypto} crypto The session crypto.
 * @param {Buffer} data The message as it arrived.
 * @returns {DecodedMessage} The message, with its payload decrypted.
 */
export function unpackMessage(crypto: SgCrypto, data: Buffer): DecodedMessage {
  const structure = new Structure(data);
  const typeHex = structure.readBytes(2).toString('hex');
  const payloadLength = structure.readUInt16();
  const sequenceNumber = structure.readUInt32();
  const targetParticipantId = structure.readUInt32();
  const sourceParticipantId = structure.readUInt32();
  const flags = readFlags(structure.readBytes(2));
  const channelId = structure.readBytes(8);
  const rest = structure.readBytes();

  const message: DecodedMessage = { typeHex, payloadLength, sequenceNumber, targetParticipantId, sourceParticipantId, flags, channelId, payload: {} };

  const body = rest.subarray(0, -SIGNATURE_LENGTH);
  if (body.length === 0) return message;

  const decrypted = crypto.decrypt(body, crypto.messageIv(data.subarray(0, HEADER_LENGTH)));
  const def = packetDef(flags.type);
  if (def) message.payload = unpackFrom(new Structure(decrypted), def);

  return message;
}
