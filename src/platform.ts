import { MatterbridgeDynamicPlatform, type PlatformMatterbridge } from 'matterbridge';
import { AnsiLogger, LogLevel, TimestampFormat, type AnsiLogger as Logger } from 'matterbridge/logger';

import { resolveDeviceConfig, type DeviceConfig, type XboxPlatformConfig } from './config.js';
import { XboxConsoleAccessory } from './devices/console.js';
import type { TokenStorage } from './xbox/authentication.js';
import { errorMessage } from './xbox/utils.js';

/**
 * The Matterbridge platform exposing Xbox consoles over Matter.
 *
 * Every configured console is watched over the local SmartGlass protocol and
 * controlled through Xbox Live, and exposed as a set of bridged Matter devices —
 * one for the power, one per game or app, one for the volume, and one for each
 * button and sensor that is turned on.
 */
export class XboxPlatform extends MatterbridgeDynamicPlatform {
  private readonly accessories = new Set<XboxConsoleAccessory>();

  constructor(
    matterbridge: PlatformMatterbridge,
    log: Logger,
    override config: XboxPlatformConfig,
  ) {
    super(matterbridge, log, config);

    if (typeof this.verifyMatterbridgeVersion !== 'function' || !this.verifyMatterbridgeVersion('3.3.0')) {
      throw new Error(`This plugin requires Matterbridge version >= "3.3.0". Please update Matterbridge from ${this.matterbridge.matterbridgeVersion} to the latest version.`);
    }

    log.logLevel = this.config.debug === true ? LogLevel.DEBUG : log.logLevel;
    this.log.info('Initializing platform...');
  }

  override async onStart(reason?: string): Promise<void> {
    this.log.info(`onStart called with reason: ${reason ?? 'none'}`);

    await this.ready;
    await this.clearSelect();

    const devices = this.config.devices ?? [];
    if (devices.length === 0) {
      this.log.warn('No consoles configured. Add your Xbox consoles in the plugin configuration.');
      return;
    }

    // The consoles are set up in parallel: one that is switched off must not hold up the others.
    await Promise.all(devices.map((device) => this.startDevice(device)));
  }

  override async onChangeLoggerLevel(logLevel: LogLevel): Promise<void> {
    this.log.debug(`onChangeLoggerLevel called with: ${logLevel}`);
  }

  override async onShutdown(reason?: string): Promise<void> {
    await super.onShutdown(reason);
    this.log.info(`onShutdown called with reason: ${reason ?? 'none'}`);

    for (const accessory of this.accessories) accessory.stop();
    this.accessories.clear();

    if (this.config.unregisterOnShutdown === true) await this.unregisterAllDevices();
  }

  /**
   * Sets up one configured console: resolves its configuration, builds its
   * endpoints, registers them and starts contacting the console.
   *
   * A failure is logged and leaves the other consoles alone.
   *
   * @param {DeviceConfig} device The console configuration as written by the user.
   * @returns {Promise<void>} Resolves once the console has been registered, or the failure logged.
   */
  private async startDevice(device: DeviceConfig): Promise<void> {
    let name = device.name?.trim() || device.host?.trim() || 'unnamed console';

    try {
      const config = resolveDeviceConfig(device, this.config, (message) => this.log.warn(message));
      name = config.name;

      if (!config.deviceEnabled) {
        this.log.info(`${name} | disabled in the configuration, skipping`);
        return;
      }

      this.setSelectDevice(config.liveId, name, config.host, 'hub');

      if (!this.validateDevice(name)) {
        this.log.info(`${name} | filtered out by the white/black list, skipping`);
        return;
      }

      const log = new AnsiLogger({
        logName: name,
        logLevel: config.debug ? LogLevel.DEBUG : this.log.logLevel,
        logTimestampFormat: TimestampFormat.TIME_MILLIS,
      });

      const accessory = new XboxConsoleAccessory({
        config,
        log,
        storage: this.storageFor(name),
        registerEndpoint: async (endpoint) => {
          await this.registerDevice(endpoint);
        },
      });

      const endpoints = await accessory.initialize();
      if (endpoints.length === 0) {
        this.log.warn(`${name} | has nothing to expose; check the configuration`);
        return;
      }

      this.accessories.add(accessory);
      for (const endpoint of endpoints) await this.registerDevice(endpoint);
      await accessory.postRegister();

      this.log.info(`${name} | exposed ${endpoints.length} Matter device${endpoints.length === 1 ? '' : 's'} for ${config.host}`);
    } catch (error) {
      this.log.error(`${name} | could not be set up: ${errorMessage(error)}`);
    }
  }

  /**
   * Builds the storage the Xbox Live tokens, the device information and the game
   * list of one console live in.
   *
   * The token chain must survive a restart — the authorization code it started
   * from can only be used once — so it goes into the Matterbridge storage of this
   * plugin rather than into a file of its own.
   *
   * @param {string} name The console name, for the log.
   * @returns {TokenStorage} The storage handed to the accessory.
   */
  private storageFor(name: string): TokenStorage {
    return {
      read: async <T>(key: string): Promise<T | undefined> => await this.context?.get<T | undefined>(key, undefined),
      write: async <T>(key: string, value: T): Promise<void> => {
        if (!this.context) {
          this.log.warn(`${name} | the plugin storage is not available, so ${key} cannot be remembered`);
          return;
        }
        await this.context.set(key, value);
      },
    };
  }
}
