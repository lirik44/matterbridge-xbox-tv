/** What the console reports about itself, cached between restarts. */
export interface ConsoleInfo {
  manufacturer: string;
  /** The model, e.g. `Xbox Series X`. Only the Web API knows it. */
  modelName: string;
  /** The Xbox Live device id, which is also the Matter serial number. */
  liveId: string;
  /** The dashboard version, e.g. `10.0.26100`. Only the local protocol reports it. */
  firmwareRevision: string;
  /** The console locale, e.g. `en-US`. */
  locale: string;
}

/** Everything the plugin knows about the current state of a console. */
export interface ConsoleState {
  /** Whether the console is on. A console in standby answers the network but runs no title. */
  power: boolean;
  /** The title id of the foreground game or app. */
  titleId: string;
  /** The AUMID of the foreground game or app, which is what an input is matched against. */
  reference: string;
  /** Whether the foreground title is playing rather than paused or stopped. */
  playState: boolean;
  /** The playback state as the Web API reports it. */
  playbackState: 'Stopped' | 'Playing' | 'Paused' | 'Unknown';
  /**
   * The volume, `0..100`.
   *
   * Neither protocol reports the volume, so this is what the plugin last set: the
   * console only accepts relative volume steps. It starts at the midpoint so that
   * the first slider move has somewhere to go in both directions.
   */
  volume: number;
  /** Whether the console is muted, as far as the plugin has been told. */
  mute: boolean;
}

/** A game or app the console can be switched to. */
export interface XboxInput {
  /** The name shown in the controller app. */
  name: string;
  /** The AUMID, which is what the console reports as the foreground title. */
  reference: string;
  /** The product id, which is what a launch command takes. */
  oneStoreProductId: string;
  /** The title id, the numeric identity of the same game or app. */
  titleId: string;
  /** What kind of thing it is: `Game`, `App`, `systemApp`, `Dlc` or `Dashboard`. */
  contentType: string;
  /** Whether the console calls it a game. */
  isGame: boolean;
}

/** @returns {ConsoleState} A state in which nothing is known yet: the console counts as off. */
export function initialConsoleState(): ConsoleState {
  return {
    power: false,
    titleId: '',
    reference: '',
    playState: false,
    playbackState: 'Unknown',
    volume: 50,
    mute: false,
  };
}

/**
 * @param {string} liveId The Xbox Live device id from the configuration.
 * @returns {ConsoleInfo} The device information assumed before the console has ever been reached.
 */
export function initialConsoleInfo(liveId: string): ConsoleInfo {
  return {
    manufacturer: 'Microsoft',
    modelName: 'Xbox',
    liveId,
    firmwareRevision: '',
    locale: '',
  };
}
