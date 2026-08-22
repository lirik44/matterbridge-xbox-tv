import type { PlatformMatterbridge } from 'matterbridge';
import type { AnsiLogger } from 'matterbridge/logger';

import type { XboxPlatformConfig } from './config.js';
import { XboxPlatform } from './platform.js';

/**
 * The entry point every Matterbridge plugin exports.
 *
 * @param {PlatformMatterbridge} matterbridge The Matterbridge instance.
 * @param {AnsiLogger} log The logger of this plugin.
 * @param {XboxPlatformConfig} config The plugin configuration.
 * @returns {XboxPlatform} The platform instance driving the plugin.
 */
export default function initializePlugin(matterbridge: PlatformMatterbridge, log: AnsiLogger, config: XboxPlatformConfig): XboxPlatform {
  return new XboxPlatform(matterbridge, log, config);
}

export { XboxPlatform } from './platform.js';
export type { DeviceConfig, XboxPlatformConfig } from './config.js';
