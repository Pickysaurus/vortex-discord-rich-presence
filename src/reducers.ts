import { setRPCSetting, setCurrentActivity, setCurrentUser } from './actions';
import { types, util } from 'vortex-api';
import * as RPC from 'discord-rpc';

export interface IDiscordRPCSettingsState {
    enabled: boolean;
    showMods: boolean;
    showCollections: boolean;
    hideOnGameLaunch: boolean;
}

export interface IDiscordRPCSessionState {
    user?: RPC.User & { bot: boolean, flags: number, global_name: string, premium_type: number };
    presence?: RPC.Presence;
}

const discordRpcReducers: types.IReducerSpec<IDiscordRPCSettingsState> = {
    reducers: {
        [setRPCSetting as any]: (state, payload: { key: keyof IDiscordRPCSettingsState, value: boolean }) => {
            return util.setSafe(state, [payload.key], payload.value)
        },
        
    },
    defaults: {
        enabled: true,
        showMods: true,
        showCollections: true,
        hideOnGameLaunch: true,
    }
}

export const discordRpcSessionReducer: types.IReducerSpec<IDiscordRPCSessionState> = {
    reducers: {
        [setCurrentActivity as any]: (state, payload) => {
            if (payload.presence) return util.setSafe(state, ['presence'], payload.presence);
            else return util.deleteOrNop(state, ['presence']);
        },
        [setCurrentUser as any]: (state, payload) => {
            if (payload.user) return util.setSafe(state, ['user'], payload.user);
            else return util.deleteOrNop(state, ['user']);
        }
    },
    defaults: {}
}

export default discordRpcReducers;
