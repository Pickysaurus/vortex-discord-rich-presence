import { log, types } from 'vortex-api';
import discordRpcReducers, { discordRpcSessionReducer } from './reducers';
import DiscordRPC from './DiscordRPC';
import DiscordSettings from './Settings';

export default function main(context: types.IExtensionContext) {
    // Create the client
    let client: DiscordRPC

    context.registerSettings(
        'Vortex',
        DiscordSettings,
        () => ({}),
        () => true,
        150
    );

    context.registerReducer(['settings', 'Discord'], discordRpcReducers);
    context.registerReducer(['session', 'Discord'], discordRpcSessionReducer);

    context.once(async () => {
        client = new DiscordRPC(context.api);
        log('debug', 'Discord RPC client created');
        try {
            client.login();
        }
        catch(err) {
            log('warn', 'Failed to log in to Discord via RPC', err);
        }

    });
}