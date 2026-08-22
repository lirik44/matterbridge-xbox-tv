import { LocalApiCategoryTypes, LocalApiFlags } from '../constants.js';

import { packetDef, packPayload, unpackFrom } from './packets.js';
import { applyPadding, SgCrypto } from './sgcrypto.js';
import { Structure } from './structure.js';

/** How long the signature every protected packet ends with is. */
const SIGNATURE_LENGTH = 32;

/** One of the packets that carry their own header rather than riding on a session. */
export interface SimplePacket {
  /** The first two bytes, which say what the packet is. */
  typeHex: string;
  /** The packet name, e.g. `discoveryResponse`. */
  type: string;
  payloadLength: number;
  payloadProtectedLength: number;
  version: number;
  /** The plain fields of the packet. */
  fields: Record<string, unknown>;
  /** The fields that arrived encrypted, once decrypted. */
  protectedFields?: Record<string, unknown>;
}

/**
 * Builds the header of a simple packet.
 *
 * The header is the two type bytes, the length of the plain payload, the length of
 * the encrypted payload where there is one, and the protocol version.
 *
 * The length of the encrypted payload is a field that is there or not, rather
 * than a field that can be zero: a discovery request leaves it out altogether,
 * while the wake packet carries it as a zero. Which is why it is optional here
 * and `0` is not the same as nothing.
 *
 * @param {Buffer} type The two type bytes.
 * @param {number} plainLength How long the plain part of the payload is.
 * @param {number | undefined} protectedLength How long the encrypted part is before padding, or `undefined` to leave the field out.
 * @param {number} version The protocol version to claim.
 * @returns {Buffer} The header.
 */
function header(type: Buffer, plainLength: number, protectedLength: number | undefined, version: number): Buffer {
  const structure = new Structure().writeBytes(type).writeUInt16(plainLength);
  if (protectedLength !== undefined) structure.writeUInt16(protectedLength);
  return structure.writeUInt16(version).toBuffer();
}

/**
 * Builds the wake packet.
 *
 * It is the one packet that needs neither a session nor a key: a console in
 * standby listens for it, which is how a console is powered on without the cloud.
 *
 * @param {string} liveId The Xbox Live device id of the console to wake.
 * @returns {Buffer} The packet, ready to be sent.
 */
export function packPowerOn(liveId: string): Buffer {
  const payload = packPayload(packetDef('powerOn') ?? [], { liveId });
  return Buffer.concat([header(LocalApiFlags.powerOn, payload.length, 0, 2), payload]);
}

/**
 * Builds the packet that asks a console to announce itself.
 *
 * @returns {Buffer} The packet, ready to be sent.
 */
export function packDiscoveryRequest(): Buffer {
  const payload = packPayload(packetDef('discoveryRequest') ?? []);
  return Buffer.concat([header(LocalApiFlags.discoveryRequest, payload.length, undefined, 0), payload]);
}

/** What goes into a connect request beyond the key exchange. */
export interface ConnectRequestOptions {
  /** The session id, sixteen random bytes. */
  uuid: Buffer;
  /** Our public key out of the key exchange. */
  publicKey: Buffer;
  /** Our initialization vector out of the key exchange. */
  iv: Buffer;
  /** The user hash of the Xbox Live account, or `''` to connect anonymously. */
  userHash: string;
  /** The XSTS token, or `''` to connect anonymously. */
  token: string;
  /** The sequence number this request counts as, when it carries a token. */
  connectRequestNum: number;
}

/**
 * Builds the packet that opens a session.
 *
 * The request carries our half of the key exchange in the clear and the Xbox Live
 * credentials encrypted with the key that exchange just produced. A console that
 * has remote connections limited to a signed-in account only accepts the second
 * form; one that allows anonymous connections accepts both.
 *
 * @param {SgCrypto} crypto The session crypto, after the key exchange.
 * @param {ConnectRequestOptions} options What to put into the request.
 * @returns {Buffer} The packet, ready to be sent.
 */
export function packConnectRequest(crypto: SgCrypto, options: ConnectRequestOptions): Buffer {
  const plain = packPayload(
    [...(packetDef('connectRequest') ?? [])].filter((entry) => entry.name !== 'payloadProtected'),
    { uuid: options.uuid, publicKey: options.publicKey, iv: options.iv },
  );

  const secret = packPayload(packetDef('connectRequestProtected') ?? [], {
    userHash: options.userHash,
    token: options.token,
    connectRequestNum: options.connectRequestNum,
    connectRequestGroupStart: 0,
    connectRequestGroupEnd: 1,
  });

  const encrypted = crypto.encrypt(applyPadding(secret), crypto.getKey(), options.iv);
  const packet = Buffer.concat([header(LocalApiFlags.connectRequest, plain.length, secret.length, 2), plain, encrypted]);

  return Buffer.concat([packet, crypto.sign(packet)]);
}

/**
 * Takes a simple packet apart.
 *
 * @param {Buffer} data The packet as it arrived.
 * @param {SgCrypto} [crypto] The session crypto, needed only for a packet with an encrypted payload.
 * @returns {SimplePacket} The packet, with its encrypted fields decrypted when there are any.
 * @throws {Error} When the packet is not one the plugin knows.
 */
export function unpackSimple(data: Buffer, crypto?: SgCrypto): SimplePacket {
  const structure = new Structure(data);
  const typeHex = structure.readBytes(2).toString('hex');
  const type = LocalApiCategoryTypes[typeHex];
  const def = packetDef(type);
  if (!def) throw new Error(`unknown simple packet type ${typeHex}`);

  const payloadLength = structure.readUInt16();
  let payloadProtectedLength = 0;
  let version = structure.readUInt16();

  // A packet with an encrypted payload carries its length where the version
  // otherwise sits, so a value that is not a known version is that length.
  if (version !== 0 && version !== 2) {
    payloadProtectedLength = version;
    version = structure.readUInt16();
  }

  const fields = unpackFrom(structure, def);
  const packet: SimplePacket = { typeHex, type, payloadLength, payloadProtectedLength, version, fields };

  const encrypted = fields.payloadProtected;
  if (!Buffer.isBuffer(encrypted) || encrypted.length === 0) return packet;

  if (!crypto?.ready) throw new Error(`${type} carries an encrypted payload but no session key has been derived`);

  const iv = Buffer.isBuffer(fields.iv) ? fields.iv : undefined;
  const body = encrypted.subarray(0, -SIGNATURE_LENGTH);
  const decrypted = crypto.decrypt(body, iv).subarray(0, payloadProtectedLength);

  const protectedDef = packetDef(`${type}Protected`);
  if (protectedDef) packet.protectedFields = unpackFrom(new Structure(decrypted), protectedDef);

  return packet;
}
