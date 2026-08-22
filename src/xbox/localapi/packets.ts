import { LOCAL_MEDIA_TYPES, LOCAL_PLAYBACK_STATES, LOCAL_SOUND_LEVELS } from '../constants.js';

import { Structure } from './structure.js';

/** How one field of a packet goes onto the wire and comes back off it. */
export interface Codec<T> {
  pack(structure: Structure, value: T): void;
  unpack(structure: Structure): T;
}

/** One field of a packet: its name, how it is encoded, and what it is when nothing is given. */
export interface Field {
  name: string;
  codec: Codec<never>;
  value: unknown;
}

/** The ordered fields of one packet. The order is the wire order. */
export type PacketDef = readonly Field[];

/**
 * Declares one field of a packet.
 *
 * @template T The type of the field.
 * @param {string} name The field name, which is also the key in the decoded object.
 * @param {Codec<T>} codec How the field is encoded.
 * @param {T} value What the field is when the caller gives nothing.
 * @returns {Field} The declared field.
 */
function field<T>(name: string, codec: Codec<T>, value: T): Field {
  return { name, codec: codec as Codec<never>, value };
}

/** A 16 bit number. */
const uInt16: Codec<number> = {
  pack: (structure, value) => void structure.writeUInt16(value),
  unpack: (structure) => structure.readUInt16(),
};

/** A 32 bit number. */
const uInt32: Codec<number> = {
  pack: (structure, value) => void structure.writeUInt32(value),
  unpack: (structure) => structure.readUInt32(),
};

/** A signed 32 bit number, used by the game DVR time offsets. */
const sInt32: Codec<number> = {
  pack: (structure, value) => void structure.writeInt32(value),
  unpack: (structure) => structure.readInt32(),
};

/** A length prefixed, null terminated string. */
const sgString: Codec<string> = {
  pack: (structure, value) => void structure.writeSGString(value),
  unpack: (structure) => structure.readSGString(),
};

/**
 * A field of a fixed number of raw bytes.
 *
 * @param {number} length How many bytes the field is.
 * @returns {Codec<Buffer>} The codec.
 */
function bytes(length: number): Codec<Buffer> {
  return {
    pack: (structure, value) => void structure.writeBytes(value.length === length ? value : Buffer.concat([value, Buffer.alloc(length)]).subarray(0, length)),
    unpack: (structure) => structure.readBytes(length),
  };
}

/** Everything that is left of the packet, which is how the protocol carries certificates and encrypted payloads. */
const restBytes: Codec<Buffer> = {
  pack: (structure, value) => void structure.writeBytes(value),
  unpack: (structure) => structure.readBytes(),
};

/**
 * A 16 bit number the console uses as an index into a table of names.
 *
 * @param {Record<number, string>} table The names, by number.
 * @returns {Codec<string>} The codec, which reads the name and writes nothing meaningful — these fields only ever arrive.
 */
function mapped(table: Record<number, string>): Codec<string> {
  return {
    pack: (structure) => void structure.writeUInt16(0),
    unpack: (structure) => {
      const key = structure.readUInt16();
      return table[key] ?? String(key);
    },
  };
}

/**
 * A list of records, counted by a 16 bit number.
 *
 * @param {PacketDef} def The fields of one record.
 * @returns {Codec<Record<string, unknown>[]>} The codec.
 */
function sgArray(def: PacketDef): Codec<Record<string, unknown>[]> {
  return {
    pack: (structure, value) => {
      structure.writeUInt16(value.length);
      for (const item of value) packInto(structure, def, item);
    },
    unpack: (structure) => {
      const count = structure.readUInt16();
      return Array.from({ length: count }, () => unpackFrom(structure, def));
    },
  };
}

/**
 * A list of records, counted by a 32 bit number.
 *
 * @param {PacketDef} def The fields of one record.
 * @returns {Codec<Record<string, unknown>[]>} The codec.
 */
function sgList(def: PacketDef): Codec<Record<string, unknown>[]> {
  return {
    pack: (structure, value) => {
      structure.writeUInt32(value.length);
      for (const item of value) packInto(structure, def, item);
    },
    unpack: (structure) => {
      const count = structure.readUInt32();
      return Array.from({ length: count }, () => unpackFrom(structure, def));
    },
  };
}

/**
 * Writes one packet into a structure, taking the fields the caller gave and the declared defaults for the rest.
 *
 * @param {Structure} structure Where to write.
 * @param {PacketDef} def The fields of the packet.
 * @param {Record<string, unknown>} [values] The fields the caller wants to set.
 */
export function packInto(structure: Structure, def: PacketDef, values: Record<string, unknown> = {}): void {
  for (const entry of def) {
    const value = (values[entry.name] ?? entry.value) as never;
    entry.codec.pack(structure, value);
  }
}

/**
 * Reads one packet out of a structure.
 *
 * @param {Structure} structure Where to read from.
 * @param {PacketDef} def The fields of the packet.
 * @returns {Record<string, unknown>} The fields, by name.
 */
export function unpackFrom(structure: Structure, def: PacketDef): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const entry of def) result[entry.name] = entry.codec.unpack(structure);
  return result;
}

/**
 * Packs one packet on its own.
 *
 * @param {PacketDef} def The fields of the packet.
 * @param {Record<string, unknown>} [values] The fields the caller wants to set.
 * @returns {Buffer} The packed payload, without any header.
 */
export function packPayload(def: PacketDef, values: Record<string, unknown> = {}): Buffer {
  const structure = new Structure();
  packInto(structure, def, values);
  return structure.toBuffer();
}

/** One entry of an acknowledgement list. */
const processedListDef: PacketDef = [field('id', uInt32, 0)];

/** One title the console reports as running. */
const activeTitleDef: PacketDef = [
  field('flags', bytes(2), Buffer.alloc(2)),
  field('titleId', uInt32, 0),
  field('productId', bytes(16), Buffer.alloc(16)),
  field('sandboxId', bytes(16), Buffer.alloc(16)),
  field('aumId', sgString, ''),
];

/** One entry of the metadata a media channel reports. */
const mediaStateListDef: PacketDef = [field('name', sgString, ''), field('value', sgString, '')];

/**
 * Every packet the plugin sends or reads.
 *
 * The names are the ones `homebridge-xbox-tv` uses, which are in turn the names
 * of the SmartGlass protocol, so that the two can be read side by side.
 */
export const Packets = {
  /** The wake packet, which needs no session: the console listens for it in standby. */
  powerOn: [field('liveId', sgString, '')] as PacketDef,

  /** A JSON message, which is how the console sends anything that has no packet of its own. */
  json: [field('json', sgString, '{}')] as PacketDef,

  /** The broadcast that asks every console on the network to announce itself. */
  discoveryRequest: [field('flags', uInt32, 0), field('clientType', uInt16, 3), field('minVersion', uInt16, 0), field('maxVersion', uInt16, 2)] as PacketDef,

  /** The announcement, which carries the certificate the session key is derived from. */
  discoveryResponse: [
    field('flags', uInt32, 0),
    field('clientType', uInt16, 0),
    field('consoleName', sgString, ''),
    field('uuid', sgString, ''),
    field('lastError', uInt32, 0),
    field('certificateLength', uInt16, 0),
    field('certificate', restBytes, Buffer.alloc(0)),
  ] as PacketDef,

  /** The request that opens a session, carrying our half of the key exchange. */
  connectRequest: [
    field('uuid', bytes(16), Buffer.alloc(16)),
    field('publicKeyType', uInt16, 0),
    field('publicKey', bytes(64), Buffer.alloc(64)),
    field('iv', bytes(16), Buffer.alloc(16)),
    field('payloadProtected', restBytes, Buffer.alloc(0)),
  ] as PacketDef,

  /** The encrypted half of the connect request, which carries the Xbox Live token when there is one. */
  connectRequestProtected: [
    field('userHash', sgString, ''),
    field('token', sgString, ''),
    field('connectRequestNum', uInt32, 0),
    field('connectRequestGroupStart', uInt32, 0),
    field('connectRequestGroupEnd', uInt32, 1),
  ] as PacketDef,

  /** The answer to a connect request. */
  connectResponse: [field('iv', bytes(16), Buffer.alloc(16)), field('payloadProtected', restBytes, Buffer.alloc(0))] as PacketDef,

  /** The encrypted half of the connect response, which says whether the session was accepted. */
  connectResponseProtected: [field('connectResult', uInt16, 1), field('pairingState', uInt16, 2), field('participantId', uInt32, 0)] as PacketDef,

  /** The message that turns an accepted session into a participant the console reports state to. */
  localJoin: [
    field('clientType', uInt16, 3),
    field('nativeWidth', uInt16, 1080),
    field('nativeHeight', uInt16, 1920),
    field('dpiX', uInt16, 96),
    field('dpiY', uInt16, 96),
    field('deviceCapabilities', bytes(8), Buffer.from('ffffffffffffffff', 'hex')),
    field('clientVersion', uInt32, 15),
    field('osMajorVersion', uInt32, 6),
    field('osMinorVersion', uInt32, 2),
    field('displayName', sgString, 'Matterbridge'),
  ] as PacketDef,

  /** The heartbeat: every message the console marks as needing one is answered with this. */
  acknowledge: [field('lowWatermark', uInt32, 0), field('processedList', sgList(processedListDef), []), field('rejectedList', sgList(processedListDef), [])] as PacketDef,

  /** What the console sends whenever its state changes, and every few seconds regardless. */
  consoleStatus: [
    field('liveTvProvider', uInt32, 0),
    field('majorVersion', uInt32, 0),
    field('minorVersion', uInt32, 0),
    field('buildNumber', uInt32, 0),
    field('locale', sgString, 'en-US'),
    field('activeTitles', sgArray(activeTitleDef), []),
  ] as PacketDef,

  /** The clip request: the console records the last minute of play. */
  recordGameDvr: [field('startTimeDelta', sInt32, 0), field('endTimeDelta', sInt32, 0)] as PacketDef,

  /** The shutdown request. */
  powerOff: [field('liveId', sgString, '')] as PacketDef,

  /** The polite way to end a session. */
  disconnect: [field('reason', uInt32, 1), field('errorCode', uInt32, 0)] as PacketDef,

  /** What a media channel reports, when one has been started. */
  mediaState: [
    field('titleId', uInt32, 0),
    field('aumId', sgString, ''),
    field('assetId', sgString, ''),
    field('mediaType', mapped(LOCAL_MEDIA_TYPES), ''),
    field('soundLevel', mapped(LOCAL_SOUND_LEVELS), ''),
    field('enabledCommands', uInt32, 0),
    field('playbackStatus', mapped(LOCAL_PLAYBACK_STATES), ''),
    field('rate', uInt32, 0),
    field('position', bytes(8), Buffer.alloc(8)),
    field('mediaStart', bytes(8), Buffer.alloc(8)),
    field('mediaEnd', bytes(8), Buffer.alloc(8)),
    field('minSeek', bytes(8), Buffer.alloc(8)),
    field('maxSeek', bytes(8), Buffer.alloc(8)),
    field('metadata', sgArray(mediaStateListDef), []),
  ] as PacketDef,
} as const;

/** The name of one of the packets the plugin knows. */
export type PacketName = keyof typeof Packets;

/**
 * @param {string} name The packet name to look up.
 * @returns {PacketDef | undefined} Its fields, or `undefined` when the plugin has no definition for it.
 */
export function packetDef(name: string): PacketDef | undefined {
  return (Packets as Record<string, PacketDef | undefined>)[name];
}
