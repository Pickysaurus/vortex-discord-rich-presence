import * as RPC from 'discord-rpc';
import { log, selectors, types, util } from 'vortex-api';
import gameArt from './gameart.json';
import { IDiscordRPCSettingsState } from './reducers';
import { setCurrentActivity, setCurrentUser } from './actions';
import { IRunningTools } from './types';
import { ICollectionInstallSession, IProfile, IRunningTool } from 'vortex-api/lib/types/api';

const AppID = '594190466782724099';

export default class DiscordRPC {
    public enabled = false;
    public currentActivity: RPC.Presence | null = null;
    private _API: types.IExtensionApi;
    private _Client: RPC.Client;
    private clientId: string | null = null;
    private connected = false;
    private iRetryAttempts: number | undefined;
    private iRetryDelay: number = 10000;
    private iRetryDelayMax: number = 120000;
    private RetryTimer: NodeJS.Timeout | undefined;
    private Settings: IDiscordRPCSettingsState;
    private GetSettings = (api: types.IExtensionApi): IDiscordRPCSettingsState => api.getState().settings['Discord'];
    private settingsSyncTimer: NodeJS.Timeout | null = null;
    private AppId = AppID;
    private ActivityUpdateTimer: NodeJS.Timeout | null = null;

    constructor(api: types.IExtensionApi) {
        this._API = api;
        this.Settings = this.GetSettings(api);
        if (this.Settings.enabled) this.createClient();
        // Register to update settings
        this._API.onStateChange(['settings', 'Discord'], () => this.scheduleSettingsSync());

        // Register Vortex API events once
        this._API.events.on('gamemode-activated', (mode: string) => this.onGameModeActivated(mode));
        this._API.events.on('did-deploy', () => this.onDidDeploy());
        this._API.onStateChange(['settings', 'profiles', 'activeProfileId'], (prev, cur) => this.onActiveProfileChanged(prev, cur));
        this._API.onStateChange(['session', 'base', 'toolsRunning'], (prev, cur) => this.onToolsRunningChanged(prev, cur));
        this._API.onStateChange(['session', 'collections', 'activeSession'], (prev, cur) => this.onCollectionInstallProgress(prev, cur));

        // Register for custom events
        this._API.events.on('update-discord-activity', (presence: RPC.Presence) => this.setActivity(presence));
    }

    getUser = () => this._Client.user;

    private scheduleSettingsSync() {
        // Debounce updating settings by 150ms.
        if (this.settingsSyncTimer) clearTimeout(this.settingsSyncTimer);
        this.settingsSyncTimer = setTimeout(() => this.syncSettings(), 150);
    }

    private syncSettings() {
        this.settingsSyncTimer = null;
        const newSettings = this._API.getState().settings['Discord'] || {};
        const oldSettings = this.Settings || { enabled: true };
        log('debug', 'Updated RPC Settings', { newSettings, oldSettings });
        console.log('Updated RPC settings', newSettings);
        this.Settings = newSettings;
        if (newSettings.enabled !== oldSettings.enabled) {
            if (newSettings.enabled) {
                this.login();
                const currentGame = selectors.activeGameId(this._API.getState());
                this.setRPCGame(currentGame);
            }
            else {
                this.clearActivity().catch(() => {});
                this.dispose();
            }
            return;
        }
    }

    private createClient() {
        if (this._Client) this._Client.removeAllListeners();
        this._Client = new RPC.Client({ transport: 'ipc' });

        this._Client.on('ready', () => {
            const user = this._Client!.user;
            log('info', `Discord RPC - ${user.username} (${user.id}) logged into client ${this.clientId}`);
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
            this.enabled = false;

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
        this.currentActivity = null;
        this.connected = false;
        this._API.store.dispatch(setCurrentActivity(undefined));
        this._API.store.dispatch(setCurrentUser(undefined));
        await this._Client.clearActivity();
    }

    private async onGameModeActivated(newMode: string) {
        log('debug', 'Discord RPC updating for GameModeActivated');
        return this.setRPCGame(newMode)
    }

    private onDidDeploy() {
        log('debug', 'Discord RPC updating for DidDeploy activated');
        const state = this._API.getState();
        const activeGameId = selectors.activeGameId(state);
        this.setRPCGame(activeGameId);
    }

    private onActiveProfileChanged(_, cur: IProfile) {
        log('debug', 'Discord RPC updating for ActiveProfilChanged');
        // No new profile
        if (!cur) return this.clearActivity();
        else {
            const state = this._API.getState();
            const activeGameId = selectors.activeGameId(state);
            this.setRPCGame(activeGameId);
        }
    }

    private onToolsRunningChanged(prev: IRunningTools, cur: IRunningTools) {
        log('debug', 'Discord RPC updating for ToolsRunningChanged');
        const prevTools = Object.keys(prev);
        const nextTools = Object.keys(cur);
        // A game or tool has been closed
        if (prevTools.length > 0 && nextTools.length === 0) {
            const state = this._API.getState();
            const activeGameId = selectors.activeGameId(state);
            this.setRPCGame(activeGameId);
        }
        else {
            // A game or tool was launched, clear RPC
            this.clearActivity();
        }
    }
    
    private onCollectionInstallProgress(prev: ICollectionInstallSession, cur: ICollectionInstallSession) {
        // Back out if there's no current state, the install count hasn't changed, or there's a timer running.
        if (!cur || cur.installedCount === prev.installedCount || this.ActivityUpdateTimer) return;
        // Get info from the event.
        const { collectionId, totalRequired, totalOptional, installedCount, gameId } = cur;
        const collectionEntity = this._API.getState().persistent.mods[gameId][collectionId];
        console.log('Collection session', {cur, collectionEntity});
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

    private async setRPCGame(gameId?: string): Promise<void> {
        if (!this.Settings.enabled) return;
        if (!gameId) {
            this.setDefaultRPC();
            return;
        }

        const state = this._API.getState();
        const game = util.getGame(gameId);
        const profile = selectors.activeProfile(state);
        const modCount = Object.values(profile.modState).filter(m => m.enabled).length;
        log('info', `Updating Discord RPC for ${game.id}: ${profile.id}`);

        const presence: RPC.Presence = {
            details: game.name,
            state: modCount === 1 ? `${modCount} mod installed` : `${modCount} mods installed`,
            largeImageKey: gameArt[game.id] || 'vortexlogo512',
            largeImageText: gameArt[game.id] ? game.name : 'Vortex',
            smallImageKey: gameArt[game.id] ? 'vortexlogo512' : 'nexuslogo',
            smallImageText: gameArt[game.id] ? 'Vortex by Nexus Mods' : 'Nexus Mods',
        }

        return this.setActivity(presence);
    }

    private async setDefaultRPC() {
        const presence: RPC.Presence = {
            details: 'Vortex Mod Manager',
            state: 'Ready to start modding!',
            largeImageKey: 'vortexlogo512',
            largeImageText: 'Vortex',
            smallImageKey: 'nexuslogo',
            smallImageText: 'Nexus Mods'
        }

        return this.setActivity(presence);
    }

    async setActivityImpl(presence?: RPC.Presence) {
        this.ActivityUpdateTimer = null; // Clear the value for the timer
        try {

            if (!this.connected) {
                await this.login();
                if (!this.connected) return;
            }
            if (presence) {
                this.currentActivity = presence;
                this._Client.setActivity(presence);
                this._API.store.dispatch(setCurrentActivity(presence));
            }
            else {
                this.clearActivity()
                this._API.store.dispatch(setCurrentActivity(undefined));
            }

        }
        catch(err) {
            log('warn','Failed to set RPC', err);
        }
    }

    async setActivity(presence?: RPC.Presence) {
        const current = this._API.getState().session['Discord'].presence;
        const sameAsCurrent = JSON.stringify(current) === JSON.stringify(presence);
        if (sameAsCurrent) return;
        // Debounce updating activity by 5s.
        if (this.ActivityUpdateTimer) {
            clearTimeout(this.ActivityUpdateTimer);
            this.ActivityUpdateTimer = setTimeout((presence) => this.setActivityImpl(presence), 5000, presence);
        }
        // Do it immediately if there's nothing queued.
        else this.setActivityImpl(presence);
        
    }

    dispose() {
        this.clearRetryTimer();
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