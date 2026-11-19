/**
 * Loaded before every test file (bunfig.toml). Daemons that tests start, in
 * process or as child processes (which inherit this), never show the
 * operating system's presence prompt: the switch only removes that way to
 * ask (src/presence/native.ts), so checks fall back to the app's passkey.
 */
process.env.PULSAR_NATIVE_PRESENCE = "off";
/**
 * Idle shows at once in tests (src/service/registry.ts holds it a few seconds
 * in real use); tests of that hold set `idleSettleMs` themselves.
 */
process.env.PULSAR_IDLE_SETTLE_MS = "0";
