import { bridgedNode, contactSensor, dimmableLight, fan, MatterbridgeEndpoint, occupancySensor, onOffLight, onOffPlugInUnit, powerSource } from 'matterbridge';

import type { SwitchStyle } from '../config.js';
import type { ConsoleInfo } from '../xbox/types.js';

/** The Matter vendor id used for the bridged devices of this plugin. */
export const VENDOR_ID = 0xfff1;

/** The vendor name shown in the controller app. */
export const VENDOR_NAME = 'Microsoft';

/** The plugin URL shown in the controller app. */
export const PRODUCT_URL = 'https://github.com/lirik44/matterbridge-xbox-tv';

/** The identity written into the bridged device information cluster. */
export interface EndpointIdentity {
  /** The name shown in the controller app. */
  name: string;
  /** The Matter serial number, unique across the bridge. */
  serial: string;
  /** What the console reports about itself. */
  info: ConsoleInfo;
  debug: boolean;
}

/**
 * Creates a bridged endpoint carrying the identity of a console.
 *
 * Every function of the console is its own bridged device rather than a child
 * endpoint: Apple Home does not render the child endpoints of a composed device,
 * so a game hidden inside the power outlet would be unreachable.
 *
 * @param {ConstructorParameters<typeof MatterbridgeEndpoint>[0]} deviceTypes The Matter device types of the endpoint.
 * @param {EndpointIdentity} identity The identity to write into the endpoint.
 * @returns {MatterbridgeEndpoint} The created endpoint, without its function clusters.
 */
export function createBridgedEndpoint(deviceTypes: ConstructorParameters<typeof MatterbridgeEndpoint>[0], identity: EndpointIdentity): MatterbridgeEndpoint {
  const { name, serial, info, debug } = identity;

  const endpoint = new MatterbridgeEndpoint(deviceTypes, { id: `xbox-${serial}` }, debug)
    .createDefaultBridgedDeviceBasicInformationClusterServer(name, serial, VENDOR_ID, VENDOR_NAME, info.modelName, undefined, info.firmwareRevision || undefined)
    .createDefaultPowerSourceWiredClusterServer();

  endpoint.productUrl = PRODUCT_URL;
  endpoint.hardwareVersionString = info.modelName;

  return endpoint;
}

/** The device types every bridged endpoint of this plugin carries in addition to its own. */
export const BRIDGED = [bridgedNode, powerSource] as const;

/**
 * Creates an on/off endpoint in the requested style.
 *
 * @param {SwitchStyle} style Whether the endpoint presents itself as an outlet or as a light.
 * @param {EndpointIdentity} identity The identity to write into the endpoint.
 * @param {boolean} [on] The initial state.
 * @returns {MatterbridgeEndpoint} The endpoint, ready for its command handlers.
 */
export function createSwitchEndpoint(style: SwitchStyle, identity: EndpointIdentity, on = false): MatterbridgeEndpoint {
  const deviceType = style === 'light' ? onOffLight : onOffPlugInUnit;
  return createBridgedEndpoint([deviceType, ...BRIDGED], identity)
    .createDefaultIdentifyClusterServer()
    .createDefaultOnOffClusterServer(on)
    .addRequiredClusterServers();
}

/**
 * Creates a dimmer endpoint, which is what the volume looks like by default.
 *
 * A dimmable light is what every controller renders with a usable slider — a
 * dimmable outlet is shown without one in Apple Home.
 *
 * @param {EndpointIdentity} identity The identity to write into the endpoint.
 * @param {boolean} on The initial state.
 * @param {number} level The initial Matter level, `1..254`.
 * @returns {MatterbridgeEndpoint} The endpoint, ready for its command handlers.
 */
export function createDimmerEndpoint(identity: EndpointIdentity, on: boolean, level: number): MatterbridgeEndpoint {
  return createBridgedEndpoint([dimmableLight, ...BRIDGED], identity)
    .createDefaultIdentifyClusterServer()
    .createDefaultOnOffClusterServer(on)
    .createDefaultLevelControlClusterServer(level)
    .addRequiredClusterServers();
}

/**
 * Creates a fan endpoint, the alternative presentation of the volume.
 *
 * A volume that looks like a light is caught by "turn off all the lights", which
 * is exactly what a fan avoids.
 *
 * @param {EndpointIdentity} identity The identity to write into the endpoint.
 * @param {boolean} on The initial state.
 * @param {number} percent The initial volume, `0..100`.
 * @returns {MatterbridgeEndpoint} The endpoint, ready for its command handlers.
 */
export function createFanEndpoint(identity: EndpointIdentity, on: boolean, percent: number): MatterbridgeEndpoint {
  return createBridgedEndpoint([fan, ...BRIDGED], identity)
    .createDefaultIdentifyClusterServer()
    .createDefaultOnOffClusterServer(on)
    .createDefaultFanControlClusterServer(undefined, undefined, percent, percent)
    .addRequiredClusterServers();
}

/**
 * Creates a sensor endpoint.
 *
 * @param {'occupancy' | 'contact'} style Which sensor to create.
 * @param {EndpointIdentity} identity The identity to write into the endpoint.
 * @returns {MatterbridgeEndpoint} The endpoint, reporting nothing yet.
 */
export function createSensorEndpoint(style: 'occupancy' | 'contact', identity: EndpointIdentity): MatterbridgeEndpoint {
  const endpoint = createBridgedEndpoint([style === 'contact' ? contactSensor : occupancySensor, ...BRIDGED], identity).createDefaultIdentifyClusterServer();

  // A contact sensor reads "closed" when nothing is going on, and opens when the
  // watched condition holds — which is how the Homebridge plugin drove it too.
  if (style === 'contact') endpoint.createDefaultBooleanStateClusterServer(true);
  else endpoint.createDefaultOccupancySensingClusterServer(false);

  return endpoint.addRequiredClusterServers();
}
