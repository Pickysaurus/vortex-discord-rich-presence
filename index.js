const { log, selectors, util } = require('vortex-api');
const DiscordRPC = require('discord-rpc');
const clientId = '594190466782724099';
let RPC = new DiscordRPC.Client({transport: 'ipc' });
const gameArt = require('./gameart.json');
let rpcEnabled = true;
let connected = false;

function main(context) {

    context.registerAction('global-icons', 100, 'show', {}, 'Discord Rich Presence: ON', () => {
        RPC.clearActivity().catch(err => { return alertError(err, context.api) });
        context.api.sendNotification(
            {
                type: 'info', 
                message: 'Discord Rich Presence Disabled',
                displayMS: 2000 
            }
        );
        rpcEnabled = !rpcEnabled;
    },
    () => {return (rpcEnabled === true)});

    context.registerAction('global-icons', 100, 'hide', {}, 'Discord Rich Presence: OFF', async () => {
        await loginRPC();
        if (!connected) return alertError('Could not connect to Discord RPC', context.api);
        const state = context.api.store.getState();
        const activeGameId = selectors.activeGameId(state);
        return setRPCGame(state, activeGameId).then(() => {
            context.api.sendNotification(
                {
                    type: 'info', 
                    message: 'Discord Rich Presence Enabled',
                    displayMS: 2000 
                }
            );
            rpcEnabled = !rpcEnabled;
        })
        .catch(err => { return alertError(err, context.api) });
    },
    () => {return (rpcEnabled === false)});

    context.once(() => {
        // When we change game, update the RPC
        context.api.events.on('gamemode-activated', (newMode) => rpcEnabled ? setRPCGame(context.api.store.getState(), newMode).catch(() => log('debug', 'Discord RPC failed to set.')) : undefined);

        // When we deploy our mods, update the RPC
        context.api.events.on('did-deploy', () => {
            if (!rpcEnabled) return;
            const state = context.api.store.getState();
            const activeGameId = selectors.activeGameId(state);
            setRPCGame(state, activeGameId).catch(err => { return alertError(err, context.api) });;
        });

        // When we change profile, update the RPC
        context.api.onStateChange(['settings', 'profiles', 'activeProfileId'], (previous, current) => {
            if (!rpcEnabled) return;
            // If we go to no profile at all, clear the RPC.
            if (!current) return RPC.clearActivity().catch(err => { return alertError(err, context.api) });;

            // Update the RPC data.
            const state = context.api.store.getState();
            const currentProfile = selectors.profileById(state, current);
            setRPCGame(state, currentProfile.gameId, currentProfile).catch(() => undefined);

        });

        // When we launch/close a game clear/update RPC.
        context.api.onStateChange(['session', 'base', 'toolsRunning'], (previous, current) => {
            if (!rpcEnabled) return;
            if ((Object.keys(previous).length > 0) && (Object.keys(current).length === 0)) {
                // We've just closed a game
                const state = context.api.store.getState();
                const activeGameId = selectors.activeGameId(state);
                setRPCGame(state, activeGameId).catch(() => undefined);
            }
            else {
                RPC.clearActivity()
                .catch(err => log('info', 'Error clearing Discord RPC status.', err));
            };
        });
    });
}

function setRPCGame(state, newMode, currentProfile) {
    return new Promise((resolve, reject) => {
        if (!newMode || !state) {
            return RPC.clearActivity().then(()=> resolve())
            .catch(err => reject(err));
        }

        const game = util.getGame(newMode);
        const profile = currentProfile || selectors.activeProfile(state);
        const mods = profile.modState ? Object.keys(profile.modState) : [];
        const modArray = mods.map(m => profile.modState[m]);
        const modCount = modArray.filter(m => m.enabled).length;
        log('info', 'Updating Discord RPC for ', game.id, profile.id);

        const activity = getArtwork(game);
        activity.details = game.name;
        activity.state = modCount === 1 ? `${modCount} mod installed` : `${modCount} mods installed`;
        // activity.startTimestamp = profile.lastActivated;

        return RPC.setActivity(activity).then(() => resolve())
        .catch(err => { 
            log('info', 'Setting RPC activity failed.', err);
            rpcEnabled = false;
            return reject(err);
        });
    });
}

function getArtwork(game) {
    return {
        largeImageKey : gameArt[game.id] || 'vortexlogo512',
        largeImageText : gameArt[game.id] ? game.name : 'Vortex',
        smallImageKey : gameArt[game.id] ? 'vortexlogo512' : 'nexuslogo',
        smallImageText : gameArt[game.id] ? 'Vortex by Nexus Mods' : 'Nexus Mods',
    };
}

function alertError(error, api) {
    // Something went wrong setting RPC status.
    log('warn', 'Discord RPC error', error);
    rpcEnabled = false;
    api.sendNotification(
        {
            type: 'warning', 
            title: 'Failed to set Discord Rich Presence',
            message: 'Please ensure Discord is running and try again.',
            displayMS: 2000 
        }
    );
}

RPC.on('ready', () =>  log('info', `Discord RPC - ${RPC.user.username}#${RPC.user.discriminator} logged into client ${RPC.clientId} `));
// Catch errors
RPC.on('error', (err) => log('error', 'Discord RPC error', err));
RPC.on('connected', () => log('debug', 'Discord RPC connected'));
RPC.on('discconnected', () => {
    log('debug', 'Discord RPC disconnected');
    connected = false;
});

async function loginRPC() {
    if (connected) return true;

    // Try making a new RPC instance first.
    RPC = new DiscordRPC.Client({transport: 'ipc' });

    return RPC.login({ clientId })
        .then(() => {
            connected = true;
            return connected;
        })
        .catch((err) => {
            log('warn', 'Discord RPC failed to connect', err);
            connected = false;
            rpcEnabled = false;
            return connected;
        });
}

loginRPC();

module.exports = { default: main };