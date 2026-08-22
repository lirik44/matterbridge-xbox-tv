import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';

import type { AnsiLogger } from 'matterbridge/logger';

import type { XboxAuthentication } from './authentication.js';
import { ConsoleNames, DefaultInputs, PLAYBACK_STATES, WEB_API_HEADERS, WebApiUrls } from './constants.js';
import type { XboxInput } from './types.js';
import { delay, errorMessage } from './utils.js';

/** How long a request to Xbox Live may take, in milliseconds. */
const REQUEST_TIMEOUT_MS = 10_000;

/** How often a throttled request is tried again before giving up. */
const RETRY_ATTEMPTS = 2;

/** How long to wait before trying a throttled request again, in milliseconds. */
const RETRY_DELAY_MS = 1000;

/** What the console command and control service says about a console. */
export interface WebConsoleStatus {
  /** The model, e.g. `Xbox Series X`. */
  consoleType: string;
  /** Whether the console is on, in standby, or updating. */
  powerState: string;
  /** Whether the foreground title is playing, paused or stopped. */
  playbackState: 'Stopped' | 'Playing' | 'Paused' | 'Unknown';
  /** The AUMID of the foreground title. */
  focusAppAumid: string;
  locale: string;
  /** Whether anyone is signed in on the console. */
  loginState: string;
  /** Whether the console accepts commands from outside the home. */
  remoteManagementEnabled: boolean;
}

/** What the client needs to reach one console through Microsoft. */
export interface WebApiOptions {
  /** The console name, for the log. */
  name: string;
  /** The Xbox Live device id of the console. */
  liveId: string;
  auth: XboxAuthentication;
  log: AnsiLogger;
}

/** The events the client emits. */
interface WebApiEvents {
  /** The service answered with the state of the console. */
  consoleStatus: [WebConsoleStatus];
  /** The service answered with the games and apps installed on the console. */
  installedApps: [XboxInput[]];
}

/**
 * The Xbox Live client of one console.
 *
 * Everything that changes something on the console goes through here rather than
 * over the local protocol: Microsoft removed the ability to launch a title or
 * press a button locally, and left it in the cloud service the Xbox app uses. The
 * console has to have "remote features" turned on for any of it to work, and it
 * has to be reachable by Microsoft — a console that is only on the local network
 * can be watched but not controlled.
 */
export class XboxWebApi extends EventEmitter<WebApiEvents> {
  private readonly log: AnsiLogger;
  private readonly name: string;
  private readonly liveId: string;
  private readonly auth: XboxAuthentication;

  private authorized = false;
  private remoteManagement = false;
  /** Set once the console has been found in the account, so the warning is logged once. */
  private consoleFound = false;

  constructor(options: WebApiOptions) {
    super();
    this.name = options.name;
    this.liveId = options.liveId;
    this.auth = options.auth;
    this.log = options.log;
  }

  /** @returns {boolean} Whether the plugin holds a valid token and has found the console. */
  get isAuthorized(): boolean {
    return this.authorized && this.consoleFound;
  }

  /** @returns {boolean} Whether the console accepts commands. */
  get canControl(): boolean {
    return this.isAuthorized && this.remoteManagement;
  }

  /**
   * Authorizes, finds the console in the account, and reads its state and its app list.
   *
   * Run on start-up and every so often afterwards, which is what keeps the token
   * chain from going stale.
   *
   * @param {boolean} withApps Whether to read the app list as well.
   * @returns {Promise<boolean>} Whether the console can be reached through Microsoft.
   */
  async refresh(withApps: boolean): Promise<boolean> {
    try {
      await this.auth.authorize();
      this.authorized = true;
    } catch (error) {
      this.authorized = false;
      throw new Error(`Xbox Live authorization failed: ${errorMessage(error)}`);
    }

    if (!(await this.consolesList())) return false;

    await this.consoleStatus();
    if (withApps) await this.installedApps();

    return true;
  }

  /**
   * Looks the console up in the account it belongs to.
   *
   * @returns {Promise<boolean>} Whether it is there.
   */
  async consolesList(): Promise<boolean> {
    const data = await this.get<{ status?: { errorCode?: string; errorMessage?: string }; result?: WebConsoleRecord[] }>(
      '/lists/devices?queryCurrentDevice=false&includeStorageDevices=true',
    );

    if (data.status?.errorCode !== 'OK') {
      this.log.debug(`${this.name} | the console list could not be read: ${data.status?.errorMessage ?? 'unknown error'}`);
      return false;
    }

    const record = (data.result ?? []).find((entry) => entry.id === this.liveId);
    if (!record) {
      this.log.warn(
        `${this.name} | no console with the Xbox Live device id ${this.liveId} is registered to this account. ` +
          `Check "xboxLiveId" — it is shown on the console under Settings, System, Console info as the "Xbox network device ID".`,
      );
      this.consoleFound = false;
      return false;
    }

    const wasFound = this.consoleFound;
    this.consoleFound = true;
    this.remoteManagement = Boolean(record.remoteManagementEnabled);

    if (!this.remoteManagement) {
      this.log.warn(`${this.name} | has remote features turned off, so it cannot be controlled. Turn on Settings, Devices & connections, Remote features on the console.`);
    } else if (!wasFound) {
      const model = ConsoleNames[record.consoleType ?? ''] ?? record.consoleType ?? 'console';
      this.log.debug(`${this.name} | found as a ${model} in region ${record.region ?? 'unknown'}`);
    }

    return true;
  }

  /**
   * Reads the state of the console.
   *
   * @returns {Promise<WebConsoleStatus | undefined>} The state, or `undefined` when the service would not say.
   */
  async consoleStatus(): Promise<WebConsoleStatus | undefined> {
    const data = await this.get<WebConsoleRecord & { status?: { errorCode?: string; errorMessage?: string } }>(`/consoles/${this.liveId}`);

    if (data.status?.errorCode !== 'OK') {
      this.log.debug(`${this.name} | the console status could not be read: ${data.status?.errorMessage ?? 'unknown error'}`);
      return undefined;
    }

    const status: WebConsoleStatus = {
      consoleType: ConsoleNames[data.consoleType ?? ''] ?? data.consoleType ?? 'Xbox',
      powerState: data.powerState ?? 'Unknown',
      playbackState: playbackState(data.playbackState),
      focusAppAumid: data.focusAppAumid ?? '',
      locale: data.locale ?? '',
      loginState: data.loginState ?? '',
      remoteManagementEnabled: Boolean(data.remoteManagementEnabled),
    };

    this.remoteManagement = status.remoteManagementEnabled;
    this.emit('consoleStatus', status);
    return status;
  }

  /**
   * Reads the games and apps installed on the console.
   *
   * @returns {Promise<XboxInput[] | undefined>} The list, with the apps every console has in front, or `undefined` when the service would not say.
   */
  async installedApps(): Promise<XboxInput[] | undefined> {
    const data = await this.get<{ status?: { errorCode?: string; errorMessage?: string }; result?: InstalledAppRecord[] }>(`/lists/installedApps?deviceId=${this.liveId}`);

    if (data.status?.errorCode !== 'OK') {
      this.log.debug(`${this.name} | the app list could not be read: ${data.status?.errorMessage ?? 'unknown error'}`);
      return undefined;
    }

    const apps = (data.result ?? [])
      .filter((app) => app.name && app.aumid)
      .map<XboxInput>((app) => ({
        name: app.name,
        reference: app.aumid,
        oneStoreProductId: app.oneStoreProductId ?? '',
        titleId: String(app.titleId ?? ''),
        contentType: app.contentType ?? '',
        isGame: Boolean(app.isGame),
      }));

    const inputs = [...DefaultInputs.map<XboxInput>((input) => ({ ...input })), ...apps];
    this.emit('installedApps', inputs);
    return inputs;
  }

  /**
   * Sends one command to the console.
   *
   * @param {string} commandType The channel, e.g. `Shell`, `Power`, `Volume` or `Audio`.
   * @param {string} command What to do on that channel, e.g. `InjectKey`.
   * @param {Record<string, unknown>[]} [parameters] The arguments of the command.
   * @returns {Promise<void>} Resolves once the service has accepted the command.
   * @throws {Error} When the plugin is not authorized, the console has remote features off, or the service refuses.
   */
  async send(commandType: string, command: string, parameters?: Record<string, unknown>[]): Promise<void> {
    if (!this.isAuthorized) throw new Error('the plugin is not authorized with Xbox Live');
    if (!this.remoteManagement) throw new Error('the console has remote features turned off');

    await this.request('/commands', 'POST', {
      destination: 'Xbox',
      type: commandType,
      command,
      sessionId: randomUUID(),
      sourceId: 'com.microsoft.smartglass',
      parameters: parameters ?? [],
      linkedXboxId: this.liveId,
    });

    this.log.debug(`${this.name} | sent ${commandType}/${command}${parameters ? ` ${JSON.stringify(parameters)}` : ''}`);
  }

  /**
   * Reads one document from the service.
   *
   * @template T The expected answer.
   * @param {string} path The path below the service address.
   * @returns {Promise<T>} The answer.
   */
  private async get<T>(path: string): Promise<T> {
    return this.request<T>(path, 'GET');
  }

  /**
   * Sends one request to the service, trying again when it is throttled.
   *
   * @template T The expected answer.
   * @param {string} path The path below the service address.
   * @param {'GET' | 'POST'} method The method.
   * @param {unknown} [body] The document to send, for a post.
   * @returns {Promise<T>} The answer, or an empty object when the service answered with no body.
   * @throws {Error} When the service cannot be reached or refuses the request.
   */
  private async request<T>(path: string, method: 'GET' | 'POST', body?: unknown): Promise<T> {
    const { header } = await this.auth.authorize();
    const url = `${WebApiUrls.Xccs}${path}`;

    for (let attempt = 0; ; attempt++) {
      let response: Response;
      try {
        response = await fetch(url, {
          method,
          headers: { ...WEB_API_HEADERS, Authorization: header },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
      } catch (error) {
        if (attempt < RETRY_ATTEMPTS) {
          await delay(RETRY_DELAY_MS);
          continue;
        }
        throw new Error(`Xbox Live could not be reached: ${errorMessage(error)}`);
      }

      if (response.status === 429 && attempt < RETRY_ATTEMPTS) {
        this.log.debug(`${this.name} | Xbox Live is throttling requests, trying ${path} again`);
        await delay(RETRY_DELAY_MS);
        continue;
      }

      const text = await response.text();
      if (!response.ok) {
        if (response.status === 401) this.authorized = false;
        throw new Error(`Xbox Live refused ${method} ${path} with ${response.status}: ${text.slice(0, 200)}`);
      }

      if (!text) return {} as T;
      try {
        return JSON.parse(text) as T;
      } catch {
        throw new Error(`Xbox Live answered ${method} ${path} with something that is not JSON`);
      }
    }
  }
}

/** One console as the service describes it. */
interface WebConsoleRecord {
  id?: string;
  name?: string;
  locale?: string;
  region?: string;
  consoleType?: string;
  powerState?: string;
  playbackState?: string;
  loginState?: string;
  focusAppAumid?: string;
  remoteManagementEnabled?: boolean;
}

/** One installed game or app as the service describes it. */
interface InstalledAppRecord {
  name: string;
  aumid: string;
  oneStoreProductId?: string;
  titleId?: number | string;
  contentType?: string;
  isGame?: boolean;
}

/**
 * @param {string | undefined} value The playback state as the service spells it.
 * @returns {'Stopped' | 'Playing' | 'Paused' | 'Unknown'} The same, or `Unknown` for anything unexpected.
 */
function playbackState(value: string | undefined): 'Stopped' | 'Playing' | 'Paused' | 'Unknown' {
  return PLAYBACK_STATES.find((state) => state === value) ?? 'Unknown';
}
