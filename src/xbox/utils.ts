import { createHash } from 'node:crypto';

/** The Matter level control range, which the console's `0..100` volume scale is mapped onto. */
export const MATTER_LEVEL_RANGE: [number, number] = [1, 254];

/**
 * @param {number} ms How long to wait, in milliseconds.
 * @returns {Promise<void>} A promise resolving after the given delay.
 */
export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms).unref();
  });
}

/**
 * @param {unknown} error The thrown value.
 * @returns {string} A message fit for the log.
 */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * @param {number} value The value to clamp.
 * @param {number} min The lower bound.
 * @param {number} max The upper bound.
 * @returns {number} The value, brought inside the bounds.
 */
export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * Converts a `0..100` console scale into a Matter level.
 *
 * @param {number} value The console value, `0..100`.
 * @returns {number} The Matter level, `1..254`.
 */
export function percentToLevel(value: number): number {
  const [min, max] = MATTER_LEVEL_RANGE;
  return Math.round(clamp(min + (clamp(value, 0, 100) / 100) * (max - min), min, max));
}

/**
 * Converts a Matter level into a `0..100` console scale, the inverse of {@link percentToLevel}.
 *
 * @param {number} level The Matter level, `1..254`.
 * @returns {number} The console value, `0..100`.
 */
export function levelToPercent(level: number): number {
  const [min, max] = MATTER_LEVEL_RANGE;
  return Math.round((clamp(level, min, max) - min) * (100 / (max - min)));
}

/** An Xbox Live device id is sixteen hexadecimal digits. */
const LIVE_ID_PATTERN = /^[0-9A-F]{16}$/;

/**
 * Normalizes an Xbox Live device id into the form the console and the Web API use.
 *
 * @param {string} liveId The id as configured.
 * @returns {string} The id in upper case, without separators.
 */
export function normalizeLiveId(liveId: string): string {
  return liveId
    .trim()
    .replace(/[\s:-]/g, '')
    .toUpperCase();
}

/**
 * @param {string} liveId The id to check, already normalized.
 * @returns {boolean} Whether it is a well formed Xbox Live device id.
 */
export function isValidLiveId(liveId: string): boolean {
  return LIVE_ID_PATTERN.test(liveId);
}

/**
 * Turns a reference or a command into something a Matter serial number can carry.
 *
 * It has to be short — a serial number is at most 32 characters and the device id
 * takes half of that — and it has to be unique, which a shortened AUMID is not:
 * `Microsoft.Xbox.Settings_8wekyb3d8bbwe!Xbox.Settings.Application` and the one
 * for the TV settings differ only near the front. So it is a hash, which is short,
 * unique enough, and the same after a restart.
 *
 * @param {string} value The AUMID, product id or key name.
 * @returns {string} Eight hexadecimal digits standing for that value.
 */
export function referenceSuffix(value: string): string {
  return createHash('sha1').update(value).digest('hex').slice(0, 8);
}
