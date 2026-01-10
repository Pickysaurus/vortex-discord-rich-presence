import { createAction } from 'redux-act';

export const setRPCSetting = createAction(
    'SET_DISCORD_RPC_SETTING', 
    (key: string, value: unknown) => ({ key, value })
);

export const setCurrentActivity = createAction(
    'SET_DISCORD_RPC_ACTIVITY',
    (presence) => ({ presence })
);

export const setCurrentUser = createAction(
    'SET_DISCORD_RPC_USER',
    (user) => ({ user })
);