import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';

import type { MatterbridgeEndpoint } from 'matterbridge';
import type { AnsiLogger } from 'matterbridge/logger';
import { BooleanState, BridgedDeviceBasicInformation, FanControl, LevelControl, OccupancySensing, OnOff } from 'matterbridge/matter/clusters';

import { isFiltered, type ResolvedButton, type ResolvedDeviceConfig, type ResolvedSensor, type SensorMode } from '../config.js';
import { XboxAuthentication, type TokenStorage, type XboxTokens } from '../xbox/authentication.js';
import { SCREEN_SAVER_REFERENCE, SHELL_HOME_PRODUCT_IDS } from '../xbox/constants.js';
import { XboxLocalApi, type LocalState } from '../xbox/localapi/client.js';
import { initialConsoleInfo, initialConsoleState, type ConsoleInfo, type ConsoleState, type XboxInput } from '../xbox/types.js';
import { clamp, delay, errorMessage, levelToPercent, percentToLevel, referenceSuffix } from '../xbox/utils.js';
import { XboxWebApi, type WebConsoleStatus } from '../xbox/webapi.js';

import { createDimmerEndpoint, createFanEndpoint, createSensorEndpoint, createSwitchEndpoint, type EndpointIdentity } from './endpoints.js';

/** How long a momentary switch stays on before it resets itself, in milliseconds. */
const MOMENTARY_RESET_MS = 1000;

/** How long a pulsing sensor reports, in milliseconds. */
const SENSOR_PULSE_MS = 500;

/** How long to wait between checks while the console boots, in milliseconds. */
const POWER_ON_POLL_MS = 1500;

/** How many of those checks are made before giving up on a deferred launch. */
const POWER_ON_ATTEMPTS = 20;

/** How many volume steps a single slider move may turn into, so a slip cannot fire a hundred commands. */
const MAX_VOLUME_STEPS = 20;

/** How long to wait between volume steps, in milliseconds. The console drops commands sent faster than this. */
const VOLUME_STEP_DELAY_MS = 150;

/** The media keys that have a command of their own rather than being injected as a key press. */
const MEDIA_CHANNEL_COMMANDS: Record<string, string> = {
  play: 'Play',
  pause: 'Pause',
  nextTrack: 'Next',
  prevTrack: 'Previous',
};

/** What the accessory needs from the platform. */
export interface AccessoryContext {
  config: ResolvedDeviceConfig;
  log: AnsiLogger;
  storage: TokenStorage;
  /**
   * Registers an endpoint built after start-up, which is how the games read from
   * the console appear without a restart.
   *
   * @param {MatterbridgeEndpoint} endpoint The endpoint to register.
   */
  registerEndpoint: (endpoint: MatterbridgeEndpoint) => Promise<void>;
}

/** One on/off endpoint bound to a part of the console. */
interface BoundSwitch {
  endpoint: MatterbridgeEndpoint;
  /** Derives the state the switch should show, or `undefined` for a momentary switch. */
  reads?: (state: ConsoleState) => boolean;
  /** Runs when the switch is turned on. */
  turnOn: () => Promise<void>;
  /** Runs when the switch is turned off, or `undefined` when it cannot be turned off. */
  turnOff?: () => Promise<void>;
  /** Whether the switch resets itself after being triggered. */
  momentary: boolean;
}

/** One dimmer endpoint bound to the volume. */
interface BoundDimmer {
  endpoint: MatterbridgeEndpoint;
  /** Whether the endpoint carries a fan control cluster rather than a level control one. */
  fan: boolean;
  /** Derives what the dimmer should show. */
  reads: (state: ConsoleState) => { on: boolean; percent: number };
  /** Runs when the slider is moved. */
  writeLevel: (percent: number) => Promise<void>;
  /** Runs when the dimmer is switched on or off. */
  writeOn: (on: boolean) => Promise<void>;
}

/** One sensor endpoint bound to a part of the console state. */
interface BoundSensor {
  endpoint: MatterbridgeEndpoint;
  config: ResolvedSensor;
}

/**
 * One Xbox console, exposed as a set of bridged Matter devices.
 *
 * Matter does define a television — `BasicVideoPlayer`, with media playback and
 * keypad input — but no controller renders it: Apple Home, Google Home and Alexa
 * all ignore the type. So the console is taken apart instead: the power becomes an
 * outlet, every game and app becomes an outlet of its own that turns the others
 * off, the volume becomes a dimmer, and each configured key becomes a momentary
 * outlet. That is the same shape the `homebridge-xbox-tv` plugin falls back to for
 * the parts HomeKit's television service could not hold.
 *
 * The console is reached two ways at once, which is not a choice but what
 * Microsoft left behind. The local SmartGlass protocol says what is running and
 * can wake and shut down the console, but can no longer launch a title or press a
 * key; the Xbox Live service can do all of that but only says what is running
 * when asked, and asking often gets the plugin throttled. So state comes from the
 * local protocol and commands go through the cloud.
 */
export class XboxConsoleAccessory {
  /** The endpoints of this console, in registration order. */
  readonly endpoints: MatterbridgeEndpoint[] = [];

  private readonly config: ResolvedDeviceConfig;
  private readonly log: AnsiLogger;
  private readonly storage: TokenStorage;
  private readonly registerEndpoint: (endpoint: MatterbridgeEndpoint) => Promise<void>;

  private readonly local: XboxLocalApi;
  private readonly auth?: XboxAuthentication;
  private readonly web?: XboxWebApi;

  private info: ConsoleInfo;
  /** Whether {@link info} came from the console or from the cache, rather than being the fallback. */
  private infoKnown = false;
  private state: ConsoleState = initialConsoleState();
  private previousState: ConsoleState = initialConsoleState();

  /** Whether a local session is open, which is what makes the local state authoritative. */
  private localConnected = false;
  /** What the Web API last said the power state was, for when no local session is open. */
  private webPower = false;

  private readonly switches: BoundSwitch[] = [];
  private readonly dimmers: BoundDimmer[] = [];
  private readonly sensors: BoundSensor[] = [];
  /** The game and app switches, by reference, so that the ones read from the console can be added later. */
  private readonly inputSwitches = new Map<string, BoundSwitch>();

  /** Set while a state pass is running, so that passes cannot overlap. */
  private applying = false;
  /** Set when state changed during a pass, so that one more pass follows. */
  private applyAgain = false;

  private heartbeat?: NodeJS.Timeout;
  private poll?: NodeJS.Timeout;
  private readonly pulseTimers = new Set<NodeJS.Timeout>();
  private stopped = false;
  /** Set while the console is booting, so that a second command does not start a second wait. */
  private booting = false;

  constructor(context: AccessoryContext) {
    this.config = context.config;
    this.log = context.log;
    this.storage = context.storage;
    this.registerEndpoint = context.registerEndpoint;
    this.info = initialConsoleInfo(this.config.liveId);

    if (this.config.webApiEnabled) {
      this.auth = new XboxAuthentication({
        name: this.config.name,
        clientId: this.config.webApiClientId || undefined,
        clientSecret: this.config.webApiClientSecret || undefined,
        storageKey: this.tokensStorageKey,
        storage: this.storage,
        log: this.log,
      });

      this.web = new XboxWebApi({ name: this.config.name, liveId: this.config.liveId, auth: this.auth, log: this.log });
    }

    this.local = new XboxLocalApi({
      name: this.config.name,
      host: this.config.host,
      liveId: this.config.liveId,
      log: this.log,
      // A local session carrying the Xbox Live token is what a console with
      // anonymous connections turned off insists on, and what the game DVR
      // command needs; without one the session is opened anonymously.
      credentials: () => this.auth?.credentials(),
    });
  }

  /** @returns {string} The console name as configured. */
  get name(): string {
    return this.config.name;
  }

  // --- lifecycle ------------------------------------------------------------

  /**
   * Reads what is known about the console from the cache, sorts out the
   * authorization, and builds every endpoint.
   *
   * The endpoints are built whether or not the console answers: one that is merely
   * switched off must not disappear from the controller app.
   *
   * @returns {Promise<MatterbridgeEndpoint[]>} The endpoints to register.
   */
  async initialize(): Promise<MatterbridgeEndpoint[]> {
    const cachedInfo = await this.storage.read<ConsoleInfo>(this.infoStorageKey);
    if (cachedInfo) {
      this.info = { ...initialConsoleInfo(this.config.liveId), ...cachedInfo };
      this.infoKnown = true;
      this.log.debug(`${this.name} | ${this.info.modelName}, dashboard ${this.info.firmwareRevision || 'unknown'} (from the cache)`);
    } else {
      this.log.info(`${this.name} | has not been reached yet; it will be exposed with what the configuration says and filled in once it answers`);
    }

    await this.prepareAuthorization();
    this.buildEndpoints(await this.resolveInputs());

    return this.endpoints;
  }

  /**
   * Wires the command handlers and starts contacting the console.
   *
   * Must be called once the endpoints are registered: an attribute can only be
   * written on a live endpoint.
   *
   * @returns {Promise<void>} Resolves once the first contact has been attempted.
   */
  async postRegister(): Promise<void> {
    this.registerHandlers();

    this.local.on('deviceInfo', (info) => void this.handleDeviceInfo({ firmwareRevision: info.firmwareRevision, locale: info.locale }));
    this.local.on('state', (state) => void this.handleLocalState(state));
    this.local.on('connected', () => {
      this.localConnected = true;
    });
    this.local.on('disconnected', () => {
      this.localConnected = false;
      this.log.debug(`${this.name} | the local session ended`);
    });

    this.web?.on('consoleStatus', (status) => void this.handleConsoleStatus(status));
    this.web?.on('installedApps', (inputs) => void this.handleInstalledApps(inputs));

    await this.applyState();

    this.heartbeat = setInterval(() => {
      void this.local.discover().catch((error: unknown) => {
        this.log.debug(`${this.name} | could not look for the console: ${errorMessage(error)}`);
      });
    }, this.config.heartBeatIntervalMs);
    this.heartbeat.unref();

    await this.local.discover().catch((error: unknown) => {
      this.log.debug(`${this.name} | could not look for the console: ${errorMessage(error)}`);
    });

    if (this.web) {
      this.poll = setInterval(() => void this.refreshWebApi(false), this.config.pollIntervalMs);
      this.poll.unref();
      await this.refreshWebApi(true);
    }
  }

  /** Stops contacting the console and cancels everything pending. */
  stop(): void {
    this.stopped = true;
    clearInterval(this.heartbeat);
    clearInterval(this.poll);
    for (const timer of this.pulseTimers) clearTimeout(timer);
    this.pulseTimers.clear();
    this.local.stop();
  }

  // --- authorization --------------------------------------------------------

  /**
   * Gets the plugin into a state where it can talk to Xbox Live, or says what is missing.
   *
   * There are three ways in: a token chain already in the storage, a token file
   * from a Homebridge installation, or an authorization code the user pasted into
   * the configuration. Only the last needs the user present, and only once.
   *
   * @returns {Promise<void>} Resolves once the authorization has been sorted out, or the problem logged.
   */
  private async prepareAuthorization(): Promise<void> {
    if (!this.auth) return;

    await this.auth.load();

    if (!this.auth.hasRefreshToken && this.config.webApiTokensFile) {
      await this.importTokensFile(this.config.webApiTokensFile);
    }

    if (!this.auth.hasRefreshToken && this.config.webApiToken) {
      try {
        await this.auth.exchangeCode(this.config.webApiToken);
      } catch (error) {
        this.log.error(
          `${this.name} | the authorization code in "webApi.token" was refused: ${errorMessage(error)}. ` +
            `A code can only be used once and expires within minutes, so a code that already went through Homebridge is spent — get a new one.`,
        );
      }
    }

    if (this.auth.hasRefreshToken) {
      if (this.config.webApiToken) {
        this.log.debug(`${this.name} | already authorized, so the code in "webApi.token" is left alone`);
      }
      return;
    }

    this.log.warn(
      `${this.name} | is not authorized with Xbox Live yet, so only power and state will work. Open this address, sign in, and paste the "code" parameter of the ` +
        `address you land on into "webApi.token":\n${this.auth.authorizationUrl()}`,
    );
  }

  /**
   * Takes the authorization over from a `homebridge-xbox-tv` token file.
   *
   * @param {string} path The file, as configured. A leading `~` is expanded.
   * @returns {Promise<void>} Resolves once the tokens have been imported, or the failure logged.
   */
  private async importTokensFile(path: string): Promise<void> {
    const resolved = path.startsWith('~') ? path.replace('~', homedir()) : path;

    try {
      const content = await readFile(resolved, 'utf8');
      await this.auth?.importTokens(JSON.parse(content) as XboxTokens);
    } catch (error) {
      this.log.error(`${this.name} | could not import the token file ${resolved}: ${errorMessage(error)}`);
    }
  }

  /**
   * Authorizes and reads the console state from Xbox Live.
   *
   * @param {boolean} first Whether this is the first attempt, which is the one that also reads the app list.
   * @returns {Promise<void>} Resolves once the answer has been dealt with, or the failure logged.
   */
  private async refreshWebApi(first: boolean): Promise<void> {
    if (this.stopped || !this.web || !this.auth?.hasRefreshToken) return;

    try {
      await this.web.refresh(first || this.config.getInputsFromDevice);
    } catch (error) {
      this.log.warn(`${this.name} | could not reach Xbox Live: ${errorMessage(error)}`);
    }
  }

  // --- construction ---------------------------------------------------------

  /**
   * Reads the games and apps, from the configuration or from what the console last reported.
   *
   * @returns {Promise<XboxInput[]>} The ones to expose right away.
   */
  private async resolveInputs(): Promise<XboxInput[]> {
    if (!this.config.getInputsFromDevice) return this.limitInputs(this.config.inputs);

    const cached = await this.storage.read<XboxInput[]>(this.inputsStorageKey);
    if (cached && cached.length > 0) {
      this.log.debug(`${this.name} | ${cached.length} games and apps read from the cache`);
      return this.limitInputs(cached);
    }

    this.log.info(`${this.name} | the game and app list has to come from the console; they will appear once Xbox Live answers`);
    return this.limitInputs(this.config.inputs);
  }

  /**
   * Applies the filters and the cap to a list of games and apps.
   *
   * Every one of them is a device of its own in the controller app, so the cap is
   * not a formality: Alexa stops at fifty bridged devices.
   *
   * @param {XboxInput[]} inputs The list as configured or as reported.
   * @returns {XboxInput[]} The ones to expose.
   */
  private limitInputs(inputs: XboxInput[]): XboxInput[] {
    const wanted = inputs.filter((input) => !isFiltered(input, this.config.filters));
    if (wanted.length <= this.config.maxInputCount) return wanted;

    this.log.warn(
      `${this.name} | ${wanted.length} games and apps are configured or installed but only ${this.config.maxInputCount} are exposed. ` +
        `Raise "inputs.maxCount", turn some of the "inputs.filter..." switches on, or list the ones you want under "inputs.data".`,
    );
    return wanted.slice(0, this.config.maxInputCount);
  }

  /**
   * Builds every endpoint this console exposes.
   *
   * @param {XboxInput[]} inputs The games and apps known at this point.
   */
  private buildEndpoints(inputs: XboxInput[]): void {
    this.buildPower();
    this.buildInputs(inputs);
    this.buildVolume();
    this.buildButtons();
    this.buildSensors();
  }

  /** Builds the outlet standing for the power state of the console. */
  private buildPower(): void {
    if (this.config.powerStyle === 'none') return;

    this.add({
      endpoint: createSwitchEndpoint(this.config.powerStyle, this.identity(this.name, '')),
      reads: (state) => state.power,
      turnOn: () => this.setPower(true),
      turnOff: () => this.setPower(false),
      momentary: false,
    });
  }

  /**
   * Builds one outlet per game or app, each of which turns the others off.
   *
   * @param {XboxInput[]} inputs The ones to expose.
   */
  private buildInputs(inputs: XboxInput[]): void {
    if (this.config.inputStyle === 'none') return;
    for (const input of inputs) this.buildInput(input);
  }

  /**
   * Builds one game or app outlet, unless that one already has one.
   *
   * @param {XboxInput} input The game or app to expose.
   * @returns {BoundSwitch | undefined} The switch, or `undefined` when it already existed.
   */
  private buildInput(input: XboxInput): BoundSwitch | undefined {
    if (this.inputSwitches.has(input.reference)) return undefined;

    const entry = this.add({
      endpoint: createSwitchEndpoint(this.config.inputStyle, this.identity(input.name, `IN-${referenceSuffix(input.reference)}`)),
      reads: (state) => this.isInputActive(state, input),
      turnOn: () => this.selectInput(input),
      // A game cannot be turned off: starting another one is how it ends.
      momentary: false,
    });

    this.inputSwitches.set(input.reference, entry);
    return entry;
  }

  /** Builds the volume device, as a dimmer or as a fan. */
  private buildVolume(): void {
    if (this.config.volumeStyle === 'none') return;

    const identity = this.identity(this.config.volumeName, 'VOL');
    const fanStyle = this.config.volumeStyle === 'fan';
    const endpoint = fanStyle ? createFanEndpoint(identity, false, this.state.volume) : createDimmerEndpoint(identity, false, percentToLevel(this.state.volume));

    this.dimmers.push({
      endpoint,
      fan: fanStyle,
      reads: (state) => ({ on: state.power && !state.mute, percent: state.volume }),
      writeLevel: (percent) => this.setVolume(percent),
      writeOn: (on) => this.setMute(!on),
    });
    this.endpoints.push(endpoint);

    this.log.debug(
      `${this.name} | the volume is exposed as a ${fanStyle ? 'fan' : 'dimmer'}. The console reports no volume of its own, so the slider sends ` +
        `one step per ${this.config.volumeStep}% and remembers where it left off.`,
    );
  }

  /** Builds the momentary switches. */
  private buildButtons(): void {
    for (const button of this.config.buttons) {
      this.add({
        endpoint: createSwitchEndpoint(button.style, this.identity(button.name, `BT-${referenceSuffix(`${button.mode}${button.command}`)}`)),
        turnOn: () => this.pressButton(button),
        momentary: true,
      });
    }
  }

  /** Builds the sensors. */
  private buildSensors(): void {
    for (const [index, sensor] of this.config.sensors.entries()) {
      const endpoint = createSensorEndpoint(sensor.style, this.identity(sensor.name, `SN${index}`));
      this.sensors.push({ endpoint, config: sensor });
      this.endpoints.push(endpoint);
    }
  }

  /**
   * Registers a switch and its endpoint.
   *
   * @param {BoundSwitch} entry The switch to register.
   * @returns {BoundSwitch} The same switch, for the caller to keep.
   */
  private add(entry: BoundSwitch): BoundSwitch {
    this.switches.push(entry);
    this.endpoints.push(entry.endpoint);
    return entry;
  }

  /**
   * Builds the identity of one endpoint.
   *
   * @param {string} name The name shown in the controller app.
   * @param {string} serialSuffix A short suffix making the serial number unique, or `''` for the main endpoint.
   * @returns {EndpointIdentity} The identity to hand to the endpoint factory.
   */
  private identity(name: string, serialSuffix: string): EndpointIdentity {
    const base = this.config.liveId;
    return { name, serial: serialSuffix ? `${base}-${serialSuffix}` : base, info: this.info, debug: this.config.debug };
  }

  // --- handlers -------------------------------------------------------------

  /** Wires the Matter commands of every endpoint to the console. */
  private registerHandlers(): void {
    for (const entry of this.switches) this.registerSwitchHandlers(entry);
    for (const dimmer of this.dimmers) this.registerDimmerHandlers(dimmer);
  }

  /**
   * @param {BoundSwitch} entry The switch to wire.
   */
  private registerSwitchHandlers(entry: BoundSwitch): void {
    entry.endpoint.addCommandHandler('identify', () => this.log.info(`${this.name} | identify`));
    entry.endpoint.addCommandHandler('on', () => void this.handleSwitchCommand(entry, true));
    entry.endpoint.addCommandHandler('off', () => void this.handleSwitchCommand(entry, false));
  }

  /**
   * @param {BoundDimmer} dimmer The dimmer to wire.
   */
  private registerDimmerHandlers(dimmer: BoundDimmer): void {
    dimmer.endpoint.addCommandHandler('identify', () => this.log.info(`${this.name} | identify`));
    dimmer.endpoint.addCommandHandler('on', () => void this.guard(() => dimmer.writeOn(true)));
    dimmer.endpoint.addCommandHandler('off', () => void this.guard(() => dimmer.writeOn(false)));

    if (dimmer.fan) {
      dimmer.endpoint.subscribeAttribute(
        FanControl.Cluster.id,
        'percentSetting',
        (value, _previous, context) => {
          // Our own updates carry no fabric; only a controller write is a command.
          if (context.fabric === undefined || typeof value !== 'number') return;
          void this.guard(() => dimmer.writeLevel(value));
        },
        this.log,
      );
      return;
    }

    const handleLevel = ({ request: { level } }: { request: { level: number } }): void => {
      void this.guard(() => dimmer.writeLevel(levelToPercent(level)));
    };
    dimmer.endpoint.addCommandHandler('moveToLevel', handleLevel);
    dimmer.endpoint.addCommandHandler('moveToLevelWithOnOff', handleLevel);
  }

  /**
   * Applies an on/off command to the console.
   *
   * @param {BoundSwitch} entry The switch that was operated.
   * @param {boolean} on Whether it was turned on.
   * @returns {Promise<void>} Resolves once the console was written to and the endpoints brought back in line.
   */
  private async handleSwitchCommand(entry: BoundSwitch, on: boolean): Promise<void> {
    if (on) {
      await this.guard(entry.turnOn);

      if (entry.momentary) {
        const timer = setTimeout(() => {
          this.pulseTimers.delete(timer);
          void entry.endpoint.updateAttribute(OnOff.Cluster.id, 'onOff', false, this.log);
        }, MOMENTARY_RESET_MS);
        timer.unref();
        this.pulseTimers.add(timer);
        return;
      }

      await this.applyState();
      return;
    }

    if (entry.momentary) return;

    if (entry.turnOff) {
      await this.guard(entry.turnOff);
    } else {
      this.log.debug(`${this.name} | this switch cannot be turned off; starting another game or app is how it is left`);
    }
    await this.applyState();
  }

  /**
   * Runs a command, logging a failure instead of letting it escape into Matter.
   *
   * @param {() => Promise<void>} work The command to run.
   * @returns {Promise<void>} Resolves once the command has finished or failed.
   */
  private async guard(work: () => Promise<void>): Promise<void> {
    try {
      await work();
    } catch (error) {
      this.log.error(`${this.name} | command failed: ${errorMessage(error)}`);
    }
  }

  /**
   * Stores what the console reported about itself and shows it in the controller app.
   *
   * @param {Partial<ConsoleInfo>} update What the console or the service reported.
   * @returns {Promise<void>} Resolves once it has been stored.
   */
  private async handleDeviceInfo(update: Partial<ConsoleInfo>): Promise<void> {
    const merged: ConsoleInfo = { ...this.info, ...Object.fromEntries(Object.entries(update).filter(([, value]) => value !== undefined && value !== '')) };
    if (this.infoKnown && merged.modelName === this.info.modelName && merged.firmwareRevision === this.info.firmwareRevision && merged.locale === this.info.locale) {
      return;
    }

    const firstTime = !this.infoKnown;
    this.info = merged;
    this.infoKnown = true;

    if (firstTime) {
      this.log.info(`${this.name} | ${merged.modelName}, dashboard ${merged.firmwareRevision || 'unknown'}${merged.locale ? `, locale ${merged.locale}` : ''}`);
    }
    await this.storage.write(this.infoStorageKey, merged);

    for (const endpoint of this.endpoints) {
      await endpoint.setAttribute(BridgedDeviceBasicInformation.Cluster.id, 'softwareVersionString', merged.firmwareRevision || 'Unknown', this.log).catch(() => false);
    }
  }

  /**
   * Takes a state report from the local protocol.
   *
   * @param {LocalState} state The state as reported.
   * @returns {Promise<void>} Resolves once every attribute has been updated.
   */
  private async handleLocalState(state: LocalState): Promise<void> {
    this.state = { ...this.state, power: state.power, titleId: state.titleId, reference: state.reference };

    // The console only reports which title is in the foreground; whether it is
    // playing comes from the Web API, and a console that is off is not playing.
    if (!state.power) {
      this.state.playState = false;
      this.state.playbackState = 'Unknown';
    }

    await this.applyState();
  }

  /**
   * Takes a state report from Xbox Live.
   *
   * What it says about the power and the foreground title is only used while no
   * local session is open: it is minutes old, whereas the local protocol reports
   * within seconds.
   *
   * @param {WebConsoleStatus} status The state as reported.
   * @returns {Promise<void>} Resolves once every attribute has been updated.
   */
  private async handleConsoleStatus(status: WebConsoleStatus): Promise<void> {
    this.webPower = status.powerState === 'On';
    this.state.playbackState = status.playbackState;
    this.state.playState = status.playbackState === 'Playing';

    if (!this.localConnected) {
      this.state.power = this.webPower;
      if (status.focusAppAumid) this.state.reference = status.focusAppAumid;
      if (!this.webPower) this.state.reference = '';
    }

    await this.handleDeviceInfo({ modelName: status.consoleType, locale: status.locale });
    await this.applyState();
  }

  /**
   * Adds an outlet for every game and app the console reports that has none yet.
   *
   * @param {XboxInput[]} inputs The list as reported.
   * @returns {Promise<void>} Resolves once the new endpoints are registered.
   */
  private async handleInstalledApps(inputs: XboxInput[]): Promise<void> {
    if (!this.config.getInputsFromDevice || this.config.inputStyle === 'none') return;

    await this.storage.write(this.inputsStorageKey, inputs);

    const added: BoundSwitch[] = [];
    for (const input of this.limitInputs(inputs)) {
      if (this.inputSwitches.size >= this.config.maxInputCount && !this.inputSwitches.has(input.reference)) continue;
      const entry = this.buildInput(input);
      if (entry) added.push(entry);
    }

    if (added.length === 0) return;

    this.log.info(`${this.name} | the console reported ${added.length} new game${added.length === 1 ? '' : 's'} or app${added.length === 1 ? '' : 's'}`);
    for (const entry of added) {
      await this.registerEndpoint(entry.endpoint);
      this.registerSwitchHandlers(entry);
    }
    await this.applyState();
  }

  // --- state ----------------------------------------------------------------

  /**
   * Pushes the current state into every endpoint, one pass at a time.
   *
   * Both protocols report state on their own schedule, so several passes would
   * otherwise be in flight at once — and since each awaits every attribute write,
   * an older pass could finish last and put a stale value back. Passes are
   * therefore serialized, and a pass asked for while one is running is collapsed
   * into a single re-run afterwards.
   *
   * @returns {Promise<void>} Resolves once every attribute has been updated.
   */
  private async applyState(): Promise<void> {
    if (this.stopped) return;

    if (this.applying) {
      this.applyAgain = true;
      return;
    }

    this.applying = true;
    try {
      do {
        this.applyAgain = false;
        await this.pushState();
      } while (this.applyAgain && !this.stopped);
    } finally {
      this.applying = false;
    }
  }

  /**
   * Writes the current state into every endpoint, once.
   *
   * @returns {Promise<void>} Resolves once every attribute has been updated.
   */
  private async pushState(): Promise<void> {
    const state = this.state;

    for (const entry of this.switches) {
      if (entry.momentary || !entry.reads) continue;
      await entry.endpoint.updateAttribute(OnOff.Cluster.id, 'onOff', entry.reads(state), this.log);
    }

    for (const dimmer of this.dimmers) {
      const { on, percent } = dimmer.reads(state);
      await dimmer.endpoint.updateAttribute(OnOff.Cluster.id, 'onOff', on, this.log);
      if (dimmer.fan) {
        await dimmer.endpoint.updateAttribute(FanControl.Cluster.id, 'percentSetting', percent, this.log);
        await dimmer.endpoint.updateAttribute(FanControl.Cluster.id, 'percentCurrent', percent, this.log);
      } else {
        await dimmer.endpoint.updateAttribute(LevelControl.Cluster.id, 'currentLevel', percentToLevel(percent), this.log);
      }
    }

    await this.applySensors(state);
    this.previousState = { ...state };
  }

  /**
   * Pushes the current state into every sensor.
   *
   * A pulsing sensor reports for half a second on every change of what it
   * watches; a plain one reports for as long as the condition holds.
   *
   * @param {ConsoleState} state The state being pushed.
   * @returns {Promise<void>} Resolves once every sensor has been updated.
   */
  private async applySensors(state: ConsoleState): Promise<void> {
    for (const { endpoint, config } of this.sensors) {
      const current = sensorValue(state, config.mode);

      if (config.pulse) {
        const changed = current !== sensorValue(this.previousState, config.mode);
        if (!changed || !state.power) continue;

        await this.writeSensor(endpoint, config.style, true);
        const timer = setTimeout(() => {
          this.pulseTimers.delete(timer);
          void this.writeSensor(endpoint, config.style, false);
        }, SENSOR_PULSE_MS);
        timer.unref();
        this.pulseTimers.add(timer);
        continue;
      }

      await this.writeSensor(endpoint, config.style, state.power && sensorTriggered(current, config));
    }
  }

  /**
   * Writes one sensor reading.
   *
   * @param {MatterbridgeEndpoint} endpoint The sensor endpoint.
   * @param {'occupancy' | 'contact'} style Which kind of sensor it is.
   * @param {boolean} triggered Whether the watched condition holds.
   * @returns {Promise<void>} Resolves once the attribute has been updated.
   */
  private async writeSensor(endpoint: MatterbridgeEndpoint, style: 'occupancy' | 'contact', triggered: boolean): Promise<void> {
    if (style === 'occupancy') {
      await endpoint.updateAttribute(OccupancySensing.Cluster.id, 'occupancy', { occupied: triggered }, this.log);
      return;
    }
    // A contact sensor is closed while nothing is going on and opens when it triggers.
    await endpoint.updateAttribute(BooleanState.Cluster.id, 'stateValue', !triggered, this.log);
  }

  /**
   * @param {ConsoleState} state The state to look at.
   * @param {XboxInput} input The game or app to check.
   * @returns {boolean} Whether it is the one in the foreground.
   */
  private isInputActive(state: ConsoleState, input: XboxInput): boolean {
    if (!state.power) return false;
    if (state.reference && state.reference === input.reference) return true;
    // A game reports a title id even when its AUMID differs from what the store
    // calls it, which is what makes a configured entry match at all.
    return Boolean(input.titleId) && state.titleId === input.titleId;
  }

  // --- commands -------------------------------------------------------------

  /**
   * Hands over the Web API, authorizing first when it is not ready.
   *
   * The state poll runs every few minutes, so a console that was unreachable
   * when it last ran would otherwise refuse commands for minutes after coming
   * back. A command is worth one attempt of its own.
   *
   * @returns {Promise<XboxWebApi | undefined>} The Web API when it can carry commands, or `undefined`.
   */
  private async webControl(): Promise<XboxWebApi | undefined> {
    if (!this.web || !this.auth?.hasRefreshToken) return undefined;
    if (this.web.canControl) return this.web;

    await this.refreshWebApi(false);
    return this.web.canControl ? this.web : undefined;
  }

  /**
   * Powers the console on or off.
   *
   * Xbox Live is asked first, because a console reachable through Microsoft obeys
   * from anywhere; the local protocol is the fallback, and the only way when the
   * Web API is turned off. Waking works either way — a console in standby listens
   * for the local wake packet — but shutting down over the local protocol needs an
   * open session, which only exists while the console is on.
   *
   * @param {boolean} on The requested power state.
   * @returns {Promise<void>} Resolves once the command has been sent.
   */
  private async setPower(on: boolean): Promise<void> {
    const web = await this.webControl();
    if (web) {
      try {
        await web.send('Power', on ? 'WakeUp' : 'TurnOff');
        this.log.info(`${this.name} | power ${on ? 'on' : 'off'}`);
        this.applyPowerOptimistically(on);
        return;
      } catch (error) {
        this.log.warn(`${this.name} | Xbox Live would not ${on ? 'wake' : 'shut down'} the console: ${errorMessage(error)}; trying the local protocol`);
      }
    }

    if (on) {
      this.log.info(`${this.name} | power on, over the local protocol`);
      const up = await this.local.powerOn();
      if (!up) this.log.warn(`${this.name} | did not answer after the wake packets. Turn on Settings, General, Power options, Sleep on the console.`);
      return;
    }

    if (!(await this.local.powerOff())) {
      this.log.warn(`${this.name} | cannot be shut down: that needs either Xbox Live or an open local session.`);
      return;
    }

    this.log.info(`${this.name} | power off, over the local protocol`);
    this.applyPowerOptimistically(false);
  }

  /**
   * Shows a power change straight away rather than waiting for the console to report it.
   *
   * The local protocol takes a few seconds to notice, and a switch that springs
   * back before then reads as a failure in the controller app.
   *
   * @param {boolean} on What the console was told to do.
   */
  private applyPowerOptimistically(on: boolean): void {
    this.state.power = on;
    this.webPower = on;
    if (!on) {
      this.state.reference = '';
      this.state.titleId = '';
      this.state.playState = false;
    }
    void this.applyState();
  }

  /**
   * Starts a game or app, waking the console first when it is off.
   *
   * @param {XboxInput} input The one to start.
   * @returns {Promise<void>} Resolves once the command has been sent, or the deferred start scheduled.
   */
  private async selectInput(input: XboxInput): Promise<void> {
    if (!(await this.webControl())) {
      this.log.warn(`${this.name} | starting "${input.name}" needs Xbox Live; the console cannot be told to launch anything over the local protocol.`);
      await this.applyState();
      return;
    }

    if (this.state.power) {
      await this.launch(input);
      return;
    }

    if (this.booting) {
      this.log.debug(`${this.name} | is already booting, so "${input.name}" is not started as well`);
      return;
    }

    this.log.info(`${this.name} | is off, waking it before starting ${input.name}`);
    await this.setPower(true);

    this.booting = true;
    void (async () => {
      try {
        for (let attempt = 0; attempt < POWER_ON_ATTEMPTS; attempt++) {
          await delay(POWER_ON_POLL_MS);
          if (this.stopped) return;
          if (!this.state.power) continue;

          // The dashboard takes over the foreground as the console finishes
          // booting, so the launch is repeated until the console stays on it.
          if (this.state.reference === input.reference) {
            this.log.info(`${this.name} | started ${input.name}`);
            return;
          }
          await this.guard(() => this.launch(input));
        }

        this.log.warn(`${this.name} | did not come up in time, so ${input.name} was not started`);
      } finally {
        this.booting = false;
        await this.applyState();
      }
    })();
  }

  /**
   * Sends the command that starts one game or app.
   *
   * The shell destinations — the dashboard, the settings, the guide — are not
   * launched by product id but reached with a shell command of their own, exactly
   * as the Homebridge plugin does it.
   *
   * @param {XboxInput} input The one to start.
   * @returns {Promise<void>} Resolves once the command has been sent.
   */
  private async launch(input: XboxInput): Promise<void> {
    await this.launchProduct(input.oneStoreProductId || input.reference, input.name);
    this.log.info(`${this.name} | ${input.name}`);
  }

  /**
   * Sends the command that reaches one product id.
   *
   * @param {string} productId The product id, or one of the shell destinations.
   * @param {string} label What to call it in the log.
   * @returns {Promise<void>} Resolves once the command has been sent.
   */
  private async launchProduct(productId: string, label: string): Promise<void> {
    if (!this.web) throw new Error('the Web API is turned off');
    if (!productId) throw new Error(`"${label}" has no product id, so it cannot be started`);

    if ((SHELL_HOME_PRODUCT_IDS as readonly string[]).includes(productId)) {
      await this.web.send('Shell', 'GoHome');
      return;
    }

    switch (productId) {
      case 'Television':
        await this.web.send('TV', 'ShowGuide');
        return;
      case 'XboxGuide':
        await this.web.send('Shell', 'ShowGuideTab', [{ tabName: 'Guide' }]);
        return;
      default:
        await this.web.send('Shell', 'ActivateApplicationWithOneStoreProductId', [{ oneStoreProductId: productId }]);
    }
  }

  /**
   * Moves the volume.
   *
   * Neither protocol reports the volume and neither takes an absolute one: all the
   * console understands is one step up or one step down, which it passes on to
   * whatever it is plugged into over HDMI-CEC or infrared. So the slider position
   * is a number the plugin keeps, and moving it sends as many steps as the
   * difference is worth.
   *
   * @param {number} percent Where the slider was moved to, `0..100`.
   * @returns {Promise<void>} Resolves once every step has been sent.
   */
  private async setVolume(percent: number): Promise<void> {
    const web = await this.webControl();
    if (!web) {
      this.log.warn(`${this.name} | changing the volume needs Xbox Live.`);
      await this.applyState();
      return;
    }

    const target = clamp(Math.round(percent), 0, 100);
    const difference = target - this.state.volume;
    const steps = Math.min(MAX_VOLUME_STEPS, Math.round(Math.abs(difference) / this.config.volumeStep));

    if (steps === 0) {
      this.state.volume = target;
      await this.applyState();
      return;
    }

    const command = difference > 0 ? 'Up' : 'Down';
    for (let step = 0; step < steps; step++) {
      if (this.stopped) break;
      await web.send('Volume', command);
      if (step + 1 < steps) await delay(VOLUME_STEP_DELAY_MS);
    }

    this.state.volume = target;
    this.state.mute = false;
    this.log.info(`${this.name} | volume ${command === 'Up' ? '+' : '-'}${steps} step${steps === 1 ? '' : 's'} to ${target}%`);
    await this.applyState();
  }

  /**
   * Mutes or unmutes the console.
   *
   * @param {boolean} mute Whether to mute.
   * @returns {Promise<void>} Resolves once the command has been sent.
   */
  private async setMute(mute: boolean): Promise<void> {
    const web = await this.webControl();
    if (!web) {
      this.log.warn(`${this.name} | muting needs Xbox Live.`);
      await this.applyState();
      return;
    }

    await web.send('Audio', mute ? 'Mute' : 'Unmute');
    this.state.mute = mute;
    this.log.info(`${this.name} | ${mute ? 'muted' : 'unmuted'}`);
    await this.applyState();
  }

  /**
   * Fires the command behind a momentary switch.
   *
   * @param {ResolvedButton} button The button that was pressed.
   * @returns {Promise<void>} Resolves once the command has been sent.
   */
  private async pressButton(button: ResolvedButton): Promise<void> {
    // Recording a clip is the one command the console still takes locally, and
    // the only one that works with the Web API turned off.
    if (button.mode === 3 && button.command === 'recordGameDvr') {
      await this.local.recordGameDvr();
      this.log.info(`${this.name} | ${button.name}`);
      return;
    }

    const web = await this.webControl();
    if (!web) {
      this.log.warn(`${this.name} | "${button.name}" needs Xbox Live; keys and console commands cannot be sent over the local protocol.`);
      return;
    }

    switch (button.mode) {
      case 0: {
        const command = MEDIA_CHANNEL_COMMANDS[button.command];
        if (command) await web.send('Media', command);
        else await web.send('Shell', 'InjectKey', [{ keyType: button.command }]);
        break;
      }
      case 1:
        await web.send('Shell', 'InjectKey', [{ keyType: button.command }]);
        break;
      case 2:
        // The three TV remote keys are the volume of whatever the console is
        // plugged into, which the service has channels of its own for.
        if (button.command === 'volUp') await web.send('Volume', 'Up');
        else if (button.command === 'volDown') await web.send('Volume', 'Down');
        else await this.setMute(!this.state.mute);
        break;
      case 3:
        await web.send('Power', 'Reboot');
        break;
      case 4:
        await this.launchProduct(button.command, button.name);
        break;
    }

    this.log.info(`${this.name} | ${button.name}`);
  }

  /** @returns {string} The storage key the token chain of this console lives under. */
  private get tokensStorageKey(): string {
    return `tokens-${this.config.liveId}`;
  }

  /** @returns {string} The storage key the device information of this console lives under. */
  private get infoStorageKey(): string {
    return `deviceInfo-${this.config.liveId}`;
  }

  /** @returns {string} The storage key the game and app list of this console lives under. */
  private get inputsStorageKey(): string {
    return `inputs-${this.config.liveId}`;
  }
}

/**
 * Reads the part of the state a sensor watches.
 *
 * @param {ConsoleState} state The state to look at.
 * @param {SensorMode} mode What the sensor watches.
 * @returns {string | number | boolean} The value to compare against the sensor's trigger.
 */
function sensorValue(state: ConsoleState, mode: SensorMode): string | number | boolean {
  switch (mode) {
    case 'input':
      return state.reference;
    case 'power':
      return state.power;
    case 'volume':
      return state.volume;
    case 'mute':
      return state.mute;
    case 'screenSaver':
      return state.reference === SCREEN_SAVER_REFERENCE;
    case 'playState':
      return state.playState;
  }
}

/**
 * @param {string | number | boolean} value What the sensor watches, right now.
 * @param {ResolvedSensor} sensor The sensor configuration.
 * @returns {boolean} Whether the sensor should report.
 */
function sensorTriggered(value: string | number | boolean, sensor: ResolvedSensor): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value === sensor.level;
  return value === sensor.reference;
}
