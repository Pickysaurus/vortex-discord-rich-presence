import { setRPCSetting, setCurrentActivity, setCurrentUser } from './actions';
import { types, util } from 'vortex-api';
import * as RPC from 'discord-rpc';

export interface IDiscordRPCSettingsState {
    enabled: boolean;
}

export interface IDiscordRPCSessionState {
    user?: any;
    presence?: RPC.Presence & { bot: boolean, flags: number, global_name: string, premium_type: number };
}

const discordRpcReducers: types.IReducerSpec<IDiscordRPCSettingsState> = {
    reducers: {
        [setRPCSetting as any]: (state, payload) => {
            return util.setSafe(state, [payload.key], payload.value)
        },
        
    },
    defaults: {
        enabled: true,
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
