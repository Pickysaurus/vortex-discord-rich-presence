import * as RPC from 'discord-rpc';
import { log, selectors, types, util } from 'vortex-api';
import gameArt from './gameart.json';
import { IDiscordRPCSessionState, IDiscordRPCSettingsState } from './reducers';
import { setCurrentActivity, setCurrentUser } from './actions';
import { IRunningTools } from './types';
import { ICollectionInstallSession } from 'vortex-api/lib/types/api';

const AppID = '594190466782724099';

export default class DiscordRPC {
    private _API: types.IExtensionApi;
    private _Client: RPC.Client | null = null;
    private connected = false;
    private iRetryAttempts: number = -1;
    private iRetryDelay: number = 10000;
    private iRetryDelayMax: number = 120000;
    private RetryTimer: NodeJS.Timeout | null = null;
    private Settings: IDiscordRPCSettingsState;
    private GetSettings = (): IDiscordRPCSettingsState => this._API.getState().settings['Discord'];
    private GetSession = (): IDiscordRPCSessionState => this._API.getState().session['Discord'];
    private settingsSyncTimer: NodeJS.Timeout | null = null;
    private AppId = AppID;
    private activityThrottleTimer: NodeJS.Timeout | null = null;
    private pendingPresence: RPC.Presence | undefined = undefined;

    constructor(api: types.IExtensionApi) {
        this._API = api;
        this.Settings = this.GetSettings();
        if (this.Settings.enabled) this.createClient();
        // Register to update settings
        this._API.onStateChange(['settings', 'Discord'], () => this.scheduleSettingsSync());

        // Register Vortex API events once
        this._API.events.on('gamemode-activated', () => this.onGameModeActivated());
        this._API.events.on('did-deploy', () => this.onDidDeploy());
        this._API.onStateChange(['settings', 'profiles', 'activeProfileId'], (prev, cur) => this.onActiveProfileChanged(prev, cur));
        this._API.onStateChange(['session', 'base', 'toolsRunning'], (prev, cur) => this.onToolsRunningChanged(prev, cur));
        this._API.onStateChange(['session', 'collections', 'activeSession'], (prev, cur) => this.onCollectionInstallProgress(prev, cur));

        // Register for custom events
        this._API.events.on('update-discord-activity', (presence: RPC.Presence) => this.setActivity(presence));
        this.setRPCGame();
    }

    getUser = () => this._Client?.user;

    private scheduleSettingsSync() {
        // Debounce updating settings by 150ms.
        if (this.settingsSyncTimer) clearTimeout(this.settingsSyncTimer);
        this.settingsSyncTimer = setTimeout(() => this.syncSettings(), 150);
    }

    private async syncSettings() {
        this.settingsSyncTimer = null;
        const newSettings = this._API.getState().settings['Discord'] || {};
        const oldSettings = this.Settings;
        log('debug', 'Updated RPC Settings', { newSettings, oldSettings });
        // console.log('Updated RPC settings', newSettings);
        this.Settings = newSettings;
        if (newSettings.enabled !== oldSettings.enabled) {
            if (newSettings.enabled) {
                if(!this._Client) {
                    this.createClient();
                    await this.login();
                }
                this.setRPCGame();
                return;
            }
            else {
                this.clearActivity();
                this.dispose();
                return;
            }
        }
        if (newSettings.showMods !== oldSettings.showMods) {
            // Refresh the RPC Game
            this.setRPCGame();
        }
        if (newSettings.showCollections !== oldSettings.showCollections) {
            const session = this.GetSession();
            if (session.presence?.details?.includes('collection') && !newSettings.showCollections) {
                this.setRPCGame();
            }
        }
    }

    private createClient() {
        if (this._Client) this._Client.removeAllListeners();
        this._Client = new RPC.Client({ transport: 'ipc' });
        this.connected = false;
        this._Client.eventNames()

        this._Client.on('ready', () => {
            const user = this._Client!.user;
            log('info', `Discord RPC - ${user.username} (${user.id}) logged into client ${this.AppId}`);
        });
        this._Client.on('error', (err) => log('error', 'Discord RPC error', err));
        this._Client.on('connected', () => log('debug', 'Discord RPC connected'));
        this._Client.on('disconnected', () => {
            log('debug', 'Discord RPC disconnected');
            this.connected = false;
        });
    }

    async login(retryLimit: number = -1): Promise<boolean> {
        if (this.connected) return true;
        if (!this._Client) this.createClient();

        // set attempts (-1 => infinite)
        this.iRetryAttempts = retryLimit;
        this.clearRetryTimer();

        try {
            await this._Client!.login({ clientId: this.AppId });
            this.connected = true;
            this.iRetryDelay = 10000; // reset backoff
            this._API.store.dispatch(setCurrentUser(this._Client.user));
            return true;
        } catch (err) {
            console.warn('DPC RPC failed', err);
            log('warn', 'Discord RPC failed to connect', err);
            this.connected = false;

            if (retryLimit === -1 || retryLimit > 0) {
                // schedule retry
                this.scheduleRetry();
            }

            return false;
        }
    }

    private scheduleRetry() {
        this.clearRetryTimer();
        const delay = Math.min(this.iRetryDelay, this.iRetryDelayMax);
        this.RetryTimer = setTimeout(async () => {
            // increase backoff (capped)
            this.iRetryDelay = Math.min(this.iRetryDelay + 10000, this.iRetryDelayMax);
            if (this.iRetryAttempts > 0) this.iRetryAttempts -= 1;

            const ok = await this.retryLogin();
            if (!ok && this.iRetryAttempts === 0) this.clearRetryTimer();
        }, delay);
    }

    async retryLogin(): Promise<boolean> {
        return this.login(this.iRetryAttempts);
    }

    private clearRetryTimer() {
        if (this.RetryTimer) {
            clearTimeout(this.RetryTimer);
            this.RetryTimer = null;
        }
    }

    async clearActivity() {
        if (!this._Client || !this.connected) return;
        // this.connected = false;
        try {
            await this._Client.clearActivity();
            this._API.store.dispatch(setCurrentActivity(undefined));
            // this._API.store.dispatch(setCurrentUser(undefined));
        }
        catch(err) {
            log('warn', 'Could not clear Discord Activity', err);
        }
    }

    private async onGameModeActivated() {
        if (!this.Settings.enabled) return;
        log('debug', 'Discord RPC updating for GameModeActivated');
        return this.setRPCGame()
    }

    private onDidDeploy() {
        if (!this.Settings.enabled) return;
        log('debug', 'Discord RPC updating for DidDeploy activated');
        this.setRPCGame();
    }

    private onActiveProfileChanged(_: string | undefined, cur: string | undefined) {
        if (!this.Settings.enabled) return;
        log('debug', 'Discord RPC updating for ActiveProfilChanged');
        // No new profile
        if (!cur) return this.setDefaultActivity();
        else {
            this.setRPCGame();
        }
    }

    private onToolsRunningChanged(prev: IRunningTools, cur: IRunningTools) {
        log('debug', 'Discord RPC updating for ToolsRunningChanged', { prev, cur });
        const prevTools = Object.keys(prev);
        const nextTools = Object.keys(cur);
        // A game or tool has been closed
        if (prevTools.length > 0 && nextTools.length === 0) {
            if (!this.connected) {
                this.createClient();
                this.login().then(() => this.setRPCGame());
            }
            else this.setRPCGame();
        }
        else {
            // A game or tool was launched, clear RPC
            if(this.Settings.hideOnGameLaunch) this.clearActivity();
            else {
                // Report what the user is doing with the tool/game
                const state = this._API.getState();
                const gameId = selectors.activeGameId(state);
                if (!gameId) return;
                const game = util.getGame(gameId);
                const tools = state.settings.gameMode.discovered?.[gameId]?.tools;
                if (!tools) return;
                const activeTool = cur[nextTools[0]];
                const activeToolInfo = Object.values(tools).find(t => t.path.toLowerCase() === activeTool.exePath.toLowerCase());
                if (!activeToolInfo) return;
                const current = this.GetSession().presence
                const toolPresence: RPC.Presence = {
                    details: activeToolInfo.defaultPrimary ? `Playing ${game.name}` : `Using ${activeToolInfo.name}`,
                    state: activeToolInfo.defaultPrimary ? current.state : game.name,
                    startTimestamp: activeTool.started
                }

                const newPresence = {...current, ...toolPresence};

                this.setActivity(newPresence);
            }
        }
    }
    
    private onCollectionInstallProgress(prev: ICollectionInstallSession, cur: ICollectionInstallSession) {
        if (!this.Settings.enabled || !this.Settings.showCollections) return;
        // Back out if there's no current state, the install count hasn't changed, or there's a timer running.
        if (!cur || cur.installedCount === prev.installedCount) return;
        // Get info from the event.
        const { collectionId, totalRequired, totalOptional, installedCount, gameId } = cur;
        const modsByGame = this._API.getState().persistent.mods[gameId];
        const collectionEntity = modsByGame?.[collectionId];
        if (!collectionEntity) return;
        // console.log('Collection session', {cur, collectionEntity});
        const game = util.getGame(gameId);

        const presence: RPC.Presence = {
            details: `Installing collection "${collectionEntity.attributes.customFileName}"...`,
            state: `Revision ${collectionEntity.attributes.modVersion} (${installedCount}/${totalRequired + totalOptional})`,
            largeImageKey: gameArt[game.id] || 'vortexlogo512',
            largeImageText: gameArt[game.id] ? game.name : 'Vortex',
            smallImageKey: gameArt[game.id] ? 'vortexlogo512' : 'nexuslogo',
            smallImageText: gameArt[game.id] ? 'Vortex by Nexus Mods' : 'Nexus Mods',
            startTimestamp: new Date(collectionEntity.attributes.installTime),
            buttons: [
                {
                    label: 'Get Collection',
                    url: `https://www.nexusmods.com/games/${gameId}/collections/${collectionEntity.attributes.collectionSlug}`
                }
            ]
        }

        return this.setActivity(presence);
        
    }

    private async setRPCGame(): Promise<void> {
        if (!this.Settings.enabled) return;

        const state = this._API.getState();
        const gameId = selectors.activeGameId(state);

        if (!gameId) {
            this.setDefaultActivity();
            return;
        }
        const game = util.getGame(gameId);
        const profile = selectors.activeProfile(state);
        if (!profile) log('warn', `No active profile for ${game.name}, could not generate Discord activity`);
        // Apparently the modState is an optional prop (but the docs say otherwise!), so can be undefined.
        const modCount = typeof profile.modState === 'object' ? Object.values(profile.modState).filter(m => m.enabled).length : 0;
        log('info', `Updating Discord RPC for ${game.id}: ${profile.id}`);

        const presence: RPC.Presence = {
            details: game.name,
            state: modCount === 1 ? `${modCount} mod installed` : `${modCount} mods installed`,
            largeImageKey: gameArt[game.id] || 'vortexlogo512',
            largeImageText: gameArt[game.id] ? game.name : 'Vortex',
            smallImageKey: gameArt[game.id] ? 'vortexlogo512' : 'nexuslogo',
            smallImageText: gameArt[game.id] ? 'Vortex by Nexus Mods' : 'Nexus Mods',
            startTimestamp: profile.lastActivated,
        }

        if (!this.Settings.showMods) delete presence.state;

        return this.setActivity(presence);
    }

    private async setDefaultActivity() {
        const presence: RPC.Presence = {
            details: 'Ready to start modding!',
            largeImageKey: 'vortexlogo512',
            largeImageText: 'Vortex',
            smallImageKey: 'nexuslogo',
            smallImageText: 'Nexus Mods'
        }

        return this.setActivity(presence);
    }

    async setActivityImpl(presence?: RPC.Presence) {
        try {
            if (!this._Client) this.createClient();

            if (!this.connected) {
                await this.login();
                if (!this.connected) return;
            }
            if (presence) {
                this._Client.setActivity(presence);
                this._API.store.dispatch(setCurrentActivity(presence));
            }
            else {
                this.clearActivity()
                this._API.store.dispatch(setCurrentActivity(undefined));
            }

        }
        catch(err) {
            log('warn','Failed to set RPC', {err, presence});
        }
    }

    async setActivity(presence?: RPC.Presence) {
        if (!this.Settings.enabled) return;
        const current = this._API.getState().session['Discord'].presence;
        const sameAsCurrent = arePresencesEqual(current, presence);
        if (sameAsCurrent) return;
        
        // If we're not throttling, send immediately
        if (!this.activityThrottleTimer) {
            this.setActivityImpl(presence);

            this.activityThrottleTimer = setTimeout(() => {
                this.activityThrottleTimer = null;

                if (this.pendingPresence !== undefined) {
                    const next = this.pendingPresence;
                    this.pendingPresence = undefined;
                    this.setActivity(next);
                }
            }, 5000);

            return;
        }
        
        // Save the desired next presence ready for the trailing update
        this.pendingPresence = presence;        
    }

    dispose() {
        this.clearRetryTimer();
        if (this.activityThrottleTimer) clearTimeout(this.activityThrottleTimer);
        this.activityThrottleTimer = null;
        this.pendingPresence = undefined;
        if (this._Client) {
            this._Client.removeAllListeners();
            try {
                // destroy if available
                // @ts-ignore
                if (typeof this._Client.destroy === 'function') this._Client.destroy();
            } catch {}
            this._Client = null;
        }
    }
}

function arePresencesEqual(a?: RPC.Presence, b?: RPC.Presence) {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.details === b.details
    && a.state === b.state
    && a.largeImageKey === b.largeImageKey
    && a.smallImageKey === b.smallImageKey
    && a.largeImageText === b.largeImageText
    && a.smallImageText === b.smallImageText;
}