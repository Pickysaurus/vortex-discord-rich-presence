/******/ (() => { // webpackBootstrap
/******/ 	var __webpack_modules__ = ({

/***/ "./node_modules/discord-rpc/src/client.js"
/*!************************************************!*\
  !*** ./node_modules/discord-rpc/src/client.js ***!
  \************************************************/
(module, __unused_webpack_exports, __webpack_require__) {

"use strict";


const EventEmitter = __webpack_require__(/*! events */ "events");
const { setTimeout, clearTimeout } = __webpack_require__(/*! timers */ "timers");
const fetch = __webpack_require__(/*! node-fetch */ "./node_modules/node-fetch/browser.js");
const transports = __webpack_require__(/*! ./transports */ "./node_modules/discord-rpc/src/transports/index.js");
const { RPCCommands, RPCEvents, RelationshipTypes } = __webpack_require__(/*! ./constants */ "./node_modules/discord-rpc/src/constants.js");
const { pid: getPid, uuid } = __webpack_require__(/*! ./util */ "./node_modules/discord-rpc/src/util.js");

function subKey(event, args) {
  return `${event}${JSON.stringify(args)}`;
}

/**
 * @typedef {RPCClientOptions}
 * @extends {ClientOptions}
 * @prop {string} transport RPC transport. one of `ipc` or `websocket`
 */

/**
 * The main hub for interacting with Discord RPC
 * @extends {BaseClient}
 */
class RPCClient extends EventEmitter {
  /**
   * @param {RPCClientOptions} [options] Options for the client.
   * You must provide a transport
   */
  constructor(options = {}) {
    super();

    this.options = options;

    this.accessToken = null;
    this.clientId = null;

    /**
     * Application used in this client
     * @type {?ClientApplication}
     */
    this.application = null;

    /**
     * User used in this application
     * @type {?User}
     */
    this.user = null;

    const Transport = transports[options.transport];
    if (!Transport) {
      throw new TypeError('RPC_INVALID_TRANSPORT', options.transport);
    }

    this.fetch = (method, path, { data, query } = {}) =>
      fetch(`${this.fetch.endpoint}${path}${query ? new URLSearchParams(query) : ''}`, {
        method,
        body: data,
        headers: {
          Authorization: `Bearer ${this.accessToken}`,
        },
      }).then(async (r) => {
        const body = await r.json();
        if (!r.ok) {
          const e = new Error(r.status);
          e.body = body;
          throw e;
        }
        return body;
      });

    this.fetch.endpoint = 'https://discord.com/api';

    /**
     * Raw transport userd
     * @type {RPCTransport}
     * @private
     */
    this.transport = new Transport(this);
    this.transport.on('message', this._onRpcMessage.bind(this));

    /**
     * Map of nonces being expected from the transport
     * @type {Map}
     * @private
     */
    this._expecting = new Map();

    this._connectPromise = undefined;
  }

  /**
   * Search and connect to RPC
   */
  connect(clientId) {
    if (this._connectPromise) {
      return this._connectPromise;
    }
    this._connectPromise = new Promise((resolve, reject) => {
      this.clientId = clientId;
      const timeout = setTimeout(() => reject(new Error('RPC_CONNECTION_TIMEOUT')), 10e3);
      timeout.unref();
      this.once('connected', () => {
        clearTimeout(timeout);
        resolve(this);
      });
      this.transport.once('close', () => {
        this._expecting.forEach((e) => {
          e.reject(new Error('connection closed'));
        });
        this.emit('disconnected');
        reject(new Error('connection closed'));
      });
      this.transport.connect().catch(reject);
    });
    return this._connectPromise;
  }

  /**
   * @typedef {RPCLoginOptions}
   * @param {string} clientId Client ID
   * @param {string} [clientSecret] Client secret
   * @param {string} [accessToken] Access token
   * @param {string} [rpcToken] RPC token
   * @param {string} [tokenEndpoint] Token endpoint
   * @param {string[]} [scopes] Scopes to authorize with
   */

  /**
   * Performs authentication flow. Automatically calls Client#connect if needed.
   * @param {RPCLoginOptions} options Options for authentication.
   * At least one property must be provided to perform login.
   * @example client.login({ clientId: '1234567', clientSecret: 'abcdef123' });
   * @returns {Promise<RPCClient>}
   */
  async login(options = {}) {
    let { clientId, accessToken } = options;
    await this.connect(clientId);
    if (!options.scopes) {
      this.emit('ready');
      return this;
    }
    if (!accessToken) {
      accessToken = await this.authorize(options);
    }
    return this.authenticate(accessToken);
  }

  /**
   * Request
   * @param {string} cmd Command
   * @param {Object} [args={}] Arguments
   * @param {string} [evt] Event
   * @returns {Promise}
   * @private
   */
  request(cmd, args, evt) {
    return new Promise((resolve, reject) => {
      const nonce = uuid();
      this.transport.send({ cmd, args, evt, nonce });
      this._expecting.set(nonce, { resolve, reject });
    });
  }

  /**
   * Message handler
   * @param {Object} message message
   * @private
   */
  _onRpcMessage(message) {
    if (message.cmd === RPCCommands.DISPATCH && message.evt === RPCEvents.READY) {
      if (message.data.user) {
        this.user = message.data.user;
      }
      this.emit('connected');
    } else if (this._expecting.has(message.nonce)) {
      const { resolve, reject } = this._expecting.get(message.nonce);
      if (message.evt === 'ERROR') {
        const e = new Error(message.data.message);
        e.code = message.data.code;
        e.data = message.data;
        reject(e);
      } else {
        resolve(message.data);
      }
      this._expecting.delete(message.nonce);
    } else {
      this.emit(message.evt, message.data);
    }
  }

  /**
   * Authorize
   * @param {Object} options options
   * @returns {Promise}
   * @private
   */
  async authorize({ scopes, clientSecret, rpcToken, redirectUri, prompt } = {}) {
    if (clientSecret && rpcToken === true) {
      const body = await this.fetch('POST', '/oauth2/token/rpc', {
        data: new URLSearchParams({
          client_id: this.clientId,
          client_secret: clientSecret,
        }),
      });
      rpcToken = body.rpc_token;
    }

    const { code } = await this.request('AUTHORIZE', {
      scopes,
      client_id: this.clientId,
      prompt,
      rpc_token: rpcToken,
    });

    const response = await this.fetch('POST', '/oauth2/token', {
      data: new URLSearchParams({
        client_id: this.clientId,
        client_secret: clientSecret,
        code,
        grant_type: 'authorization_code',
        redirect_uri: redirectUri,
      }),
    });

    return response.access_token;
  }

  /**
   * Authenticate
   * @param {string} accessToken access token
   * @returns {Promise}
   * @private
   */
  authenticate(accessToken) {
    return this.request('AUTHENTICATE', { access_token: accessToken })
      .then(({ application, user }) => {
        this.accessToken = accessToken;
        this.application = application;
        this.user = user;
        this.emit('ready');
        return this;
      });
  }


  /**
   * Fetch a guild
   * @param {Snowflake} id Guild ID
   * @param {number} [timeout] Timeout request
   * @returns {Promise<Guild>}
   */
  getGuild(id, timeout) {
    return this.request(RPCCommands.GET_GUILD, { guild_id: id, timeout });
  }

  /**
   * Fetch all guilds
   * @param {number} [timeout] Timeout request
   * @returns {Promise<Collection<Snowflake, Guild>>}
   */
  getGuilds(timeout) {
    return this.request(RPCCommands.GET_GUILDS, { timeout });
  }

  /**
   * Get a channel
   * @param {Snowflake} id Channel ID
   * @param {number} [timeout] Timeout request
   * @returns {Promise<Channel>}
   */
  getChannel(id, timeout) {
    return this.request(RPCCommands.GET_CHANNEL, { channel_id: id, timeout });
  }

  /**
   * Get all channels
   * @param {Snowflake} [id] Guild ID
   * @param {number} [timeout] Timeout request
   * @returns {Promise<Collection<Snowflake, Channel>>}
   */
  async getChannels(id, timeout) {
    const { channels } = await this.request(RPCCommands.GET_CHANNELS, {
      timeout,
      guild_id: id,
    });
    return channels;
  }

  /**
   * @typedef {CertifiedDevice}
   * @prop {string} type One of `AUDIO_INPUT`, `AUDIO_OUTPUT`, `VIDEO_INPUT`
   * @prop {string} uuid This device's Windows UUID
   * @prop {object} vendor Vendor information
   * @prop {string} vendor.name Vendor's name
   * @prop {string} vendor.url Vendor's url
   * @prop {object} model Model information
   * @prop {string} model.name Model's name
   * @prop {string} model.url Model's url
   * @prop {string[]} related Array of related product's Windows UUIDs
   * @prop {boolean} echoCancellation If the device has echo cancellation
   * @prop {boolean} noiseSuppression If the device has noise suppression
   * @prop {boolean} automaticGainControl If the device has automatic gain control
   * @prop {boolean} hardwareMute If the device has a hardware mute
   */

  /**
   * Tell discord which devices are certified
   * @param {CertifiedDevice[]} devices Certified devices to send to discord
   * @returns {Promise}
   */
  setCertifiedDevices(devices) {
    return this.request(RPCCommands.SET_CERTIFIED_DEVICES, {
      devices: devices.map((d) => ({
        type: d.type,
        id: d.uuid,
        vendor: d.vendor,
        model: d.model,
        related: d.related,
        echo_cancellation: d.echoCancellation,
        noise_suppression: d.noiseSuppression,
        automatic_gain_control: d.automaticGainControl,
        hardware_mute: d.hardwareMute,
      })),
    });
  }

  /**
   * @typedef {UserVoiceSettings}
   * @prop {Snowflake} id ID of the user these settings apply to
   * @prop {?Object} [pan] Pan settings, an object with `left` and `right` set between
   * 0.0 and 1.0, inclusive
   * @prop {?number} [volume=100] The volume
   * @prop {bool} [mute] If the user is muted
   */

  /**
   * Set the voice settings for a user, by id
   * @param {Snowflake} id ID of the user to set
   * @param {UserVoiceSettings} settings Settings
   * @returns {Promise}
   */
  setUserVoiceSettings(id, settings) {
    return this.request(RPCCommands.SET_USER_VOICE_SETTINGS, {
      user_id: id,
      pan: settings.pan,
      mute: settings.mute,
      volume: settings.volume,
    });
  }

  /**
   * Move the user to a voice channel
   * @param {Snowflake} id ID of the voice channel
   * @param {Object} [options] Options
   * @param {number} [options.timeout] Timeout for the command
   * @param {boolean} [options.force] Force this move. This should only be done if you
   * have explicit permission from the user.
   * @returns {Promise}
   */
  selectVoiceChannel(id, { timeout, force = false } = {}) {
    return this.request(RPCCommands.SELECT_VOICE_CHANNEL, { channel_id: id, timeout, force });
  }

  /**
   * Move the user to a text channel
   * @param {Snowflake} id ID of the voice channel
   * @param {Object} [options] Options
   * @param {number} [options.timeout] Timeout for the command
   * have explicit permission from the user.
   * @returns {Promise}
   */
  selectTextChannel(id, { timeout } = {}) {
    return this.request(RPCCommands.SELECT_TEXT_CHANNEL, { channel_id: id, timeout });
  }

  /**
   * Get current voice settings
   * @returns {Promise}
   */
  getVoiceSettings() {
    return this.request(RPCCommands.GET_VOICE_SETTINGS)
      .then((s) => ({
        automaticGainControl: s.automatic_gain_control,
        echoCancellation: s.echo_cancellation,
        noiseSuppression: s.noise_suppression,
        qos: s.qos,
        silenceWarning: s.silence_warning,
        deaf: s.deaf,
        mute: s.mute,
        input: {
          availableDevices: s.input.available_devices,
          device: s.input.device_id,
          volume: s.input.volume,
        },
        output: {
          availableDevices: s.output.available_devices,
          device: s.output.device_id,
          volume: s.output.volume,
        },
        mode: {
          type: s.mode.type,
          autoThreshold: s.mode.auto_threshold,
          threshold: s.mode.threshold,
          shortcut: s.mode.shortcut,
          delay: s.mode.delay,
        },
      }));
  }

  /**
   * Set current voice settings, overriding the current settings until this session disconnects.
   * This also locks the settings for any other rpc sessions which may be connected.
   * @param {Object} args Settings
   * @returns {Promise}
   */
  setVoiceSettings(args) {
    return this.request(RPCCommands.SET_VOICE_SETTINGS, {
      automatic_gain_control: args.automaticGainControl,
      echo_cancellation: args.echoCancellation,
      noise_suppression: args.noiseSuppression,
      qos: args.qos,
      silence_warning: args.silenceWarning,
      deaf: args.deaf,
      mute: args.mute,
      input: args.input ? {
        device_id: args.input.device,
        volume: args.input.volume,
      } : undefined,
      output: args.output ? {
        device_id: args.output.device,
        volume: args.output.volume,
      } : undefined,
      mode: args.mode ? {
        type: args.mode.type,
        auto_threshold: args.mode.autoThreshold,
        threshold: args.mode.threshold,
        shortcut: args.mode.shortcut,
        delay: args.mode.delay,
      } : undefined,
    });
  }

  /**
   * Capture a shortcut using the client
   * The callback takes (key, stop) where `stop` is a function that will stop capturing.
   * This `stop` function must be called before disconnecting or else the user will have
   * to restart their client.
   * @param {Function} callback Callback handling keys
   * @returns {Promise<Function>}
   */
  captureShortcut(callback) {
    const subid = subKey(RPCEvents.CAPTURE_SHORTCUT_CHANGE);
    const stop = () => {
      this._subscriptions.delete(subid);
      return this.request(RPCCommands.CAPTURE_SHORTCUT, { action: 'STOP' });
    };
    this._subscriptions.set(subid, ({ shortcut }) => {
      callback(shortcut, stop);
    });
    return this.request(RPCCommands.CAPTURE_SHORTCUT, { action: 'START' })
      .then(() => stop);
  }

  /**
   * Sets the presence for the logged in user.
   * @param {object} args The rich presence to pass.
   * @param {number} [pid] The application's process ID. Defaults to the executing process' PID.
   * @returns {Promise}
   */
  setActivity(args = {}, pid = getPid()) {
    let timestamps;
    let assets;
    let party;
    let secrets;
    if (args.startTimestamp || args.endTimestamp) {
      timestamps = {
        start: args.startTimestamp,
        end: args.endTimestamp,
      };
      if (timestamps.start instanceof Date) {
        timestamps.start = Math.round(timestamps.start.getTime());
      }
      if (timestamps.end instanceof Date) {
        timestamps.end = Math.round(timestamps.end.getTime());
      }
      if (timestamps.start > 2147483647000) {
        throw new RangeError('timestamps.start must fit into a unix timestamp');
      }
      if (timestamps.end > 2147483647000) {
        throw new RangeError('timestamps.end must fit into a unix timestamp');
      }
    }
    if (
      args.largeImageKey || args.largeImageText
      || args.smallImageKey || args.smallImageText
    ) {
      assets = {
        large_image: args.largeImageKey,
        large_text: args.largeImageText,
        small_image: args.smallImageKey,
        small_text: args.smallImageText,
      };
    }
    if (args.partySize || args.partyId || args.partyMax) {
      party = { id: args.partyId };
      if (args.partySize || args.partyMax) {
        party.size = [args.partySize, args.partyMax];
      }
    }
    if (args.matchSecret || args.joinSecret || args.spectateSecret) {
      secrets = {
        match: args.matchSecret,
        join: args.joinSecret,
        spectate: args.spectateSecret,
      };
    }

    return this.request(RPCCommands.SET_ACTIVITY, {
      pid,
      activity: {
        state: args.state,
        details: args.details,
        timestamps,
        assets,
        party,
        secrets,
        buttons: args.buttons,
        instance: !!args.instance,
      },
    });
  }

  /**
   * Clears the currently set presence, if any. This will hide the "Playing X" message
   * displayed below the user's name.
   * @param {number} [pid] The application's process ID. Defaults to the executing process' PID.
   * @returns {Promise}
   */
  clearActivity(pid = getPid()) {
    return this.request(RPCCommands.SET_ACTIVITY, {
      pid,
    });
  }

  /**
   * Invite a user to join the game the RPC user is currently playing
   * @param {User} user The user to invite
   * @returns {Promise}
   */
  sendJoinInvite(user) {
    return this.request(RPCCommands.SEND_ACTIVITY_JOIN_INVITE, {
      user_id: user.id || user,
    });
  }

  /**
   * Request to join the game the user is playing
   * @param {User} user The user whose game you want to request to join
   * @returns {Promise}
   */
  sendJoinRequest(user) {
    return this.request(RPCCommands.SEND_ACTIVITY_JOIN_REQUEST, {
      user_id: user.id || user,
    });
  }

  /**
   * Reject a join request from a user
   * @param {User} user The user whose request you wish to reject
   * @returns {Promise}
   */
  closeJoinRequest(user) {
    return this.request(RPCCommands.CLOSE_ACTIVITY_JOIN_REQUEST, {
      user_id: user.id || user,
    });
  }

  createLobby(type, capacity, metadata) {
    return this.request(RPCCommands.CREATE_LOBBY, {
      type,
      capacity,
      metadata,
    });
  }

  updateLobby(lobby, { type, owner, capacity, metadata } = {}) {
    return this.request(RPCCommands.UPDATE_LOBBY, {
      id: lobby.id || lobby,
      type,
      owner_id: (owner && owner.id) || owner,
      capacity,
      metadata,
    });
  }

  deleteLobby(lobby) {
    return this.request(RPCCommands.DELETE_LOBBY, {
      id: lobby.id || lobby,
    });
  }

  connectToLobby(id, secret) {
    return this.request(RPCCommands.CONNECT_TO_LOBBY, {
      id,
      secret,
    });
  }

  sendToLobby(lobby, data) {
    return this.request(RPCCommands.SEND_TO_LOBBY, {
      id: lobby.id || lobby,
      data,
    });
  }

  disconnectFromLobby(lobby) {
    return this.request(RPCCommands.DISCONNECT_FROM_LOBBY, {
      id: lobby.id || lobby,
    });
  }

  updateLobbyMember(lobby, user, metadata) {
    return this.request(RPCCommands.UPDATE_LOBBY_MEMBER, {
      lobby_id: lobby.id || lobby,
      user_id: user.id || user,
      metadata,
    });
  }

  getRelationships() {
    const types = Object.keys(RelationshipTypes);
    return this.request(RPCCommands.GET_RELATIONSHIPS)
      .then((o) => o.relationships.map((r) => ({
        ...r,
        type: types[r.type],
      })));
  }

  /**
   * Subscribe to an event
   * @param {string} event Name of event e.g. `MESSAGE_CREATE`
   * @param {Object} [args] Args for event e.g. `{ channel_id: '1234' }`
   * @returns {Promise<Object>}
   */
  async subscribe(event, args) {
    await this.request(RPCCommands.SUBSCRIBE, args, event);
    return {
      unsubscribe: () => this.request(RPCCommands.UNSUBSCRIBE, args, event),
    };
  }

  /**
   * Destroy the client
   */
  async destroy() {
    await this.transport.close();
  }
}

module.exports = RPCClient;


/***/ },

/***/ "./node_modules/discord-rpc/src/constants.js"
/*!***************************************************!*\
  !*** ./node_modules/discord-rpc/src/constants.js ***!
  \***************************************************/
(__unused_webpack_module, exports) {

"use strict";


function keyMirror(arr) {
  const tmp = {};
  for (const value of arr) {
    tmp[value] = value;
  }
  return tmp;
}


exports.browser = typeof window !== 'undefined';

exports.RPCCommands = keyMirror([
  'DISPATCH',
  'AUTHORIZE',
  'AUTHENTICATE',
  'GET_GUILD',
  'GET_GUILDS',
  'GET_CHANNEL',
  'GET_CHANNELS',
  'CREATE_CHANNEL_INVITE',
  'GET_RELATIONSHIPS',
  'GET_USER',
  'SUBSCRIBE',
  'UNSUBSCRIBE',
  'SET_USER_VOICE_SETTINGS',
  'SET_USER_VOICE_SETTINGS_2',
  'SELECT_VOICE_CHANNEL',
  'GET_SELECTED_VOICE_CHANNEL',
  'SELECT_TEXT_CHANNEL',
  'GET_VOICE_SETTINGS',
  'SET_VOICE_SETTINGS_2',
  'SET_VOICE_SETTINGS',
  'CAPTURE_SHORTCUT',
  'SET_ACTIVITY',
  'SEND_ACTIVITY_JOIN_INVITE',
  'CLOSE_ACTIVITY_JOIN_REQUEST',
  'ACTIVITY_INVITE_USER',
  'ACCEPT_ACTIVITY_INVITE',
  'INVITE_BROWSER',
  'DEEP_LINK',
  'CONNECTIONS_CALLBACK',
  'BRAINTREE_POPUP_BRIDGE_CALLBACK',
  'GIFT_CODE_BROWSER',
  'GUILD_TEMPLATE_BROWSER',
  'OVERLAY',
  'BROWSER_HANDOFF',
  'SET_CERTIFIED_DEVICES',
  'GET_IMAGE',
  'CREATE_LOBBY',
  'UPDATE_LOBBY',
  'DELETE_LOBBY',
  'UPDATE_LOBBY_MEMBER',
  'CONNECT_TO_LOBBY',
  'DISCONNECT_FROM_LOBBY',
  'SEND_TO_LOBBY',
  'SEARCH_LOBBIES',
  'CONNECT_TO_LOBBY_VOICE',
  'DISCONNECT_FROM_LOBBY_VOICE',
  'SET_OVERLAY_LOCKED',
  'OPEN_OVERLAY_ACTIVITY_INVITE',
  'OPEN_OVERLAY_GUILD_INVITE',
  'OPEN_OVERLAY_VOICE_SETTINGS',
  'VALIDATE_APPLICATION',
  'GET_ENTITLEMENT_TICKET',
  'GET_APPLICATION_TICKET',
  'START_PURCHASE',
  'GET_SKUS',
  'GET_ENTITLEMENTS',
  'GET_NETWORKING_CONFIG',
  'NETWORKING_SYSTEM_METRICS',
  'NETWORKING_PEER_METRICS',
  'NETWORKING_CREATE_TOKEN',
  'SET_USER_ACHIEVEMENT',
  'GET_USER_ACHIEVEMENTS',
]);

exports.RPCEvents = keyMirror([
  'CURRENT_USER_UPDATE',
  'GUILD_STATUS',
  'GUILD_CREATE',
  'CHANNEL_CREATE',
  'RELATIONSHIP_UPDATE',
  'VOICE_CHANNEL_SELECT',
  'VOICE_STATE_CREATE',
  'VOICE_STATE_DELETE',
  'VOICE_STATE_UPDATE',
  'VOICE_SETTINGS_UPDATE',
  'VOICE_SETTINGS_UPDATE_2',
  'VOICE_CONNECTION_STATUS',
  'SPEAKING_START',
  'SPEAKING_STOP',
  'GAME_JOIN',
  'GAME_SPECTATE',
  'ACTIVITY_JOIN',
  'ACTIVITY_JOIN_REQUEST',
  'ACTIVITY_SPECTATE',
  'ACTIVITY_INVITE',
  'NOTIFICATION_CREATE',
  'MESSAGE_CREATE',
  'MESSAGE_UPDATE',
  'MESSAGE_DELETE',
  'LOBBY_DELETE',
  'LOBBY_UPDATE',
  'LOBBY_MEMBER_CONNECT',
  'LOBBY_MEMBER_DISCONNECT',
  'LOBBY_MEMBER_UPDATE',
  'LOBBY_MESSAGE',
  'CAPTURE_SHORTCUT_CHANGE',
  'OVERLAY',
  'OVERLAY_UPDATE',
  'ENTITLEMENT_CREATE',
  'ENTITLEMENT_DELETE',
  'USER_ACHIEVEMENT_UPDATE',
  'READY',
  'ERROR',
]);

exports.RPCErrors = {
  CAPTURE_SHORTCUT_ALREADY_LISTENING: 5004,
  GET_GUILD_TIMED_OUT: 5002,
  INVALID_ACTIVITY_JOIN_REQUEST: 4012,
  INVALID_ACTIVITY_SECRET: 5005,
  INVALID_CHANNEL: 4005,
  INVALID_CLIENTID: 4007,
  INVALID_COMMAND: 4002,
  INVALID_ENTITLEMENT: 4015,
  INVALID_EVENT: 4004,
  INVALID_GIFT_CODE: 4016,
  INVALID_GUILD: 4003,
  INVALID_INVITE: 4011,
  INVALID_LOBBY: 4013,
  INVALID_LOBBY_SECRET: 4014,
  INVALID_ORIGIN: 4008,
  INVALID_PAYLOAD: 4000,
  INVALID_PERMISSIONS: 4006,
  INVALID_TOKEN: 4009,
  INVALID_USER: 4010,
  LOBBY_FULL: 5007,
  NO_ELIGIBLE_ACTIVITY: 5006,
  OAUTH2_ERROR: 5000,
  PURCHASE_CANCELED: 5008,
  PURCHASE_ERROR: 5009,
  RATE_LIMITED: 5011,
  SELECT_CHANNEL_TIMED_OUT: 5001,
  SELECT_VOICE_FORCE_REQUIRED: 5003,
  SERVICE_UNAVAILABLE: 1001,
  TRANSACTION_ABORTED: 1002,
  UNAUTHORIZED_FOR_ACHIEVEMENT: 5010,
  UNKNOWN_ERROR: 1000,
};

exports.RPCCloseCodes = {
  CLOSE_NORMAL: 1000,
  CLOSE_UNSUPPORTED: 1003,
  CLOSE_ABNORMAL: 1006,
  INVALID_CLIENTID: 4000,
  INVALID_ORIGIN: 4001,
  RATELIMITED: 4002,
  TOKEN_REVOKED: 4003,
  INVALID_VERSION: 4004,
  INVALID_ENCODING: 4005,
};

exports.LobbyTypes = {
  PRIVATE: 1,
  PUBLIC: 2,
};

exports.RelationshipTypes = {
  NONE: 0,
  FRIEND: 1,
  BLOCKED: 2,
  PENDING_INCOMING: 3,
  PENDING_OUTGOING: 4,
  IMPLICIT: 5,
};


/***/ },

/***/ "./node_modules/discord-rpc/src/index.js"
/*!***********************************************!*\
  !*** ./node_modules/discord-rpc/src/index.js ***!
  \***********************************************/
(module, __unused_webpack_exports, __webpack_require__) {

"use strict";


const util = __webpack_require__(/*! ./util */ "./node_modules/discord-rpc/src/util.js");

module.exports = {
  Client: __webpack_require__(/*! ./client */ "./node_modules/discord-rpc/src/client.js"),
  register(id) {
    return util.register(`discord-${id}`);
  },
};


/***/ },

/***/ "./node_modules/discord-rpc/src/transports/index.js"
/*!**********************************************************!*\
  !*** ./node_modules/discord-rpc/src/transports/index.js ***!
  \**********************************************************/
(module, __unused_webpack_exports, __webpack_require__) {

"use strict";


module.exports = {
  ipc: __webpack_require__(/*! ./ipc */ "./node_modules/discord-rpc/src/transports/ipc.js"),
  websocket: __webpack_require__(/*! ./websocket */ "./node_modules/discord-rpc/src/transports/websocket.js"),
};


/***/ },

/***/ "./node_modules/discord-rpc/src/transports/ipc.js"
/*!********************************************************!*\
  !*** ./node_modules/discord-rpc/src/transports/ipc.js ***!
  \********************************************************/
(module, __unused_webpack_exports, __webpack_require__) {

"use strict";


const net = __webpack_require__(/*! net */ "net");
const EventEmitter = __webpack_require__(/*! events */ "events");
const fetch = __webpack_require__(/*! node-fetch */ "./node_modules/node-fetch/browser.js");
const { uuid } = __webpack_require__(/*! ../util */ "./node_modules/discord-rpc/src/util.js");

const OPCodes = {
  HANDSHAKE: 0,
  FRAME: 1,
  CLOSE: 2,
  PING: 3,
  PONG: 4,
};

function getIPCPath(id) {
  if (process.platform === 'win32') {
    return `\\\\?\\pipe\\discord-ipc-${id}`;
  }
  const { env: { XDG_RUNTIME_DIR, TMPDIR, TMP, TEMP } } = process;
  const prefix = XDG_RUNTIME_DIR || TMPDIR || TMP || TEMP || '/tmp';
  return `${prefix.replace(/\/$/, '')}/discord-ipc-${id}`;
}

function getIPC(id = 0) {
  return new Promise((resolve, reject) => {
    const path = getIPCPath(id);
    const onerror = () => {
      if (id < 10) {
        resolve(getIPC(id + 1));
      } else {
        reject(new Error('Could not connect'));
      }
    };
    const sock = net.createConnection(path, () => {
      sock.removeListener('error', onerror);
      resolve(sock);
    });
    sock.once('error', onerror);
  });
}

async function findEndpoint(tries = 0) {
  if (tries > 30) {
    throw new Error('Could not find endpoint');
  }
  const endpoint = `http://127.0.0.1:${6463 + (tries % 10)}`;
  try {
    const r = await fetch(endpoint);
    if (r.status === 404) {
      return endpoint;
    }
    return findEndpoint(tries + 1);
  } catch (e) {
    return findEndpoint(tries + 1);
  }
}

function encode(op, data) {
  data = JSON.stringify(data);
  const len = Buffer.byteLength(data);
  const packet = Buffer.alloc(8 + len);
  packet.writeInt32LE(op, 0);
  packet.writeInt32LE(len, 4);
  packet.write(data, 8, len);
  return packet;
}

const working = {
  full: '',
  op: undefined,
};

function decode(socket, callback) {
  const packet = socket.read();
  if (!packet) {
    return;
  }

  let { op } = working;
  let raw;
  if (working.full === '') {
    op = working.op = packet.readInt32LE(0);
    const len = packet.readInt32LE(4);
    raw = packet.slice(8, len + 8);
  } else {
    raw = packet.toString();
  }

  try {
    const data = JSON.parse(working.full + raw);
    callback({ op, data }); // eslint-disable-line callback-return
    working.full = '';
    working.op = undefined;
  } catch (err) {
    working.full += raw;
  }

  decode(socket, callback);
}

class IPCTransport extends EventEmitter {
  constructor(client) {
    super();
    this.client = client;
    this.socket = null;
  }

  async connect() {
    const socket = this.socket = await getIPC();
    socket.on('close', this.onClose.bind(this));
    socket.on('error', this.onClose.bind(this));
    this.emit('open');
    socket.write(encode(OPCodes.HANDSHAKE, {
      v: 1,
      client_id: this.client.clientId,
    }));
    socket.pause();
    socket.on('readable', () => {
      decode(socket, ({ op, data }) => {
        switch (op) {
          case OPCodes.PING:
            this.send(data, OPCodes.PONG);
            break;
          case OPCodes.FRAME:
            if (!data) {
              return;
            }
            if (data.cmd === 'AUTHORIZE' && data.evt !== 'ERROR') {
              findEndpoint()
                .then((endpoint) => {
                  this.client.request.endpoint = endpoint;
                })
                .catch((e) => {
                  this.client.emit('error', e);
                });
            }
            this.emit('message', data);
            break;
          case OPCodes.CLOSE:
            this.emit('close', data);
            break;
          default:
            break;
        }
      });
    });
  }

  onClose(e) {
    this.emit('close', e);
  }

  send(data, op = OPCodes.FRAME) {
    this.socket.write(encode(op, data));
  }

  async close() {
    return new Promise((r) => {
      this.once('close', r);
      this.send({}, OPCodes.CLOSE);
      this.socket.end();
    });
  }

  ping() {
    this.send(uuid(), OPCodes.PING);
  }
}

module.exports = IPCTransport;
module.exports.encode = encode;
module.exports.decode = decode;


/***/ },

/***/ "./node_modules/discord-rpc/src/transports/websocket.js"
/*!**************************************************************!*\
  !*** ./node_modules/discord-rpc/src/transports/websocket.js ***!
  \**************************************************************/
(module, __unused_webpack_exports, __webpack_require__) {

"use strict";


const EventEmitter = __webpack_require__(/*! events */ "events");
const { browser } = __webpack_require__(/*! ../constants */ "./node_modules/discord-rpc/src/constants.js");

// eslint-disable-next-line
const WebSocket = browser ? window.WebSocket : __webpack_require__(/*! ws */ "?e493");

const pack = (d) => JSON.stringify(d);
const unpack = (s) => JSON.parse(s);

class WebSocketTransport extends EventEmitter {
  constructor(client) {
    super();
    this.client = client;
    this.ws = null;
    this.tries = 0;
  }

  async connect() {
    const port = 6463 + (this.tries % 10);
    this.tries += 1;

    this.ws = new WebSocket(
      `ws://127.0.0.1:${port}/?v=1&client_id=${this.client.clientId}`,
      browser ? undefined : { origin: this.client.options.origin },
    );
    this.ws.onopen = this.onOpen.bind(this);
    this.ws.onclose = this.onClose.bind(this);
    this.ws.onerror = this.onError.bind(this);
    this.ws.onmessage = this.onMessage.bind(this);
  }

  onOpen() {
    this.emit('open');
  }

  onClose(event) {
    if (!event.wasClean) {
      return;
    }
    this.emit('close', event);
  }

  onError(event) {
    try {
      this.ws.close();
    } catch {} // eslint-disable-line no-empty

    if (this.tries > 20) {
      this.emit('error', event.error);
    } else {
      setTimeout(() => {
        this.connect();
      }, 250);
    }
  }

  onMessage(event) {
    this.emit('message', unpack(event.data));
  }

  send(data) {
    this.ws.send(pack(data));
  }

  ping() {} // eslint-disable-line no-empty-function

  close() {
    return new Promise((r) => {
      this.once('close', r);
      this.ws.close();
    });
  }
}

module.exports = WebSocketTransport;


/***/ },

/***/ "./node_modules/discord-rpc/src/util.js"
/*!**********************************************!*\
  !*** ./node_modules/discord-rpc/src/util.js ***!
  \**********************************************/
(module, __unused_webpack_exports, __webpack_require__) {

"use strict";


let register;
try {
  const { app } = __webpack_require__(/*! electron */ "electron");
  register = app.setAsDefaultProtocolClient.bind(app);
} catch (err) {
  try {
    register = __webpack_require__(/*! register-scheme */ "?37cb");
  } catch (e) {} // eslint-disable-line no-empty
}

if (typeof register !== 'function') {
  register = () => false;
}

function pid() {
  if (typeof process !== 'undefined') {
    return process.pid;
  }
  return null;
}

const uuid4122 = () => {
  let uuid = '';
  for (let i = 0; i < 32; i += 1) {
    if (i === 8 || i === 12 || i === 16 || i === 20) {
      uuid += '-';
    }
    let n;
    if (i === 12) {
      n = 4;
    } else {
      const random = Math.random() * 16 | 0;
      if (i === 16) {
        n = (random & 3) | 0;
      } else {
        n = random;
      }
    }
    uuid += n.toString(16);
  }
  return uuid;
};

module.exports = {
  pid,
  register,
  uuid: uuid4122,
};


/***/ },

/***/ "./node_modules/node-fetch/browser.js"
/*!********************************************!*\
  !*** ./node_modules/node-fetch/browser.js ***!
  \********************************************/
(module, exports) {

"use strict";


// ref: https://github.com/tc39/proposal-global
var getGlobal = function () {
	// the only reliable means to get the global object is
	// `Function('return this')()`
	// However, this causes CSP violations in Chrome apps.
	if (typeof self !== 'undefined') { return self; }
	if (typeof window !== 'undefined') { return window; }
	if (typeof global !== 'undefined') { return global; }
	throw new Error('unable to locate global object');
}

var globalObject = getGlobal();

module.exports = exports = globalObject.fetch;

// Needed for TypeScript and Webpack.
if (globalObject.fetch) {
	exports["default"] = globalObject.fetch.bind(globalObject);
}

exports.Headers = globalObject.Headers;
exports.Request = globalObject.Request;
exports.Response = globalObject.Response;


/***/ },

/***/ "./src/DiscordRPC.ts"
/*!***************************!*\
  !*** ./src/DiscordRPC.ts ***!
  \***************************/
(__unused_webpack_module, exports, __webpack_require__) {

"use strict";

var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || function (mod) {
    if (mod && mod.__esModule) return mod;
    var result = {};
    if (mod != null) for (var k in mod) if (k !== "default" && Object.prototype.hasOwnProperty.call(mod, k)) __createBinding(result, mod, k);
    __setModuleDefault(result, mod);
    return result;
};
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", ({ value: true }));
const RPC = __importStar(__webpack_require__(/*! discord-rpc */ "./node_modules/discord-rpc/src/index.js"));
const vortex_api_1 = __webpack_require__(/*! vortex-api */ "vortex-api");
const gameart_json_1 = __importDefault(__webpack_require__(/*! ./gameart.json */ "./src/gameart.json"));
const actions_1 = __webpack_require__(/*! ./actions */ "./src/actions.ts");
const AppID = '594190466782724099';
class DiscordRPC {
    constructor(api) {
        this.enabled = false;
        this.currentActivity = null;
        this.clientId = null;
        this.connected = false;
        this.iRetryDelay = 10000;
        this.iRetryDelayMax = 120000;
        this.GetSettings = (api) => api.getState().settings['Discord'];
        this.settingsSyncTimer = null;
        this.AppId = AppID;
        this.ActivityUpdateTimer = null;
        this.getUser = () => this._Client.user;
        this._API = api;
        this.createClient();
        this.Settings = this.GetSettings(api);
        this._API.onStateChange(['settings', 'Discord'], () => this.scheduleSettingsSync());
        this._API.events.on('gamemode-activated', (mode) => this.onGameModeActivated(mode));
        this._API.events.on('did-deploy', () => this.onDidDeploy());
        this._API.onStateChange(['settings', 'profiles', 'activeProfileId'], (prev, cur) => this.onActiveProfileChanged(prev, cur));
        this._API.onStateChange(['session', 'base', 'toolsRunning'], (prev, cur) => this.onToolsRunningChanged(prev, cur));
        this._API.onStateChange(['session', 'collections', 'activeSession'], (prev, cur) => this.onCollectionInstallProgress(prev, cur));
        this._API.events.on('update-discord-activity', (presence) => this.setActivity(presence));
    }
    scheduleSettingsSync() {
        if (this.settingsSyncTimer)
            clearTimeout(this.settingsSyncTimer);
        this.settingsSyncTimer = setTimeout(() => this.syncSettings(), 150);
    }
    syncSettings() {
        this.settingsSyncTimer = null;
        const newSettings = this._API.getState().settings['Discord'] || {};
        const oldSettings = this.Settings || { enabled: true };
        (0, vortex_api_1.log)('debug', 'Updated RPC Settings', { newSettings, oldSettings });
        console.log('Updated RPC settings', newSettings);
        this.Settings = newSettings;
        if (newSettings.enabled !== oldSettings.enabled) {
            if (newSettings.enabled) {
                this.login();
                const currentGame = vortex_api_1.selectors.activeGameId(this._API.getState());
                this.setRPCGame(currentGame);
            }
            else {
                this.clearActivity().catch(() => { });
                this.dispose();
            }
            return;
        }
    }
    createClient() {
        if (this._Client)
            this._Client.removeAllListeners();
        this._Client = new RPC.Client({ transport: 'ipc' });
        this._Client.on('ready', () => {
            const user = this._Client.user;
            (0, vortex_api_1.log)('info', `Discord RPC - ${user.username} (${user.id}) logged into client ${this.clientId}`);
        });
        this._Client.on('error', (err) => (0, vortex_api_1.log)('error', 'Discord RPC error', err));
        this._Client.on('connected', () => (0, vortex_api_1.log)('debug', 'Discord RPC connected'));
        this._Client.on('disconnected', () => {
            (0, vortex_api_1.log)('debug', 'Discord RPC disconnected');
            this.connected = false;
        });
    }
    async login(retryLimit = -1) {
        if (this.connected)
            return true;
        if (!this._Client)
            this.createClient();
        this.iRetryAttempts = retryLimit;
        this.clearRetryTimer();
        try {
            await this._Client.login({ clientId: this.AppId });
            this.connected = true;
            this.iRetryDelay = 10000;
            this._API.store.dispatch((0, actions_1.setCurrentUser)(this._Client.user));
            return true;
        }
        catch (err) {
            console.warn('DPC RPC failed', err);
            (0, vortex_api_1.log)('warn', 'Discord RPC failed to connect', err);
            this.connected = false;
            this.enabled = false;
            if (retryLimit === -1 || retryLimit > 0) {
                this.scheduleRetry();
            }
            return false;
        }
    }
    scheduleRetry() {
        this.clearRetryTimer();
        const delay = Math.min(this.iRetryDelay, this.iRetryDelayMax);
        this.RetryTimer = setTimeout(async () => {
            this.iRetryDelay = Math.min(this.iRetryDelay + 10000, this.iRetryDelayMax);
            if (this.iRetryAttempts > 0)
                this.iRetryAttempts -= 1;
            const ok = await this.retryLogin();
            if (!ok && this.iRetryAttempts === 0)
                this.clearRetryTimer();
        }, delay);
    }
    async retryLogin() {
        return this.login(this.iRetryAttempts);
    }
    clearRetryTimer() {
        if (this.RetryTimer) {
            clearTimeout(this.RetryTimer);
            this.RetryTimer = null;
        }
    }
    async clearActivity() {
        this.currentActivity = null;
        this.connected = false;
        this._API.store.dispatch((0, actions_1.setCurrentActivity)(undefined));
        this._API.store.dispatch((0, actions_1.setCurrentUser)(undefined));
        await this._Client.clearActivity();
    }
    async onGameModeActivated(newMode) {
        (0, vortex_api_1.log)('debug', 'Discord RPC updating for GameModeActivated');
        return this.setRPCGame(newMode);
    }
    onDidDeploy() {
        (0, vortex_api_1.log)('debug', 'Discord RPC updating for DidDeploy activated');
        const state = this._API.getState();
        const activeGameId = vortex_api_1.selectors.activeGameId(state);
        this.setRPCGame(activeGameId);
    }
    onActiveProfileChanged(prev, cur) {
        (0, vortex_api_1.log)('debug', 'Discord RPC updating for ActiveProfilChanged');
        if (!cur)
            return this.clearActivity();
        else {
            const state = this._API.getState();
            const activeGameId = vortex_api_1.selectors.activeGameId(state);
            this.setRPCGame(activeGameId);
        }
    }
    onToolsRunningChanged(prev, cur) {
        (0, vortex_api_1.log)('debug', 'Discord RPC updating for ToolsRunningChanged');
        const prevTools = Object.keys(prev);
        const nextTools = Object.keys(cur);
        if (prevTools.length > 0 && nextTools.length === 0) {
            const state = this._API.getState();
            const activeGameId = vortex_api_1.selectors.activeGameId(state);
            this.setRPCGame(activeGameId);
        }
        else {
            this.clearActivity();
        }
    }
    onCollectionInstallProgress(prev, cur) {
        if (!cur || cur.installedCount === prev.installedCount || this.ActivityUpdateTimer) {
            console.log('Aborting update as no session change or install count change or change is queued', { prev, cur, timer: this.ActivityUpdateTimer });
            return;
        }
        const { collectionId, totalRequired, totalOptional, installedCount, gameId } = cur;
        const collectionEntity = this._API.getState().persistent.mods[gameId][collectionId];
        console.log('Collection session', { cur, collectionEntity });
        const game = vortex_api_1.util.getGame(gameId);
        const presence = {
            details: `Installing collection "${collectionEntity.attributes.customFileName}"...`,
            state: `Revision ${collectionEntity.attributes.modVersion} (${installedCount}/${totalRequired + totalOptional})`,
            largeImageKey: gameart_json_1.default[game.id] || 'vortexlogo512',
            largeImageText: gameart_json_1.default[game.id] ? game.name : 'Vortex',
            smallImageKey: gameart_json_1.default[game.id] ? 'vortexlogo512' : 'nexuslogo',
            smallImageText: gameart_json_1.default[game.id] ? 'Vortex by Nexus Mods' : 'Nexus Mods',
            startTimestamp: new Date(collectionEntity.attributes.installTime),
            buttons: [
                {
                    label: 'Get Collection',
                    url: `https://www.nexusmods.com/games/${gameId}/collections/${collectionEntity.attributes.collectionSlug}`
                }
            ]
        };
        return this.setActivity(presence);
    }
    async setRPCGame(gameId) {
        if (!this.Settings.enabled)
            return;
        if (!gameId) {
            this.setDefaultRPC();
            return;
        }
        const state = this._API.getState();
        const game = vortex_api_1.util.getGame(gameId);
        const profile = vortex_api_1.selectors.activeProfile(state);
        const modCount = Object.values(profile.modState).filter(m => m.enabled).length;
        (0, vortex_api_1.log)('info', `Updating Discord RPC for ${game.id}: ${profile.id}`);
        const presence = {
            details: game.name,
            state: modCount === 1 ? `${modCount} mod installed` : `${modCount} mods installed`,
            largeImageKey: gameart_json_1.default[game.id] || 'vortexlogo512',
            largeImageText: gameart_json_1.default[game.id] ? game.name : 'Vortex',
            smallImageKey: gameart_json_1.default[game.id] ? 'vortexlogo512' : 'nexuslogo',
            smallImageText: gameart_json_1.default[game.id] ? 'Vortex by Nexus Mods' : 'Nexus Mods',
        };
        return this.setActivity(presence);
    }
    async setDefaultRPC() {
        const presence = {
            details: 'Vortex Mod Manager',
            state: 'Ready to start modding!',
            largeImageKey: 'vortexlogo512',
            largeImageText: 'Vortex',
            smallImageKey: 'nexuslogo',
            smallImageText: 'Nexus Mods'
        };
        return this.setActivity(presence);
    }
    async setActivityImpl(presence) {
        this.ActivityUpdateTimer = null;
        try {
            if (!this.connected) {
                await this.login();
                if (!this.connected)
                    return;
            }
            if (presence) {
                this.currentActivity = presence;
                this._Client.setActivity(presence);
                this._API.store.dispatch((0, actions_1.setCurrentActivity)(presence));
            }
            else {
                this.clearActivity();
                this._API.store.dispatch((0, actions_1.setCurrentActivity)(undefined));
            }
        }
        catch (err) {
            (0, vortex_api_1.log)('warn', 'Failed to set RPC', err);
        }
    }
    async setActivity(presence) {
        const current = this._API.getState().session['Discord'].presence;
        const sameAsCurrent = JSON.stringify(current) === JSON.stringify(presence);
        if (sameAsCurrent)
            return;
        if (this.ActivityUpdateTimer)
            clearTimeout(this.ActivityUpdateTimer);
        this.ActivityUpdateTimer = setTimeout((presence) => this.setActivityImpl(presence), 5000, presence);
    }
    dispose() {
        this.clearRetryTimer();
        if (this._Client) {
            this._Client.removeAllListeners();
            try {
                if (typeof this._Client.destroy === 'function')
                    this._Client.destroy();
            }
            catch { }
            this._Client = null;
        }
    }
}
exports["default"] = DiscordRPC;


/***/ },

/***/ "./src/Settings.tsx"
/*!**************************!*\
  !*** ./src/Settings.tsx ***!
  \**************************/
(__unused_webpack_module, exports, __webpack_require__) {

"use strict";

var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", ({ value: true }));
const react_1 = __importDefault(__webpack_require__(/*! react */ "react"));
const react_bootstrap_1 = __webpack_require__(/*! react-bootstrap */ "react-bootstrap");
const react_redux_1 = __webpack_require__(/*! react-redux */ "react-redux");
const vortex_api_1 = __webpack_require__(/*! vortex-api */ "vortex-api");
const actions_1 = __webpack_require__(/*! ./actions */ "./src/actions.ts");
function DiscordSettings() {
    var _a;
    const { enabled } = (0, react_redux_1.useSelector)((state) => state.settings['Discord']);
    const { user } = (0, react_redux_1.useSelector)((state) => state.session['Discord']);
    const state = (0, react_redux_1.useSelector)((state) => state);
    const store = (0, react_redux_1.useStore)();
    const setRPCEnabled = react_1.default.useCallback((enabled) => {
        store.dispatch((0, actions_1.setRPCSetting)('enabled', enabled));
    }, []);
    return (react_1.default.createElement("form", null,
        react_1.default.createElement(react_bootstrap_1.FormGroup, { controlId: '' },
            react_1.default.createElement(react_bootstrap_1.Panel, null,
                react_1.default.createElement(react_bootstrap_1.ControlLabel, null, "Discord Integration"),
                react_1.default.createElement(vortex_api_1.Toggle, { checked: enabled, onToggle: setRPCEnabled },
                    "Enable Discord Rich Presence",
                    react_1.default.createElement(vortex_api_1.More, { id: 'discord-master-enable', name: 'Discord Rich Presence' }, "Shows your Vortex activity in Discord for your friends to see.")),
                react_1.default.createElement(vortex_api_1.Toggle, { checked: false, disabled: !enabled, onToggle: () => undefined }, "Show Mods"),
                react_1.default.createElement(vortex_api_1.Toggle, { checked: false, disabled: !enabled, onToggle: () => undefined }, "Show Collections"),
                user && (react_1.default.createElement("div", null,
                    react_1.default.createElement("p", null, "Connected to Discord as:"),
                    react_1.default.createElement("div", { style: { display: 'flex', gap: 4, justifyItems: 'center' } },
                        react_1.default.createElement("img", { src: `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png`, width: 20, height: 20, alt: user.username, style: { borderRadius: 25 } }),
                        react_1.default.createElement("p", { title: `${user.username} (${user.id})` },
                            react_1.default.createElement("strong", null, (_a = user.global_name) !== null && _a !== void 0 ? _a : user.username))))),
                !user && react_1.default.createElement("p", null, "Not connected to Discord")),
            react_1.default.createElement("a", { onClick: () => console.log(state) }, "Print State"))));
}
exports["default"] = DiscordSettings;


/***/ },

/***/ "./src/actions.ts"
/*!************************!*\
  !*** ./src/actions.ts ***!
  \************************/
(__unused_webpack_module, exports, __webpack_require__) {

"use strict";

Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.setCurrentUser = exports.setCurrentActivity = exports.setRPCSetting = void 0;
const redux_act_1 = __webpack_require__(/*! redux-act */ "redux-act");
exports.setRPCSetting = (0, redux_act_1.createAction)('SET_DISCORD_RPC_SETTING', (key, value) => ({ key, value }));
exports.setCurrentActivity = (0, redux_act_1.createAction)('SET_DISCORD_RPC_ACTIVITY', (presence) => ({ presence }));
exports.setCurrentUser = (0, redux_act_1.createAction)('SET_DISCORD_RPC_USER', (user) => ({ user }));


/***/ },

/***/ "./src/gameart.json"
/*!**************************!*\
  !*** ./src/gameart.json ***!
  \**************************/
(module) {

"use strict";
module.exports = /*#__PURE__*/JSON.parse('{"skyrim":"skyrim","skyrimse":"skyrimse","skyrimvr":"skyrimse","stardewvalley":"stardewvalley","monsterhunterworld":"monsterhunterworld","fallout3":"fallout3","fallout4":"fallout4","fallout4vr":"fallout4","falloutnv":"falloutnv","kingdomcomedeliverance":"kingdomcomedeliverance","bladeandsorcery":"bladeandsorcery","halothemasterchiefcollection":"halothemasterchiefcollection","mountandblade2bannerlord":"mountandblade2bannerlord","oblivion":"oblivion","morrowind":"morrowind","wolcenlordsofmayhem":"wolcenlordsofmayhem","residentevil22019":"residentevil22019","residentevil32020":"residentevil32020","7daystodie":"7daystodie","battletech":"battletech","blackmesa":"blackmesa","bloodstainedritualofthenight":"bloodstainedritualofthenight","codevein":"codevein","microsoftflightsimulator":"microsoftflightsimulator","cyberpunk2077":"cyberpunk2077","bluefire":"bluefire"}');

/***/ },

/***/ "./src/index.ts"
/*!**********************!*\
  !*** ./src/index.ts ***!
  \**********************/
(__unused_webpack_module, exports, __webpack_require__) {

"use strict";

var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || function (mod) {
    if (mod && mod.__esModule) return mod;
    var result = {};
    if (mod != null) for (var k in mod) if (k !== "default" && Object.prototype.hasOwnProperty.call(mod, k)) __createBinding(result, mod, k);
    __setModuleDefault(result, mod);
    return result;
};
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", ({ value: true }));
const vortex_api_1 = __webpack_require__(/*! vortex-api */ "vortex-api");
const reducers_1 = __importStar(__webpack_require__(/*! ./reducers */ "./src/reducers.ts"));
const DiscordRPC_1 = __importDefault(__webpack_require__(/*! ./DiscordRPC */ "./src/DiscordRPC.ts"));
const Settings_1 = __importDefault(__webpack_require__(/*! ./Settings */ "./src/Settings.tsx"));
function main(context) {
    let client;
    context.registerSettings('Vortex', Settings_1.default, () => ({}), () => true, 150);
    context.registerReducer(['settings', 'Discord'], reducers_1.default);
    context.registerReducer(['session', 'Discord'], reducers_1.discordRpcSessionReducer);
    context.once(async () => {
        client = new DiscordRPC_1.default(context.api);
        (0, vortex_api_1.log)('debug', 'Discord RPC client created');
        try {
            client.login();
        }
        catch (err) {
            (0, vortex_api_1.log)('warn', 'Failed to log in to Discord via RPC', err);
        }
    });
}
exports["default"] = main;


/***/ },

/***/ "./src/reducers.ts"
/*!*************************!*\
  !*** ./src/reducers.ts ***!
  \*************************/
(__unused_webpack_module, exports, __webpack_require__) {

"use strict";

Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.discordRpcSessionReducer = void 0;
const actions_1 = __webpack_require__(/*! ./actions */ "./src/actions.ts");
const vortex_api_1 = __webpack_require__(/*! vortex-api */ "vortex-api");
const discordRpcReducers = {
    reducers: {
        [actions_1.setRPCSetting]: (state, payload) => {
            return vortex_api_1.util.setSafe(state, [payload.key], payload.value);
        },
    },
    defaults: {
        enabled: true,
    }
};
exports.discordRpcSessionReducer = {
    reducers: {
        [actions_1.setCurrentActivity]: (state, payload) => {
            if (payload.presence)
                return vortex_api_1.util.setSafe(state, ['presence'], payload.presence);
            else
                return vortex_api_1.util.deleteOrNop(state, ['presence']);
        },
        [actions_1.setCurrentUser]: (state, payload) => {
            if (payload.user)
                return vortex_api_1.util.setSafe(state, ['user'], payload.user);
            else
                return vortex_api_1.util.deleteOrNop(state, ['user']);
        }
    },
    defaults: {}
};
exports["default"] = discordRpcReducers;


/***/ },

/***/ "?37cb"
/*!*********************************!*\
  !*** register-scheme (ignored) ***!
  \*********************************/
() {

/* (ignored) */

/***/ },

/***/ "?e493"
/*!********************!*\
  !*** ws (ignored) ***!
  \********************/
() {

/* (ignored) */

/***/ },

/***/ "electron"
/*!***************************!*\
  !*** external "electron" ***!
  \***************************/
(module) {

"use strict";
module.exports = require("electron");

/***/ },

/***/ "events"
/*!*************************!*\
  !*** external "events" ***!
  \*************************/
(module) {

"use strict";
module.exports = require("events");

/***/ },

/***/ "net"
/*!**********************!*\
  !*** external "net" ***!
  \**********************/
(module) {

"use strict";
module.exports = require("net");

/***/ },

/***/ "react"
/*!************************!*\
  !*** external "react" ***!
  \************************/
(module) {

"use strict";
module.exports = require("react");

/***/ },

/***/ "react-bootstrap"
/*!**********************************!*\
  !*** external "react-bootstrap" ***!
  \**********************************/
(module) {

"use strict";
module.exports = require("react-bootstrap");

/***/ },

/***/ "react-redux"
/*!******************************!*\
  !*** external "react-redux" ***!
  \******************************/
(module) {

"use strict";
module.exports = require("react-redux");

/***/ },

/***/ "redux-act"
/*!****************************!*\
  !*** external "redux-act" ***!
  \****************************/
(module) {

"use strict";
module.exports = require("redux-act");

/***/ },

/***/ "timers"
/*!*************************!*\
  !*** external "timers" ***!
  \*************************/
(module) {

"use strict";
module.exports = require("timers");

/***/ },

/***/ "vortex-api"
/*!*****************************!*\
  !*** external "vortex-api" ***!
  \*****************************/
(module) {

"use strict";
module.exports = require("vortex-api");

/***/ }

/******/ 	});
/************************************************************************/
/******/ 	// The module cache
/******/ 	var __webpack_module_cache__ = {};
/******/ 	
/******/ 	// The require function
/******/ 	function __webpack_require__(moduleId) {
/******/ 		// Check if module is in cache
/******/ 		var cachedModule = __webpack_module_cache__[moduleId];
/******/ 		if (cachedModule !== undefined) {
/******/ 			return cachedModule.exports;
/******/ 		}
/******/ 		// Check if module exists (development only)
/******/ 		if (__webpack_modules__[moduleId] === undefined) {
/******/ 			var e = new Error("Cannot find module '" + moduleId + "'");
/******/ 			e.code = 'MODULE_NOT_FOUND';
/******/ 			throw e;
/******/ 		}
/******/ 		// Create a new module (and put it into the cache)
/******/ 		var module = __webpack_module_cache__[moduleId] = {
/******/ 			// no module.id needed
/******/ 			// no module.loaded needed
/******/ 			exports: {}
/******/ 		};
/******/ 	
/******/ 		// Execute the module function
/******/ 		__webpack_modules__[moduleId].call(module.exports, module, module.exports, __webpack_require__);
/******/ 	
/******/ 		// Return the exports of the module
/******/ 		return module.exports;
/******/ 	}
/******/ 	
/************************************************************************/
/******/ 	
/******/ 	// startup
/******/ 	// Load entry module and return exports
/******/ 	// This entry module is referenced by other modules so it can't be inlined
/******/ 	var __webpack_exports__ = __webpack_require__("./src/index.ts");
/******/ 	module.exports = __webpack_exports__;
/******/ 	
/******/ })()
;
//# sourceMappingURL=discord-rpc.js.map