/**
 * A cursor over a SmartGlass packet.
 *
 * Every field of the protocol is big endian, and strings carry their length in
 * front and a null byte behind. A structure is both the builder used to write a
 * packet and the reader used to take one apart, which is why the same class does
 * both: the field definitions in `packets.ts` are then a single list per packet
 * rather than one for each direction.
 */
export class Structure {
  private buffer: Buffer;
  private cursor = 0;

  constructor(packet?: Buffer) {
    this.buffer = packet ?? Buffer.alloc(0);
  }

  /** @returns {Buffer} Everything written so far. */
  toBuffer(): Buffer {
    return this.buffer;
  }

  /** @returns {number} How many bytes have been written or read past. */
  get length(): number {
    return this.buffer.length;
  }

  /** @returns {number} How many bytes are left to read. */
  get remaining(): number {
    return this.buffer.length - this.cursor;
  }

  /**
   * Appends raw bytes.
   *
   * @param {Buffer} data The bytes to append.
   * @returns {this} This structure, for chaining.
   */
  writeBytes(data: Buffer): this {
    this.buffer = Buffer.concat([this.buffer, data]);
    return this;
  }

  /**
   * @param {number} [length] How many bytes to read, or everything that is left.
   * @returns {Buffer} The bytes read.
   */
  readBytes(length?: number): Buffer {
    const end = length === undefined ? this.buffer.length : this.cursor + length;
    const data = this.buffer.subarray(this.cursor, end);
    this.cursor = end;
    return data;
  }

  /**
   * Appends a string as the protocol carries it: length, bytes, null terminator.
   *
   * @param {string} value The string to append.
   * @returns {this} This structure, for chaining.
   */
  writeSGString(value: string): this {
    const bytes = Buffer.from(value, 'utf8');
    if (bytes.length > 0xffff) throw new Error('a SmartGlass string cannot be longer than 65535 bytes');

    const header = Buffer.alloc(2);
    header.writeUInt16BE(bytes.length, 0);
    return this.writeBytes(Buffer.concat([header, bytes, Buffer.from([0])]));
  }

  /** @returns {string} The next length prefixed string, without its null terminator. */
  readSGString(): string {
    const length = this.readUInt16();
    const value = this.buffer.subarray(this.cursor, this.cursor + length).toString('utf8');
    this.cursor += length + 1;
    return value;
  }

  /**
   * @param {number} value The byte to append.
   * @returns {this} This structure, for chaining.
   */
  writeUInt8(value: number): this {
    const buffer = Buffer.alloc(1);
    buffer.writeUInt8(value, 0);
    return this.writeBytes(buffer);
  }

  /** @returns {number} The next byte. */
  readUInt8(): number {
    const value = this.buffer.readUInt8(this.cursor);
    this.cursor += 1;
    return value;
  }

  /**
   * @param {number} value The 16 bit number to append.
   * @returns {this} This structure, for chaining.
   */
  writeUInt16(value: number): this {
    const buffer = Buffer.alloc(2);
    buffer.writeUInt16BE(value, 0);
    return this.writeBytes(buffer);
  }

  /** @returns {number} The next 16 bit number. */
  readUInt16(): number {
    const value = this.buffer.readUInt16BE(this.cursor);
    this.cursor += 2;
    return value;
  }

  /**
   * @param {number} value The 32 bit number to append.
   * @returns {this} This structure, for chaining.
   */
  writeUInt32(value: number): this {
    const buffer = Buffer.alloc(4);
    buffer.writeUInt32BE(value, 0);
    return this.writeBytes(buffer);
  }

  /** @returns {number} The next 32 bit number. */
  readUInt32(): number {
    const value = this.buffer.readUInt32BE(this.cursor);
    this.cursor += 4;
    return value;
  }

  /**
   * @param {number} value The signed 32 bit number to append.
   * @returns {this} This structure, for chaining.
   */
  writeInt32(value: number): this {
    const buffer = Buffer.alloc(4);
    buffer.writeInt32BE(value, 0);
    return this.writeBytes(buffer);
  }

  /** @returns {number} The next signed 32 bit number. */
  readInt32(): number {
    const value = this.buffer.readInt32BE(this.cursor);
    this.cursor += 4;
    return value;
  }
}
