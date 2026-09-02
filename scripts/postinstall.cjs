// Apply patches to node_modules (joy-app native/web deps).
require('../patches/expose-pierre-diffs-style.cjs');
require('../patches/force-preact-cjs.cjs');
require('../patches/fix-pierre-trees-preact-hooks.cjs');
// Voice: force the /rtc (v0) LiveKit path and fix a size_t build error.
require('../patches/fix-livekit-room-reuse.cjs');
require('../patches/fix-react-native-audio-api-size-t.cjs');
