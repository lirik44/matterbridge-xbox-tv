import type { PlatformConfig } from 'matterbridge';

import { CONSOLE_CONTROL_COMMANDS, DefaultInputs, GAMEPAD_COMMANDS, MEDIA_COMMANDS, TV_REMOTE_COMMANDS } from './xbox/constants.js';
import type { XboxInput } from './xbox/types.js';
import { isValidLiveId, normalizeLiveId } from './xbox/utils.js';

/**
 * How an on/off endpoint presents itself in the controller app.
 *
 * Matter has no television device type any controller renders — Apple Home,
 * Google Home and Alexa all ignore `BasicVideoPlayer` — so every function of the
 * console becomes an outlet or a light, which every controller does render.
 */
export type SwitchStyle = 'outlet' | 'light' | 'none';

/** How the volume is presented, or `none` to leave it out. */
export type VolumeStyle = 'none' | 'light' | 'fan';

/** How a sensor is presented in the controller app. */
export type SensorStyle = 'none' | 'occupancy' | 'contact';

/**
 * What a sensor watches.
 *
 * The order is the `mode` numbering of the `homebridge-xbox-tv` plugin, so an
 * existing sensor configuration keeps its meaning.
 */
export const SENSOR_MODES = ['input', 'power', 'volume', 'mute', 'screenSaver', 'playState'] as const;

/** One of the things a sensor can watch. */
export type SensorMode = (typeof SENSOR_MODES)[number];

/** What a button does. The numbering is the one of the `homebridge-xbox-tv` plugin. */
export type ButtonMode = 0 | 1 | 2 | 3 | 4;

/** A game or app as written in the configuration. */
export interface InputConfig {
  /** The name shown in the controller app. */
  name: string;
  /** The AUMID, e.g. `Microsoft.SeaofThieves_8wekyb3d8bbwe!Game`. This is what the console reports as the running title. */
  reference?: string;
  /** The product id, which is what a launch command takes. */
  oneStoreProductId?: string;
  /** The numeric title id. */
  titleId?: string;
  /** `Game`, `App`, `System App`, `Dlc` or `Dashboard`, for the filters. */
  contentType?: string;
}

/** A momentary switch that fires one command, as written in the configuration. */
export interface ButtonConfig {
  /** The name shown in the controller app. */
  name: string;
  /** What kind of command the button fires. */
  mode?: ButtonMode;
  /** The media key, for mode `0`. */
  mediaCommand?: string;
  /** The gamepad key, for mode `1`. */
  gamePadCommand?: string;
  /** The TV remote key, for mode `2`. */
  tvRemoteCommand?: string;
  /** `reboot` or `recordGameDvr`, for mode `3`. */
  consoleControlCommand?: string;
  /** The product id of the game or app to launch, for mode `4`. */
  gameAppControlCommand?: string;
  /** How the button is presented, or `none` to leave it out. */
  displayType?: SwitchStyle | number;
  /** Prefix the name with the console name. */
  namePrefix?: boolean;
}

/** A sensor reflecting one part of the console state, as written in the configuration. */
export interface SensorConfig {
  /** The name shown in the controller app. */
  name?: string;
  /** What the sensor watches. Either the name or the `homebridge-xbox-tv` number. */
  mode?: SensorMode | number;
  /** The AUMID the sensor triggers on, for the `input` mode. */
  reference?: string;
  /** The volume the sensor triggers on, for the `volume` mode. */
  level?: number;
  /** How the sensor is presented, or `none` to leave it out. */
  displayType?: SensorStyle | number;
  /** Trigger for half a second on every change rather than while the condition holds. */
  pulse?: boolean;
  /** Prefix the name with the console name. */
  namePrefix?: boolean;
}

/**
 * The sensor section as the older `homebridge-xbox-tv` releases wrote it.
 *
 * Those releases had a fixed set of sensors turned on with a boolean each, rather
 * than a list. Both shapes are accepted so that either vintage of configuration
 * can be pasted in as it is.
 */
export interface LegacySensors {
  /** A sensor that reports while the console is on. */
  power?: boolean | SensorConfig;
  /** A sensor that reports while the screen saver is running. */
  screenSaver?: boolean | SensorConfig;
  /** A sensor that reports for half a second whenever the running game or app changes. */
  input?: boolean | SensorConfig;
  /** One sensor per game or app, each reporting while that one is in the foreground. */
  inputs?: SensorConfig[];
}

/**
 * One console, configured as in the `homebridge-xbox-tv` plugin.
 *
 * Every option of that plugin is accepted, so a Homebridge configuration can be
 * pasted in as it is. The ones that only meant something under HomeKit —
 * `inputs.displayOrder`, `infoButtonCommand` — are read and ignored, and
 * `restFul` and `mqtt` are not implemented, since Matterbridge has its own
 * frontend and API.
 */
export interface DeviceConfig {
  /** The name shown in the controller app. */
  name: string;
  /** The console IP address. Give it a static lease on your router. */
  host: string;
  /** The Xbox Live device id, shown on the console under Settings, System, Console info. */
  xboxLiveId: string;
  /** Set to `false` to skip this console without deleting its configuration. */
  deviceEnabled?: boolean;

  /** The HomeKit accessory category of the Homebridge plugin. Only `0`, which means "do not expose", still has an effect. */
  displayType?: number;

  webApi?: {
    /** Reach the console through Microsoft, which is what everything but power and state needs. */
    enable?: boolean;
    /** The authorization code, or the whole callback address it is part of. Used once, then the token chain takes over. */
    token?: string;
    /** A Microsoft OAuth client of your own, instead of the one built into the plugin. */
    clientId?: string;
    /** The secret of that client, for one registered as confidential. */
    clientSecret?: string;
    /** A `homebridge-xbox-tv` token file to take the authorization over from, e.g. `~/.homebridge/xboxTv/authToken_19216811172`. */
    tokensFile?: string;
    /** How often the console state is read from Microsoft, in seconds. */
    pollInterval?: number;
  };

  inputs?: {
    /** Read the games and apps from the console instead of taking them from `data`. Needs the Web API. */
    getFromDevice?: boolean;
    /** Drop games from the list. */
    filterGames?: boolean;
    /** Drop apps from the list. */
    filterApps?: boolean;
    /** Drop the apps the console uses internally from the list. */
    filterSystemApps?: boolean;
    /** Drop downloadable content from the list. */
    filterDlc?: boolean;
    /** At most this many games and apps are exposed. */
    maxCount?: number;
    /** How the game and app switches are presented. */
    displayType?: SwitchStyle | number;
    /** The games and apps to expose, on top of the ones every console has. */
    data?: InputConfig[];
    /** Only meaningful under HomeKit; accepted and ignored. */
    displayOrder?: number;
  };

  power?: {
    /** How the power switch is presented. */
    displayType?: SwitchStyle | number;
  };

  volume?: {
    /** How the volume is presented, or `none` to leave it out. */
    displayType?: VolumeStyle | number;
    /** The name of the volume device. */
    name?: string;
    /** Prefix the name with the console name. */
    namePrefix?: boolean;
    /** How many percent of the slider one volume step of the console is worth. */
    step?: number;
  };

  /** Momentary switches, each firing one media key, gamepad key, console command or app launch. */
  buttons?: ButtonConfig[];
  /** Sensors reflecting parts of the console state, for automations. */
  sensors?: SensorConfig[] | LegacySensors;

  /** How often the console is looked for while it is unreachable, in seconds. */
  heartBeatInterval?: number;
  /** Enable debug logging for this console. */
  debug?: boolean;

  /** Only meaningful under HomeKit; accepted and ignored. */
  infoButtonCommand?: string;
  /** The per-level log switches of the Homebridge plugin. Only `debug` is used. */
  log?: { deviceInfo?: boolean; success?: boolean; info?: boolean; warn?: boolean; error?: boolean; debug?: boolean };
  /** Not implemented: Matterbridge has its own frontend and API. */
  restFul?: { enable?: boolean; port?: number };
  /** Not implemented: Matterbridge has its own frontend and API. */
  mqtt?: { enable?: boolean };
}

/** The plugin configuration as stored by Matterbridge. */
export interface XboxPlatformConfig extends PlatformConfig {
  /** The consoles to expose. */
  devices?: DeviceConfig[];
  /** Only expose the consoles named here. */
  whiteList?: string[];
  /** Never expose the consoles named here. */
  blackList?: string[];
}

/** A resolved momentary switch. */
export interface ResolvedButton {
  name: string;
  mode: ButtonMode;
  /** The key, command or product id, whichever the mode calls for. */
  command: string;
  style: Exclude<SwitchStyle, 'none'>;
}

/** A resolved sensor. */
export interface ResolvedSensor {
  name: string;
  mode: SensorMode;
  style: Exclude<SensorStyle, 'none'>;
  reference: string;
  level: number;
  pulse: boolean;
}

/** Which kinds of games and apps are left out. */
export interface InputFilters {
  games: boolean;
  apps: boolean;
  systemApps: boolean;
  dlc: boolean;
}

/** A device configuration with every optional field resolved. */
export interface ResolvedDeviceConfig {
  name: string;
  host: string;
  liveId: string;
  deviceEnabled: boolean;
  debug: boolean;

  heartBeatIntervalMs: number;
  pollIntervalMs: number;

  webApiEnabled: boolean;
  webApiToken: string;
  webApiClientId: string;
  webApiClientSecret: string;
  webApiTokensFile: string;

  getInputsFromDevice: boolean;
  filters: InputFilters;
  maxInputCount: number;
  inputStyle: SwitchStyle;
  inputs: XboxInput[];

  powerStyle: SwitchStyle;

  volumeStyle: VolumeStyle;
  volumeName: string;
  volumeStep: number;

  buttons: ResolvedButton[];
  sensors: ResolvedSensor[];
}

/** How often the console is looked for when nothing is configured, in seconds. */
export const DEFAULT_HEARTBEAT_INTERVAL = 6;

/** The shortest heartbeat accepted, in seconds. Below this the console is hammered for nothing. */
const MIN_HEARTBEAT_INTERVAL = 2;

/** How often the console state is read from Microsoft when nothing is configured, in seconds. */
const DEFAULT_POLL_INTERVAL = 300;

/** The shortest poll interval accepted, in seconds. Microsoft throttles a client that asks more often. */
const MIN_POLL_INTERVAL = 30;

/** How many games and apps are exposed by default. */
const DEFAULT_MAX_INPUT_COUNT = 20;

/** How many percent of the volume slider one step of the console is worth, when nothing is configured. */
const DEFAULT_VOLUME_STEP = 5;

/**
 * Applies the defaults to a console configuration and validates the required fields.
 *
 * @param {DeviceConfig} config The configuration as written by the user.
 * @param {XboxPlatformConfig} platformConfig The plugin configuration, for the fallback debug flag.
 * @param {(message: string) => void} warn Called for every correction, so it reaches the log.
 * @returns {ResolvedDeviceConfig} The configuration with every optional field resolved.
 * @throws {Error} When a required field is missing or malformed.
 */
export function resolveDeviceConfig(config: DeviceConfig, platformConfig: XboxPlatformConfig, warn: (message: string) => void): ResolvedDeviceConfig {
  const name = config.name?.trim();
  if (!name) throw new Error('Every console needs a name.');
  const host = config.host?.trim();
  if (!host) throw new Error(`"${name}" needs the IP address of the console.`);

  const liveId = normalizeLiveId(config.xboxLiveId ?? '');
  if (!isValidLiveId(liveId)) {
    throw new Error(`"${name}" needs the Xbox Live device id of the console, as sixteen hexadecimal digits. It is shown on the console under Settings, System, Console info.`);
  }

  if (config.restFul?.enable) warn(`${name}: the RESTFul server is not implemented; use the Matterbridge frontend and API instead.`);
  if (config.mqtt?.enable) warn(`${name}: MQTT is not implemented; use the Matterbridge frontend and API instead.`);
  if (config.inputs?.displayOrder) warn(`${name}: "inputs.displayOrder" only meant something under HomeKit and is ignored; the controller app decides the order.`);
  if (config.infoButtonCommand) warn(`${name}: "infoButtonCommand" was the info key of the HomeKit remote, which Matter has no counterpart for; it is ignored.`);

  const webApiEnabled = config.webApi?.enable ?? false;
  if (!webApiEnabled) {
    warn(
      `${name}: the Web API is turned off, so only power and state work. Launching a game or app, pressing a key and changing the volume all go through Microsoft; ` +
        `turn on "webApi.enable" to get them.`,
    );
  }

  const heartBeatInterval = Math.max(MIN_HEARTBEAT_INTERVAL, config.heartBeatInterval ?? DEFAULT_HEARTBEAT_INTERVAL);
  const pollInterval = Math.max(MIN_POLL_INTERVAL, config.webApi?.pollInterval ?? DEFAULT_POLL_INTERVAL);
  const debug = config.debug ?? config.log?.debug ?? platformConfig.debug === true;

  return {
    name,
    host,
    liveId,
    deviceEnabled: config.deviceEnabled ?? config.displayType !== 0,
    debug,

    heartBeatIntervalMs: heartBeatInterval * 1000,
    pollIntervalMs: pollInterval * 1000,

    webApiEnabled,
    webApiToken: config.webApi?.token?.trim() ?? '',
    webApiClientId: config.webApi?.clientId?.trim() ?? '',
    webApiClientSecret: config.webApi?.clientSecret?.trim() ?? '',
    webApiTokensFile: config.webApi?.tokensFile?.trim() ?? '',

    getInputsFromDevice: webApiEnabled && (config.inputs?.getFromDevice ?? false),
    filters: {
      games: config.inputs?.filterGames ?? false,
      apps: config.inputs?.filterApps ?? false,
      systemApps: config.inputs?.filterSystemApps ?? false,
      dlc: config.inputs?.filterDlc ?? false,
    },
    maxInputCount: Math.max(1, config.inputs?.maxCount ?? DEFAULT_MAX_INPUT_COUNT),
    inputStyle: switchStyle(config.inputs?.displayType, 'outlet'),
    inputs: resolveInputs(config, warn),

    powerStyle: switchStyle(config.power?.displayType, 'outlet'),

    volumeStyle: volumeStyle(config.volume?.displayType),
    volumeName: volumeName(config),
    volumeStep: Math.max(1, Math.min(50, config.volume?.step ?? DEFAULT_VOLUME_STEP)),

    buttons: resolveButtons(config, warn),
    sensors: resolveSensors(config, warn),
  };
}

/**
 * Reads the games and apps out of the configuration.
 *
 * The apps every console has are always in the list, exactly as in the Homebridge
 * plugin, so that there is something to switch to before the console has ever
 * been reached.
 *
 * @param {DeviceConfig} config The configuration as written by the user.
 * @param {(message: string) => void} warn Called for every correction.
 * @returns {XboxInput[]} The games and apps to expose.
 */
function resolveInputs(config: DeviceConfig, warn: (message: string) => void): XboxInput[] {
  const configured: XboxInput[] = [];

  for (const input of config.inputs?.data ?? []) {
    const name = input.name?.trim();
    const reference = input.reference?.trim();
    const productId = input.oneStoreProductId?.trim();

    if (!name || (!reference && !productId)) {
      warn(`${config.name}: a game or app without a name and either a reference or a product id is skipped.`);
      continue;
    }

    configured.push({
      name,
      // The reference is what the console reports as the running title, so an
      // entry with only a product id can be launched but never shows as active.
      reference: reference || (productId as string),
      oneStoreProductId: productId ?? '',
      titleId: input.titleId?.trim() ?? '',
      contentType: input.contentType?.trim() ?? '',
      isGame: normalizeContentType(input.contentType) === 'game',
    });
  }

  const defaults = DefaultInputs.map<XboxInput>((input) => ({ ...input }));
  const references = new Set(defaults.map((input) => input.reference));

  return [...defaults, ...configured.filter((input) => !references.has(input.reference))];
}

/**
 * Reads the momentary switches, dropping the ones that are turned off.
 *
 * @param {DeviceConfig} config The configuration as written by the user.
 * @param {(message: string) => void} warn Called for every correction.
 * @returns {ResolvedButton[]} The buttons to expose.
 */
function resolveButtons(config: DeviceConfig, warn: (message: string) => void): ResolvedButton[] {
  const buttons: ResolvedButton[] = [];

  for (const button of config.buttons ?? []) {
    const style = switchStyle(button.displayType, 'none');
    if (style === 'none') continue;

    const name = button.name?.trim();
    if (!name) {
      warn(`${config.name}: a button without a name is skipped.`);
      continue;
    }

    const mode = buttonMode(button.mode);
    const command = buttonCommand(button, mode)?.trim();
    if (!command) {
      warn(`${config.name}: the button "${name}" has no command for its mode and is skipped.`);
      continue;
    }

    if (!knownCommand(mode, command)) {
      warn(`${config.name}: the button "${name}" fires "${command}", which is not one of the keys the console knows; it is exposed anyway.`);
    }

    buttons.push({ name: prefixed(name, config.name, button.namePrefix), mode, command, style });
  }

  return buttons;
}

/**
 * Reads the sensors, in either of the two shapes the Homebridge plugin has used.
 *
 * @param {DeviceConfig} config The configuration as written by the user.
 * @param {(message: string) => void} warn Called for every correction.
 * @returns {ResolvedSensor[]} The sensors to expose.
 */
function resolveSensors(config: DeviceConfig, warn: (message: string) => void): ResolvedSensor[] {
  if (Array.isArray(config.sensors)) return resolveSensorList(config.name, config.sensors, warn);
  if (config.sensors) return resolveLegacySensors(config.name, config.sensors, warn);
  return [];
}

/**
 * Reads the sensors of a current configuration, which lists them.
 *
 * @param {string} deviceName The console name, for the optional name prefix and the log.
 * @param {SensorConfig[]} sensors The list as written by the user.
 * @param {(message: string) => void} warn Called for every correction.
 * @returns {ResolvedSensor[]} The sensors to expose.
 */
function resolveSensorList(deviceName: string, sensors: SensorConfig[], warn: (message: string) => void): ResolvedSensor[] {
  const resolved: ResolvedSensor[] = [];

  for (const [index, sensor] of sensors.entries()) {
    const style = sensorStyle(sensor.displayType);
    if (style === 'none') continue;

    const mode = sensorMode(sensor.mode);
    if (!mode) {
      warn(`${deviceName}: the sensor "${sensor.name ?? index}" has an unknown mode and is skipped.`);
      continue;
    }

    const reference = sensor.reference?.trim() ?? '';
    const pulse = sensor.pulse ?? false;
    if (mode === 'input' && !reference && !pulse) {
      warn(`${deviceName}: the game and app sensor "${sensor.name ?? index}" has no reference and does not pulse, so it would never report; it is skipped.`);
      continue;
    }

    resolved.push({
      name: prefixed(sensor.name?.trim() || `Sensor ${index + 1}`, deviceName, sensor.namePrefix),
      mode,
      style,
      reference,
      level: sensor.level ?? 0,
      pulse,
    });
  }

  return resolved;
}

/**
 * Reads the sensors of an older configuration, which turned a fixed set on and off.
 *
 * @param {string} deviceName The console name, for the optional name prefix and the log.
 * @param {LegacySensors} sensors The section as written by the user.
 * @param {(message: string) => void} warn Called for every correction.
 * @returns {ResolvedSensor[]} The sensors to expose.
 */
function resolveLegacySensors(deviceName: string, sensors: LegacySensors, warn: (message: string) => void): ResolvedSensor[] {
  const resolved: ResolvedSensor[] = [];

  const add = (setting: boolean | SensorConfig | undefined, mode: SensorMode, label: string, pulse: boolean): void => {
    if (!setting) return;
    const sensor = typeof setting === 'boolean' ? {} : setting;
    const style = typeof setting === 'boolean' ? 'occupancy' : sensorStyle(sensor.displayType ?? 'occupancy');
    if (style === 'none') return;

    resolved.push({
      name: prefixed(sensor.name?.trim() || label, deviceName, sensor.namePrefix),
      mode,
      style,
      reference: sensor.reference?.trim() ?? '',
      level: sensor.level ?? 0,
      pulse: sensor.pulse ?? pulse,
    });
  };

  add(sensors.power, 'power', 'Power', false);
  add(sensors.screenSaver, 'screenSaver', 'Screen Saver', false);
  // The input sensor of those releases fired on every change rather than
  // reporting one particular game, which is what a pulse is.
  add(sensors.input, 'input', 'Input', true);

  for (const [index, sensor] of (sensors.inputs ?? []).entries()) {
    const style = sensorStyle(sensor.displayType);
    if (style === 'none') continue;

    const reference = sensor.reference?.trim();
    if (!reference) {
      warn(`${deviceName}: the game and app sensor ${index + 1} has no reference, so there is nothing for it to watch; it is skipped.`);
      continue;
    }

    resolved.push({
      name: prefixed(sensor.name?.trim() || reference, deviceName, sensor.namePrefix),
      mode: 'input',
      style,
      reference,
      level: 0,
      pulse: sensor.pulse ?? false,
    });
  }

  return resolved;
}

/**
 * @param {ButtonConfig} button The button as written by the user.
 * @param {ButtonMode} mode Its resolved mode.
 * @returns {string | undefined} The command that mode takes.
 */
function buttonCommand(button: ButtonConfig, mode: ButtonMode): string | undefined {
  switch (mode) {
    case 0:
      return button.mediaCommand;
    case 1:
      return button.gamePadCommand;
    case 2:
      return button.tvRemoteCommand;
    case 3:
      return button.consoleControlCommand;
    case 4:
      return button.gameAppControlCommand;
  }
}

/**
 * @param {ButtonMode} mode The mode of a button.
 * @param {string} command The command it fires.
 * @returns {boolean} Whether that command is one of the ones the console is known to take.
 */
function knownCommand(mode: ButtonMode, command: string): boolean {
  switch (mode) {
    case 0:
      return (MEDIA_COMMANDS as readonly string[]).includes(command);
    case 1:
      return (GAMEPAD_COMMANDS as readonly string[]).includes(command);
    case 2:
      return (TV_REMOTE_COMMANDS as readonly string[]).includes(command);
    case 3:
      return (CONSOLE_CONTROL_COMMANDS as readonly string[]).includes(command);
    case 4:
      // A product id is whatever the store says it is.
      return true;
  }
}

/**
 * @param {number | undefined} value The mode as written by the user.
 * @returns {ButtonMode} The mode, falling back to a media key.
 */
function buttonMode(value: number | undefined): ButtonMode {
  return value === 1 || value === 2 || value === 3 || value === 4 ? value : 0;
}

/**
 * @param {string} name The name as configured.
 * @param {string} deviceName The console name.
 * @param {boolean | undefined} prefix Whether to prefix the name with the console name.
 * @returns {string} The name to show in the controller app.
 */
function prefixed(name: string, deviceName: string, prefix: boolean | undefined): string {
  return prefix ? `${deviceName} ${name}` : name;
}

/**
 * Reads a switch style, accepting both the names and the `homebridge-xbox-tv` numbers.
 *
 * That plugin used `0` for "not exposed", `1` for an outlet and `2` for a switch;
 * Matter has no switch that every controller renders, so `2` becomes an outlet too.
 *
 * @param {SwitchStyle | number | undefined} value The value as written by the user.
 * @param {SwitchStyle} fallback What to use when nothing was written.
 * @returns {SwitchStyle} The resolved style.
 */
function switchStyle(value: SwitchStyle | number | undefined, fallback: SwitchStyle): SwitchStyle {
  if (value === undefined) return fallback;
  if (typeof value === 'number') return value === 0 ? 'none' : 'outlet';
  return value === 'light' || value === 'none' ? value : 'outlet';
}

/**
 * Reads a volume style, accepting both the names and the `homebridge-xbox-tv` numbers.
 *
 * That plugin used `0` for "not exposed", `1` for a lightbulb, `2` for a fan and
 * `3` to `5` for the HomeKit speaker services, which Matter has no counterpart
 * for; those become a lightbulb, which is what the same plugin falls back to.
 *
 * @param {VolumeStyle | number | undefined} value The value as written by the user.
 * @returns {VolumeStyle} The resolved style.
 */
function volumeStyle(value: VolumeStyle | number | undefined): VolumeStyle {
  if (value === undefined) return 'none';
  if (typeof value === 'number') return value === 0 ? 'none' : value === 2 || value === 5 ? 'fan' : 'light';
  return value === 'none' || value === 'fan' ? value : 'light';
}

/**
 * @param {DeviceConfig} config The configuration as written by the user.
 * @returns {string} The name of the volume device.
 */
function volumeName(config: DeviceConfig): string {
  const name = config.volume?.name?.trim() || 'Volume';
  return prefixed(name, config.name, config.volume?.namePrefix);
}

/**
 * Reads a sensor style, accepting both the names and the `homebridge-xbox-tv` numbers.
 *
 * That plugin used `1` for a motion sensor, `2` for an occupancy sensor and `3`
 * for a contact sensor. Matter has no motion sensor of its own — occupancy is
 * what a controller shows for movement — so `1` and `2` both become occupancy.
 *
 * @param {SensorStyle | number | undefined} value The value as written by the user.
 * @returns {SensorStyle} The resolved style.
 */
function sensorStyle(value: SensorStyle | number | undefined): SensorStyle {
  if (value === undefined) return 'none';
  if (typeof value === 'number') return value === 0 ? 'none' : value === 3 ? 'contact' : 'occupancy';
  return value === 'contact' || value === 'none' ? value : 'occupancy';
}

/**
 * Reads a sensor mode, accepting both the names and the `homebridge-xbox-tv` numbers.
 *
 * @param {SensorMode | number | undefined} value The value as written by the user.
 * @returns {SensorMode | undefined} The resolved mode, or `undefined` when it is not one of the known ones.
 */
function sensorMode(value: SensorMode | number | undefined): SensorMode | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'number') return SENSOR_MODES[value];
  return SENSOR_MODES.includes(value) ? value : undefined;
}

/**
 * Reduces a content type to something the filters can compare.
 *
 * The console says `systemApp` while the Homebridge configuration form offers
 * `System App`, so both spellings have to mean the same thing.
 *
 * @param {string | undefined} value The content type as it arrived.
 * @returns {string} The same, in lower case and without spaces.
 */
export function normalizeContentType(value: string | undefined): string {
  return (value ?? '').toLowerCase().replace(/\s+/g, '');
}

/**
 * @param {XboxInput} input The game or app to check.
 * @param {InputFilters} filters Which kinds are left out.
 * @returns {boolean} Whether this one is filtered out.
 */
export function isFiltered(input: XboxInput, filters: InputFilters): boolean {
  const type = normalizeContentType(input.contentType);
  if (filters.games && (type === 'game' || input.isGame)) return true;
  if (filters.apps && type === 'app') return true;
  if (filters.systemApps && type === 'systemapp') return true;
  if (filters.dlc && type === 'dlc') return true;
  return false;
}
