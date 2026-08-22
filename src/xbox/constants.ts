/**
 * The tables of both Xbox protocols this plugin speaks.
 *
 * The values are the ones the `homebridge-xbox-tv` plugin uses, so a console that
 * works there works here: the same OAuth client id, the same Xbox Live endpoints
 * and the same SmartGlass message numbers.
 */

/** The Xbox Live endpoints. */
export const WebApiUrls = {
  /** Where the user is sent to grant access. */
  Oauth2: 'https://login.live.com/oauth20_authorize.srf',
  /** Where an authorization code is exchanged for tokens. */
  AccessToken: 'https://login.live.com/oauth20_token.srf',
  /** Where a refresh token is exchanged for a new access token. */
  RefreshToken: 'https://login.live.com/oauth20_token.srf',
  /** Where the Microsoft access token becomes an Xbox Live user token. */
  UserToken: 'https://user.auth.xboxlive.com/user/authenticate',
  /** Where the user token becomes an XSTS token, which is what the console accepts. */
  XstsToken: 'https://xsts.auth.xboxlive.com/xsts/authorize',
  /** Where the authorization code lands. Nothing listens there; the code is read out of the address bar. */
  Redirect: 'http://localhost:8888/auth/callback',
  /** The console command and control service. */
  Xccs: 'https://xccs.xboxlive.com',
} as const;

/** The scopes the plugin asks for: sign in, and keep working without the user present. */
export const WEB_API_SCOPES = 'XboxLive.signin XboxLive.offline_access';

/** The OAuth client the plugin authenticates as, registered by the author of `homebridge-xbox-tv`. */
export const WEB_API_CLIENT_ID = 'a34ac209-edab-4b08-91e7-a4558d8da1bd';

/** The headers Xbox Live expects from a remote management client. */
export const WEB_API_HEADERS: Record<string, string> = {
  'Accept-Language': 'en-US',
  'x-xbl-contract-version': '4',
  'x-xbl-client-name': 'XboxApp',
  'x-xbl-client-type': 'UWA',
  'x-xbl-client-version': '39.39.22001.0',
  'skillplatform': 'RemoteManagement',
  'Content-Type': 'application/json',
};

/** What the Web API calls the console models. */
export const ConsoleNames: Record<string, string> = {
  XboxSeriesX: 'Xbox Series X',
  XboxSeriesS: 'Xbox Series S',
  XboxOne: 'Xbox One',
  XboxOneS: 'Xbox One S',
  XboxOneX: 'Xbox One X',
};

/** The playback states the Web API reports. */
export const PLAYBACK_STATES = ['Stopped', 'Playing', 'Paused', 'Unknown'] as const;

/** The reference of the screen saver, which is an app like any other as far as the console is concerned. */
export const SCREEN_SAVER_REFERENCE = 'Xbox.IdleScreen_8wekyb3d8bbwe!Xbox.IdleScreen.Application';

/** The port both SmartGlass directions use. */
export const LOCAL_API_PORT = 5050;

/** The SmartGlass message categories, by the first two bytes of the packet. */
export const LocalApiCategories: Record<string, 'message' | 'simple'> = {
  d00d: 'message',
  dd00: 'simple',
  dd01: 'simple',
  dd02: 'simple',
  cc00: 'simple',
  cc01: 'simple',
};

/** Which simple packet a category byte pair stands for. */
export const LocalApiCategoryTypes: Record<string, string> = {
  d00d: 'message',
  dd00: 'discoveryRequest',
  dd01: 'discoveryResponse',
  dd02: 'powerOn',
  cc00: 'connectRequest',
  cc01: 'connectResponse',
};

/** The message types, by the number in the flags field. */
export const LocalApiMessageTypes: Record<number, string> = {
  0x1: 'acknowledge',
  0x2: 'group',
  0x3: 'localJoin',
  0x5: 'stopActivity',
  0x19: 'auxilaryStream',
  0x1a: 'activeSurfaceChange',
  0x1b: 'navigate',
  0x1c: 'json',
  0x1d: 'tunnel',
  0x1e: 'consoleStatus',
  0x1f: 'titleTextConfiguration',
  0x20: 'titleTextInput',
  0x21: 'titleTextSelection',
  0x22: 'mirroringRequest',
  0x23: 'titleLaunch',
  0x26: 'channelStartRequest',
  0x27: 'channelStartResponse',
  0x28: 'channelStop',
  0x29: 'system',
  0x2a: 'disconnect',
  0x2e: 'titleTouch',
  0x2f: 'accelerometer',
  0x30: 'gyrometer',
  0x31: 'inclinometer',
  0x32: 'compass',
  0x33: 'orientation',
  0x36: 'pairedIdentityStateChanged',
  0x37: 'unsnap',
  0x38: 'recordGameDvr',
  0x39: 'powerOff',
  0xf00: 'mediaControllerRemoved',
  0xf01: 'mediaCommand',
  0xf02: 'mediaCommandResult',
  0xf03: 'mediaState',
  0xf0a: 'gamepad',
  0xf2b: 'systemTextConfiguration',
  0xf2c: 'systemTextInput',
  0xf2e: 'systemTouch',
  0xf34: 'systemTextAck',
  0xf35: 'systemTextDone',
};

/** The two byte header every packet the plugin sends starts with. */
export const LocalApiFlags: Record<string, Buffer> = {
  acknowledge: Buffer.from('8001', 'hex'),
  localJoin: Buffer.from('2003', 'hex'),
  json: Buffer.from('a01c', 'hex'),
  consoleStatus: Buffer.from('a01e', 'hex'),
  channelStartRequest: Buffer.from('a026', 'hex'),
  channelStartResponse: Buffer.from('a027', 'hex'),
  disconnect: Buffer.from('802a', 'hex'),
  recordGameDvr: Buffer.from('a038', 'hex'),
  powerOff: Buffer.from('a039', 'hex'),
  mediaCommand: Buffer.from('af01', 'hex'),
  mediaCommandResult: Buffer.from('af02', 'hex'),
  mediaState: Buffer.from('af03', 'hex'),
  gamepad: Buffer.from('8f0a', 'hex'),
  powerOn: Buffer.from('dd02', 'hex'),
  discoveryRequest: Buffer.from('dd00', 'hex'),
  discoveryResponse: Buffer.from('dd01', 'hex'),
  connectRequest: Buffer.from('cc00', 'hex'),
  connectResponse: Buffer.from('cc01', 'hex'),
};

/** What the console answers to a connect request. */
export const CONNECT_RESULTS: Record<number, string> = {
  0: 'success',
  1: 'pending login, reconnect to complete',
  2: 'unknown',
  3: 'anonymous connections are disabled on the console',
  4: 'the device limit of the console is exceeded',
  5: 'remote connections are disabled on the console',
  6: 'user authentication failed',
  7: 'user sign-in failed',
  8: 'user sign-in timed out',
  9: 'user sign-in required',
};

/** What a SmartGlass client type number means. Only used in the log. */
export const LOCAL_CLIENT_TYPES: Record<number, string> = {
  1: 'Xbox One',
  2: 'Xbox 360',
  3: 'Windows Desktop',
  4: 'Windows Store',
  5: 'Windows Phone',
  6: 'iPhone',
  7: 'iPad',
  8: 'Android',
};

/** The media playback states the SmartGlass media channel reports. */
export const LOCAL_PLAYBACK_STATES: Record<number, string> = {
  0: 'Closed',
  1: 'Changing',
  2: 'Stopped',
  3: 'Playing',
  4: 'Paused',
};

/** The media kinds the SmartGlass media channel reports. */
export const LOCAL_MEDIA_TYPES: Record<number, string> = {
  0: 'No Media',
  1: 'Music',
  2: 'Video',
  3: 'Image',
  4: 'Conversation',
  5: 'Game',
};

/** How loud the SmartGlass media channel reports the console to be. */
export const LOCAL_SOUND_LEVELS: Record<number, string> = {
  0: 'Muted',
  1: 'Low',
  2: 'Full',
};

/** The gamepad keys the Web API accepts as an `InjectKey` key type. */
export const GAMEPAD_COMMANDS = ['nexus', 'view', 'menu', 'a', 'b', 'x', 'y', 'up', 'down', 'left', 'right'] as const;

/** The media keys the Web API accepts as an `InjectKey` key type. */
export const MEDIA_COMMANDS = [
  'play',
  'pause',
  'playPause',
  'stop',
  'record',
  'nextTrack',
  'prevTrack',
  'fastForward',
  'rewind',
  'channelUp',
  'channelDown',
  'back',
  'view',
  'menu',
  'seek',
] as const;

/** The three keys of the TV remote channel. */
export const TV_REMOTE_COMMANDS = ['volUp', 'volDown', 'volMute'] as const;

/** What the console itself can be told to do. */
export const CONSOLE_CONTROL_COMMANDS = ['reboot', 'recordGameDvr'] as const;

/**
 * The apps every console has.
 *
 * They are exposed whether or not the list is read from the console, exactly as
 * the Homebridge plugin does, so that a console reachable only over the local
 * protocol still has something to switch to.
 */
export const DefaultInputs = [
  {
    oneStoreProductId: 'Screensaver',
    titleId: '851275400',
    reference: SCREEN_SAVER_REFERENCE,
    isGame: false,
    name: 'Screensaver',
    contentType: 'Dashboard',
  },
  {
    oneStoreProductId: 'Dashboard',
    titleId: '750323071',
    reference: 'Xbox.Dashboard_8wekyb3d8bbwe!Xbox.Dashboard.Application',
    isGame: false,
    name: 'Dashboard',
    contentType: 'Dashboard',
  },
  {
    oneStoreProductId: 'Settings',
    titleId: '1837352387',
    reference: 'Microsoft.Xbox.Settings_8wekyb3d8bbwe!Xbox.Settings.Application',
    isGame: false,
    name: 'Settings',
    contentType: 'Dashboard',
  },
  {
    oneStoreProductId: 'Television',
    titleId: '371594669',
    reference: 'Microsoft.Xbox.LiveTV_8wekyb3d8bbwe!Microsoft.Xbox.LiveTV.Application',
    isGame: false,
    name: 'Television',
    contentType: 'systemApp',
  },
  {
    oneStoreProductId: 'SettingsTv',
    titleId: '2019308066',
    reference: 'Microsoft.Xbox.TvSettings_8wekyb3d8bbwe!Microsoft.Xbox.TvSettings.Application',
    isGame: false,
    name: 'Settings TV',
    contentType: 'Dashboard',
  },
  {
    oneStoreProductId: 'Accessory',
    titleId: '758407307',
    reference: 'Microsoft.XboxDevices_8wekyb3d8bbwe!App',
    isGame: false,
    name: 'Accessory',
    contentType: 'systemApp',
  },
  {
    oneStoreProductId: 'NetworkTroubleshooter',
    titleId: '1614319806',
    reference: 'Xbox.NetworkTroubleshooter_8wekyb3d8bbwe!Xbox.NetworkTroubleshooter.Application',
    isGame: false,
    name: 'Network Troubleshooter',
    contentType: 'systemApp',
  },
  {
    oneStoreProductId: 'MicrosoftStore',
    titleId: '1864271209',
    reference: 'Microsoft.storify_8wekyb3d8bbwe!App',
    isGame: false,
    name: 'Microsoft Store',
    contentType: 'Dashboard',
  },
  {
    oneStoreProductId: 'XboxGuide',
    titleId: '1052052983',
    reference: 'Xbox.Guide_8wekyb3d8bbwe!Xbox.Guide.Application',
    isGame: false,
    name: 'Xbox Guide',
    contentType: 'systemApp',
  },
] as const;

/**
 * The product ids that are not apps to be launched but shell destinations.
 *
 * Launching one of these by product id does nothing, so each is sent as the shell
 * command that actually gets there.
 */
export const SHELL_HOME_PRODUCT_IDS = ['Dashboard', 'Settings', 'SettingsTv', 'Accessory', 'Screensaver', 'NetworkTroubleshooter', 'MicrosoftStore'] as const;
