import { FluxDispatcher } from "@webpack/common";
import { findByPropsLazy, findStoreLazy } from "@webpack";

const VoiceActions = findByPropsLazy("selectVoiceChannel");
const RTCConnectionStore = findStoreLazy("RTCConnectionStore");
const VoiceStateStore = findStoreLazy("VoiceStateStore");
const UserStore = findStoreLazy("UserStore");

// States that mean "there is no live media connection right now". Notably
// absent: AWAITING_ENDPOINT / AUTHENTICATING / CONNECTING / ICE_CHECKING /
// DTLS_CONNECTING - those are normal transient states *while* a connection
// is being (re)established, and we don't want to interrupt those.
const DEAD_STATES = new Set(["DISCONNECTED", "RTC_DISCONNECTED", "NO_ROUTE"]);

// How long we give the client to actually (re)establish RTC before we judge
// whether it's genuinely dead vs. still mid-handshake.
const GRACE_MS = 5000;
// Delay between forcing a leave and forcing the rejoin - selectVoiceChannel
// is a no-op if called with the channel id the client already believes it's
// connected to, so we have to actually clear local state first.
const REJOIN_DELAY_MS = 1000;

let graceTimer: ReturnType<typeof setTimeout> | null = null;
let recovering = false;

function isPhantom(): { channelId: string; } | null {
    const me = UserStore.getCurrentUser();
    if (!me) return null;

    // What the client's local voice-state cache (fed by gateway dispatches)
    // believes about us right now.
    const myVoiceState = VoiceStateStore.getVoiceStateForUser(me.id);
    if (!myVoiceState?.channelId) return null; // client doesn't think we're in a channel - nothing to do

    // What the actual underlying media/RTC connection is doing, independent
    // of the gateway-dispatched voice state above.
    const rtcState: string = RTCConnectionStore.getState();
    const rtcConnected: boolean = RTCConnectionStore.isConnected();

    if (!rtcConnected && DEAD_STATES.has(rtcState)) {
        return { channelId: myVoiceState.channelId };
    }
    return null;
}

function attemptRecovery() {
    if (recovering) return;
    const phantom = isPhantom();
    if (!phantom) return;

    recovering = true;
    const { channelId } = phantom;
    console.log(
        `[ChangeEndpoint] Voice state looks phantom (client thinks it's in ${channelId}, ` +
        `RTC state is ${RTCConnectionStore.getState()}) - forcing a real rejoin`
    );

    // Force a real leave first (clears the client's local "I'm connected"
    // belief), then rejoin the same channel a moment later so it actually
    // goes through the connect flow instead of no-op'ing.
    VoiceActions.selectVoiceChannel(null);
    setTimeout(() => {
        VoiceActions.selectVoiceChannel(channelId);
        recovering = false;
    }, REJOIN_DELAY_MS);
}

function onConnectionOpen() {
    // Give the client a chance to settle and attempt its own reconnect
    // before we judge whether the RTC connection is actually alive.
    if (graceTimer) clearTimeout(graceTimer);
    graceTimer = setTimeout(attemptRecovery, GRACE_MS);
}

function onVoiceConnectionStatus() {
    // Fires on real RTC state transitions even without a gateway reconnect
    // (e.g. the underlying connection just silently dies) - catches phantom
    // states the CONNECTION_OPEN check alone would miss.
    if (graceTimer) clearTimeout(graceTimer);
    graceTimer = setTimeout(attemptRecovery, GRACE_MS);
}

export function startVoicePhantomFix() {
    FluxDispatcher.subscribe("CONNECTION_OPEN", onConnectionOpen);
    FluxDispatcher.subscribe("VOICE_CONNECTION_STATUS", onVoiceConnectionStatus);
}

export function stopVoicePhantomFix() {
    FluxDispatcher.unsubscribe("CONNECTION_OPEN", onConnectionOpen);
    FluxDispatcher.unsubscribe("VOICE_CONNECTION_STATUS", onVoiceConnectionStatus);
    if (graceTimer) clearTimeout(graceTimer);
    recovering = false;
}
