module.exports = function (api) {
  // Mod 10: vary cache by platform/env so component-info is only injected for web/dev.
  // Include the plugin file's mtime so editing the plugin always busts cached transforms,
  // even for source files whose own content didn't change.
  const platform = api.caller((caller) => caller && caller.platform);
  const isWeb = platform === 'web';
  const isProduction = api.env('production');
  // Component-info is a dev-only inspection aid by default, but it can be
  // force-enabled for a production web export (e.g. a hosted preview/tailnet
  // page) by setting EXPO_PUBLIC_COMPONENT_INFO=1 at build time.
  const forceComponentInfo = process.env.EXPO_PUBLIC_COMPONENT_INFO === '1';
  const enableComponentInfo = isWeb && (!isProduction || forceComponentInfo);
  let componentInfoMtime = 0;
  if (enableComponentInfo) {
    try {
      componentInfoMtime = require('node:fs').statSync(
        require.resolve('./babel-plugin-component-info.cjs'),
      ).mtimeMs;
    } catch (_e) {}
  }
  api.cache.using(
    () => `${platform || 'unknown'}:${isProduction ? 'prod' : 'dev'}:${forceComponentInfo ? 'ci1' : 'ci0'}:${componentInfoMtime}`,
  );

  // Determine which worklets plugin to use based on installed versions
  // Reanimated v4+ uses react-native-worklets/plugin
  // Reanimated v3.x uses react-native-reanimated/plugin
  let workletsPlugin = 'react-native-worklets/plugin';
  try {
    const reanimatedVersion = require('react-native-reanimated/package.json').version;
    const majorVersion = parseInt(reanimatedVersion.split('.')[0], 10);

    // For Reanimated v3.x, use the old plugin
    if (majorVersion < 4) {
      workletsPlugin = 'react-native-reanimated/plugin';
    }
  } catch (e) {
    // If reanimated isn't installed, default to newer plugin
    // This won't cause issues since the plugin won't be needed anyway
  }

  const componentInfoPlugin = enableComponentInfo
    ? [require.resolve('./babel-plugin-component-info.cjs')]
    : [];

  return {
    presets: ['babel-preset-expo'],
    plugins: [
      ...componentInfoPlugin,
      ['react-native-unistyles/plugin', { root: 'sources' }],
      workletsPlugin // Must be last - automatically selects correct plugin for version
    ],
  };
};