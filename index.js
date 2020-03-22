const { log, selectors, util } = require('vortex-api');
const DiscordRPC = require('discord-rpc');
const clientId = '594190466782724099';
const RPC = new DiscordRPC.Client({transport: 'ipc' });
const gameArt = require('./gameart.json');

function main(context) {
    context.once(() => {
        // When we change game, update the RPC
        context.api.events.on('gamemode-activated', (newMode) => setRPCGame(context.api.store.getState(), newMode));

        // When we deploy our mods, update the RPC
        context.api.events.on('did-deploy', () => {
            const state = context.api.store.getState();
            const activeGameId = selectors.activeGameId(state);
            setRPCGame(state, activeGameId);
        });

        // When we change profile, update the RPC
        context.api.onStateChange(['settings', 'profiles', 'activeProfileId'], (previous, current) => {
            // If we go to no profile at all, clear the RPC.
            if (!current) return RPC.clearActivity();

            // Update the RPC data.
            const state = context.api.store.getState();
            const currentProfile = selectors.profileById(state, current);
            setRPCGame(state, currentProfile.gameId, currentProfile);

        });

        // When we launch/close a game clear/update RPC.
        context.api.onStateChange(['session', 'base', 'toolsRunning'], (previous, current) => {
            if ((Object.keys(previous).length > 0) && (Object.keys(current).length === 0)) {
                // We've just closed a game
                const state = context.api.store.getState();
                const activeGameId = selectors.activeGameId(state);
                setRPCGame(state, activeGameId);;
            }
            else {
                RPC.clearActivity();
            };
        });
    });
}

function setRPCGame(state, newMode, currentProfile) {
    if (!newMode || !state) return RPC.clearActivity();

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

    RPC.setActivity(activity).catch(console.error);
}

function getArtwork(game) {
    return {
        largeImageKey : gameArt[game.id] || 'vortexlogo512',
        largeImageText : gameArt[game.id] ? game.name : 'Vortex',
        smallImageKey : gameArt[game.id] ? 'vortexlogo512' : 'nexuslogo',
        smallImageText : gameArt[game.id] ? 'Vortex by Nexus Mods' : 'Nexus Mods',
    };
}

RPC.on('ready', () =>  log('info', `Discord RPC - ${RPC.user.username}#${RPC.user.discriminator} logged into client ${RPC.clientId} `));

RPC.login({ clientId }).catch(console.error);

module.exports = { default: main };