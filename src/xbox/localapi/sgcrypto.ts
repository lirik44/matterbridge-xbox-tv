import { createCipheriv, createDecipheriv, createECDH, createHash, createHmac, X509Certificate } from 'node:crypto';
import { EOL } from 'node:os';

/** The all zero initialization vector the two key derivation steps use. */
const ZERO_IV = Buffer.alloc(16);

/** The salts Microsoft puts around the shared secret before hashing it. */
const PRE_SALT = Buffer.from('d637f1aae2f0418c', 'hex');
const POST_SALT = Buffer.from('a8f81a574e228ab7', 'hex');

/**
 * The session crypto of one SmartGlass connection.
 *
 * The console announces itself with a certificate carrying a P-256 public key.
 * The client generates a key pair of its own, does an ECDH exchange, and hashes
 * the shared secret into three pieces: the AES key, the base initialization
 * vector, and the key the HMAC over every packet is taken with. All three live
 * for exactly one session, which is why this is an object rather than a module.
 */
export class SgCrypto {
  private key?: Buffer;
  private iv?: Buffer;
  private hashKey?: Buffer;

  /** @returns {boolean} Whether the key exchange has happened, so packets can be encrypted. */
  get ready(): boolean {
    return this.key !== undefined;
  }

  /**
   * Does the key exchange against the certificate the console announced itself with.
   *
   * @param {Buffer} certificate The DER certificate out of the discovery response.
   * @returns {{ publicKey: Buffer; iv: Buffer }} Our public key and initialization vector, both of which go into the connect request.
   * @throws {Error} When the certificate cannot be read or carries no P-256 key.
   */
  exchangeKeys(certificate: Buffer): { publicKey: Buffer; iv: Buffer } {
    const base64 = certificate.toString('base64');
    const lines = base64.match(/.{1,64}/g) ?? [];
    const pem = `-----BEGIN CERTIFICATE-----${EOL}${lines.join(EOL)}${EOL}-----END CERTIFICATE-----`;

    // The last 65 bytes of the SPKI encoding are the uncompressed point: 0x04 || x || y.
    const x509 = new X509Certificate(pem);
    const spki = x509.publicKey.export({ type: 'spki', format: 'der' });
    const consolePublicKey = spki.subarray(-65);

    const ecdh = createECDH('prime256v1');
    ecdh.generateKeys();
    const sharedSecret = ecdh.computeSecret(consolePublicKey);

    const derived = createHash('sha512')
      .update(Buffer.concat([PRE_SALT, sharedSecret, POST_SALT]))
      .digest();
    this.key = derived.subarray(0, 16);
    this.iv = derived.subarray(16, 32);
    this.hashKey = derived.subarray(32, 64);

    // The 0x04 prefix is dropped: the protocol carries the bare 64 byte point.
    return { publicKey: ecdh.getPublicKey().subarray(1), iv: this.iv };
  }

  /** @returns {Buffer} The session AES key. */
  getKey(): Buffer {
    if (!this.key) throw new Error('the session key is not derived yet');
    return this.key;
  }

  /** @returns {Buffer} The session initialization vector. */
  getIv(): Buffer {
    if (!this.iv) throw new Error('the session initialization vector is not derived yet');
    return this.iv;
  }

  /**
   * Encrypts a payload with the session key.
   *
   * Padding is the caller's business: a SmartGlass payload is padded before it is
   * handed over, since the length of the unpadded payload goes into the header.
   *
   * @param {Buffer} data The payload, whose length must be a multiple of 16.
   * @param {Buffer} [key] The key to use, or the session key.
   * @param {Buffer} [iv] The initialization vector to use, or all zeroes.
   * @returns {Buffer} The encrypted payload.
   */
  encrypt(data: Buffer, key?: Buffer, iv?: Buffer): Buffer {
    const cipher = createCipheriv('aes-128-cbc', key ?? this.getKey(), iv ?? ZERO_IV);
    cipher.setAutoPadding(false);
    return Buffer.concat([cipher.update(data), cipher.final()]);
  }

  /**
   * Decrypts a payload with the session key and removes its padding.
   *
   * @param {Buffer} data The encrypted payload.
   * @param {Buffer} [iv] The initialization vector the payload was encrypted with.
   * @param {Buffer} [key] The key to use, or the session key.
   * @returns {Buffer} The payload.
   */
  decrypt(data: Buffer, iv?: Buffer, key?: Buffer): Buffer {
    const decipher = createDecipheriv('aes-128-cbc', key ?? this.getKey(), iv ?? ZERO_IV);
    decipher.setAutoPadding(false);
    return removePadding(Buffer.concat([decipher.update(data), decipher.final()]));
  }

  /**
   * Signs a packet, which every packet with an encrypted payload carries.
   *
   * @param {Buffer} data Everything of the packet up to the signature.
   * @returns {Buffer} The 32 byte signature.
   */
  sign(data: Buffer): Buffer {
    if (!this.hashKey) throw new Error('the session hash key is not derived yet');
    return createHmac('sha256', this.hashKey).update(data).digest();
  }

  /**
   * Computes the initialization vector one message is encrypted with.
   *
   * Every message derives its own vector from its own header, so that two
   * messages with the same payload do not look alike on the wire.
   *
   * @param {Buffer} header The first 16 bytes of the message header.
   * @returns {Buffer} The initialization vector for that message.
   */
  messageIv(header: Buffer): Buffer {
    return this.encrypt(header.subarray(0, 16), this.getIv());
  }
}

/**
 * Removes the padding a decrypted payload ends with.
 *
 * The protocol pads with the number of padding bytes repeated, so the last byte
 * says how much to drop — unless it is not in range, in which case the payload
 * happened to fill its last block and nothing was added.
 *
 * @param {Buffer} payload The decrypted payload.
 * @returns {Buffer} The payload without its padding.
 */
function removePadding(payload: Buffer): Buffer {
  if (payload.length === 0) return payload;
  const padding = payload.readUInt8(payload.length - 1);
  return padding > 0 && padding < 16 ? payload.subarray(0, payload.length - padding) : payload;
}

/**
 * Pads a payload up to the AES block size, the way the protocol expects.
 *
 * @param {Buffer} payload The payload to pad.
 * @returns {Buffer} The padded payload, which is the same one when it already filled its last block.
 */
export function applyPadding(payload: Buffer): Buffer {
  const remainder = payload.length % 16;
  if (remainder === 0) return payload;
  const padding = 16 - remainder;
  return Buffer.concat([payload, Buffer.alloc(padding, padding)]);
}
