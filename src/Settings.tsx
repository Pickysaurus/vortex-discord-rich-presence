import React from 'react';
import { ControlLabel, FormGroup, Panel } from 'react-bootstrap';
import { useSelector, useStore } from 'react-redux';
import { Toggle, More, types } from 'vortex-api';
import { setRPCSetting } from './actions';
import { IDiscordRPCSessionState, IDiscordRPCSettingsState } from './reducers';

function DiscordSettings() {
    const { enabled }: IDiscordRPCSettingsState = useSelector((state: types.IState) => state.settings['Discord']);
    const { user }: IDiscordRPCSessionState = useSelector((state: types.IState) => state.session['Discord']);
    // const state = useSelector((state: types.IState) => state);
    const store = useStore();

    const setRPCEnabled = React.useCallback((enabled: boolean) => {
        store.dispatch(setRPCSetting('enabled', enabled));
    }, []);

    return (
        <form>
            <FormGroup controlId=''>
                <Panel>
                    <ControlLabel>Discord Integration</ControlLabel>
                    <Toggle
                        checked={enabled}
                        // Ignoring due to some weird type issue. Probably a fault with the Vortex component.
                        // @ts-ignore
                        onToggle={setRPCEnabled}
                    >
                        Enable Discord Rich Presence
                        <More id='discord-master-enable' name='Discord Rich Presence'>
                            Shows your Vortex activity in Discord for your friends to see.
                        </More>
                    </Toggle>
                    {user && (
                        <div>
                            <p>Connected to Discord as:</p>
                            <div style={{ display: 'flex', gap: 4, justifyItems: 'center'}}>
                                <img 
                                    src={`https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png`} 
                                    width={20} 
                                    height={20} 
                                    alt={user.username} 
                                    style={{borderRadius: 25}}
                                />
                                <p title={`${user.username} (${user.id})`}><strong>{user.global_name ?? user.username}</strong></p>
                            </div>
                        </div>
                    )}
                    {!user && <p>Not connected to Discord</p>}
                </Panel>
                {/* <a onClick={() => console.log(state)}>Print State</a> */}
            </FormGroup>
        </form>
    );
}

export default DiscordSettings;