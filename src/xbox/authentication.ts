import type { AnsiLogger } from 'matterbridge/logger';

import { WEB_API_CLIENT_ID, WEB_API_SCOPES, WebApiUrls } from './constants.js';
import { errorMessage } from './utils.js';

/** How long a request to Microsoft may take, in milliseconds. */
const REQUEST_TIMEOUT_MS = 10_000;

/** What the Microsoft account service hands back for an authorization code or a refresh token. */
export interface OauthTokens {
  access_token: string;
  refresh_token: string;
  expires_in?: number;
  token_type?: string;
  scope?: string;
  user_id?: string;
  /** When the plugin received it, so that an expired one can be spotted. */
  issued?: string;
}

/** One of the two Xbox Live tokens, which look the same on the outside. */
export interface XboxLiveToken {
  Token: string;
  NotAfter: string;
  IssueInstant?: string;
  DisplayClaims?: {
    xui?: {
      /** The user hash, which the console pairs with the token. */
      uhs?: string;
      /** The Xbox user id. */
      xid?: string;
      /** The gamertag. */
      gtg?: string;
    }[];
  };
}

/** Everything the plugin keeps between restarts to stay authorized. */
export interface XboxTokens {
  oauth: Partial<OauthTokens>;
  user: Partial<XboxLiveToken>;
  xsts: Partial<XboxLiveToken>;
}

/** Where the tokens are kept between restarts. */
export interface TokenStorage {
  /**
   * @template T The stored type.
   * @param {string} key The storage key.
   * @returns {Promise<T | undefined>} The stored value, or `undefined` when nothing was stored.
   */
  read<T>(key: string): Promise<T | undefined>;
  /**
   * @template T The stored type.
   * @param {string} key The storage key.
   * @param {T} value The value to store.
   * @returns {Promise<void>} Resolves once the value is durable.
   */
  write<T>(key: string, value: T): Promise<void>;
}

/** What the authentication needs. */
export interface AuthenticationOptions {
  /** The console name, for the log. */
  name: string;
  /** The OAuth client to authenticate as, or the built-in one. */
  clientId?: string;
  /** The client secret, for a client registered as confidential. */
  clientSecret?: string;
  /** The storage key the tokens live under. */
  storageKey: string;
  storage: TokenStorage;
  log: AnsiLogger;
}

/** What an authorized plugin hands to the Web API and to the local protocol. */
export interface Authorization {
  /** The `Authorization` header value. */
  header: string;
  /** The user hash the console pairs the token with. */
  userHash: string;
  /** The XSTS token itself. */
  token: string;
  /** The Xbox user id, which the media state endpoint is addressed by. */
  xuid: string;
}

/**
 * The Xbox Live authorization of one console.
 *
 * Reaching a console through Microsoft takes three tokens, each obtained with the
 * one before it: a Microsoft account token, an Xbox Live user token, and an XSTS
 * token, which is the one the service and the console accept. Only the first has
 * to be obtained with the user present — after that its refresh token keeps the
 * chain going, which is why all three are kept in the Matterbridge storage rather
 * than being asked for again.
 */
export class XboxAuthentication {
  private readonly log: AnsiLogger;
  private readonly name: string;
  private readonly clientId: string;
  private readonly clientSecret?: string;
  private readonly storage: TokenStorage;
  private readonly storageKey: string;

  private tokens: XboxTokens = { oauth: {}, user: {}, xsts: {} };
  private loaded = false;

  constructor(options: AuthenticationOptions) {
    this.name = options.name;
    this.clientId = options.clientId?.trim() || WEB_API_CLIENT_ID;
    this.clientSecret = options.clientSecret?.trim() || undefined;
    this.storage = options.storage;
    this.storageKey = options.storageKey;
    this.log = options.log;
  }

  /** @returns {boolean} Whether a refresh token is on hand, so authorizing needs no user. */
  get hasRefreshToken(): boolean {
    return Boolean(this.tokens.oauth.refresh_token);
  }

  /**
   * Reads the tokens out of the storage.
   *
   * @returns {Promise<void>} Resolves once the tokens are on hand.
   */
  async load(): Promise<void> {
    if (this.loaded) return;
    const stored = await this.storage.read<XboxTokens>(this.storageKey);
    if (stored) this.tokens = { oauth: stored.oauth ?? {}, user: stored.user ?? {}, xsts: stored.xsts ?? {} };
    this.loaded = true;
  }

  /**
   * @returns {string} The address the user has to open to grant the plugin access to their account.
   */
  authorizationUrl(): string {
    const params = new URLSearchParams({
      client_id: this.clientId,
      response_type: 'code',
      approval_prompt: 'auto',
      scope: WEB_API_SCOPES,
      redirect_uri: WebApiUrls.Redirect,
    });
    return `${WebApiUrls.Oauth2}?${params.toString()}`;
  }

  /**
   * Exchanges the authorization code the user pasted into the configuration for the token chain.
   *
   * A code can be used once and expires within minutes, so this only ever runs
   * when there is no refresh token yet.
   *
   * @param {string} code The code, or the whole callback address it was part of.
   * @returns {Promise<void>} Resolves once the tokens are stored.
   * @throws {Error} When Microsoft refuses the code.
   */
  async exchangeCode(code: string): Promise<void> {
    const value = extractCode(code);

    const oauth = await this.post<OauthTokens>(
      WebApiUrls.AccessToken,
      new URLSearchParams({
        client_id: this.clientId,
        grant_type: 'authorization_code',
        scope: WEB_API_SCOPES,
        code: value,
        redirect_uri: WebApiUrls.Redirect,
        ...(this.clientSecret ? { client_secret: this.clientSecret } : {}),
      }),
    );

    this.tokens = { oauth: { ...oauth, issued: new Date().toISOString() }, user: {}, xsts: {} };
    await this.save();
    this.log.info(`${this.name} | the authorization code was accepted; the plugin can now reach the console through Microsoft`);
  }

  /**
   * Takes over a token chain obtained elsewhere, which is how a Homebridge installation is migrated.
   *
   * @param {XboxTokens} tokens The tokens, as the `homebridge-xbox-tv` plugin writes them.
   * @returns {Promise<void>} Resolves once the tokens are stored.
   * @throws {Error} When they carry no refresh token, which is the only part that cannot be obtained again.
   */
  async importTokens(tokens: XboxTokens): Promise<void> {
    if (!tokens.oauth?.refresh_token) throw new Error('the imported tokens carry no refresh token');

    this.tokens = { oauth: tokens.oauth, user: tokens.user ?? {}, xsts: tokens.xsts ?? {} };
    await this.save();
    this.log.info(`${this.name} | imported an existing Xbox Live token chain`);
  }

  /**
   * Makes sure the XSTS token is valid, obtaining or refreshing whatever is needed.
   *
   * @returns {Promise<Authorization>} What to authenticate the Web API and the local protocol with.
   * @throws {Error} When there is no refresh token, or Microsoft refuses one of the steps.
   */
  async authorize(): Promise<Authorization> {
    await this.load();

    if (!this.tokens.oauth.refresh_token) {
      throw new Error('the plugin is not authorized yet; put the authorization code into "webApi.token" or import an existing token file');
    }

    let refreshed = false;

    if (!this.tokens.user.Token || expired(this.tokens.user.NotAfter)) {
      // The Microsoft token is refreshed together with the user token: they
      // expire on the same kind of schedule, and a user token cannot be obtained
      // from a stale access token.
      await this.refreshOauth();
      await this.obtainUserToken();
      refreshed = true;
    }

    if (!this.tokens.xsts.Token || expired(this.tokens.xsts.NotAfter)) {
      await this.obtainXstsToken();
      refreshed = true;
    }

    // Only a refresh is worth a storage write: authorizing happens before every
    // request, and most of those find both tokens still valid.
    if (refreshed) await this.save();

    const claims = this.tokens.xsts.DisplayClaims?.xui?.[0];
    const userHash = claims?.uhs;
    const token = this.tokens.xsts.Token;
    if (!userHash || !token) throw new Error('the XSTS token carries no user hash');

    return { header: `XBL3.0 x=${userHash};${token}`, userHash, token, xuid: claims.xid ?? '' };
  }

  /**
   * @returns {{ userHash: string; token: string } | undefined} The credentials a local session can be opened with, when there are any.
   */
  credentials(): { userHash: string; token: string } | undefined {
    const userHash = this.tokens.xsts.DisplayClaims?.xui?.[0]?.uhs;
    const token = this.tokens.xsts.Token;
    if (!userHash || !token || expired(this.tokens.xsts.NotAfter)) return undefined;
    return { userHash, token };
  }

  /** @returns {string} The gamertag of the authorized account, or `''` when it is not known. */
  get gamertag(): string {
    return this.tokens.xsts.DisplayClaims?.xui?.[0]?.gtg ?? '';
  }

  // --- steps ----------------------------------------------------------------

  /**
   * Exchanges the refresh token for a fresh Microsoft access token.
   *
   * @returns {Promise<void>} Resolves once the new token is on hand.
   */
  private async refreshOauth(): Promise<void> {
    const oauth = await this.post<OauthTokens>(
      WebApiUrls.RefreshToken,
      new URLSearchParams({
        client_id: this.clientId,
        grant_type: 'refresh_token',
        scope: WEB_API_SCOPES,
        refresh_token: this.tokens.oauth.refresh_token ?? '',
        ...(this.clientSecret ? { client_secret: this.clientSecret } : {}),
      }),
    );

    this.tokens.oauth = { ...oauth, issued: new Date().toISOString() };
    this.log.debug(`${this.name} | refreshed the Microsoft account token`);
  }

  /**
   * Exchanges the Microsoft access token for an Xbox Live user token.
   *
   * @returns {Promise<void>} Resolves once the new token is on hand.
   */
  private async obtainUserToken(): Promise<void> {
    const user = await this.postJson<XboxLiveToken>(WebApiUrls.UserToken, {
      RelyingParty: 'http://auth.xboxlive.com',
      TokenType: 'JWT',
      Properties: {
        AuthMethod: 'RPS',
        SiteName: 'user.auth.xboxlive.com',
        RpsTicket: `d=${this.tokens.oauth.access_token ?? ''}`,
      },
    });

    this.tokens.user = user;
    // A new user token invalidates the XSTS token that was derived from the old one.
    this.tokens.xsts = {};
    this.log.debug(`${this.name} | obtained an Xbox Live user token`);
  }

  /**
   * Exchanges the user token for the XSTS token, which is the one that opens doors.
   *
   * @returns {Promise<void>} Resolves once the new token is on hand.
   */
  private async obtainXstsToken(): Promise<void> {
    const xsts = await this.postJson<XboxLiveToken>(
      WebApiUrls.XstsToken,
      {
        RelyingParty: 'http://xboxlive.com',
        TokenType: 'JWT',
        Properties: { UserTokens: [this.tokens.user.Token ?? ''], SandboxId: 'RETAIL' },
      },
      { 'x-xbl-contract-version': '1' },
    );

    this.tokens.xsts = xsts;
    this.log.debug(`${this.name} | obtained an XSTS token${this.gamertag ? ` for ${this.gamertag}` : ''}`);
  }

  /**
   * Stores the token chain.
   *
   * @returns {Promise<void>} Resolves once it is durable.
   */
  private async save(): Promise<void> {
    await this.storage.write(this.storageKey, this.tokens);
  }

  /**
   * Posts a form to the Microsoft account service.
   *
   * @template T The expected answer.
   * @param {string} url Where to post.
   * @param {URLSearchParams} body The form.
   * @returns {Promise<T>} The answer.
   * @throws {Error} When the service answers with anything but success.
   */
  private async post<T>(url: string, body: URLSearchParams): Promise<T> {
    return this.request<T>(url, body.toString(), { 'Content-Type': 'application/x-www-form-urlencoded' });
  }

  /**
   * Posts a JSON document to one of the Xbox Live token services.
   *
   * @template T The expected answer.
   * @param {string} url Where to post.
   * @param {unknown} body The document.
   * @param {Record<string, string>} [headers] Any headers beyond the content type.
   * @returns {Promise<T>} The answer.
   * @throws {Error} When the service answers with anything but success.
   */
  private async postJson<T>(url: string, body: unknown, headers: Record<string, string> = {}): Promise<T> {
    return this.request<T>(url, JSON.stringify(body), { 'Content-Type': 'application/json', ...headers });
  }

  /**
   * Posts one request and reads the answer.
   *
   * @template T The expected answer.
   * @param {string} url Where to post.
   * @param {string} body The body.
   * @param {Record<string, string>} headers The headers.
   * @returns {Promise<T>} The answer.
   * @throws {Error} When the request fails or the service refuses it.
   */
  private async request<T>(url: string, body: string, headers: Record<string, string>): Promise<T> {
    let response: Response;
    try {
      response = await fetch(url, { method: 'POST', headers, body, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    } catch (error) {
      throw new Error(`${new URL(url).host} could not be reached: ${errorMessage(error)}`);
    }

    const text = await response.text();
    if (!response.ok) {
      throw new Error(`${new URL(url).host} refused the request with ${response.status}: ${describe(text)}`);
    }

    try {
      return JSON.parse(text) as T;
    } catch {
      throw new Error(`${new URL(url).host} answered with something that is not JSON`);
    }
  }
}

/**
 * Reads the authorization code out of whatever the user pasted.
 *
 * The code arrives as a query parameter of a page that does not exist, so the
 * whole address is what a user has to hand — and it is percent encoded there.
 *
 * @param {string} value The code or the callback address.
 * @returns {string} The code.
 */
function extractCode(value: string): string {
  let code = value.trim();

  if (code.includes('code=')) {
    try {
      code = new URL(code).searchParams.get('code') ?? code;
    } catch {
      code = code.slice(code.indexOf('code=') + 5).split('&')[0];
    }
  }

  try {
    return decodeURIComponent(code);
  } catch {
    return code;
  }
}

/**
 * @param {string | undefined} notAfter When the token stops being valid.
 * @returns {boolean} Whether it already has, counting a missing date as expired.
 */
function expired(notAfter: string | undefined): boolean {
  if (!notAfter) return true;
  const deadline = new Date(notAfter).getTime();
  return Number.isNaN(deadline) || Date.now() >= deadline;
}

/**
 * Shortens an error body for the log, and keeps the interesting part of a Microsoft one.
 *
 * @param {string} text The body as it arrived.
 * @returns {string} Something worth logging.
 */
function describe(text: string): string {
  try {
    const parsed = JSON.parse(text) as { error_description?: string; error?: string; Message?: string; XErr?: number };
    return parsed.error_description ?? parsed.error ?? parsed.Message ?? (parsed.XErr ? `XErr ${parsed.XErr}` : text.slice(0, 200));
  } catch {
    return text.slice(0, 200);
  }
}
