// RN autolinking supplies the module path in this hoisted monorepo. The vendor
// Expo plugin hardcodes ../node_modules and is unsuitable for this layout.
// Pin native binaries too: upstream uses an unversioned pod and latest.integration.
const { withProjectBuildGradle, withPodfile } = require('@expo/config-plugins');
const { mergeContents } = require('@expo/config-plugins/build/utils/generateCode');
module.exports = function withPocketRuntime(config) {
    config = withProjectBuildGradle(config, mod => {
        if (mod.modResults.language !== 'groovy') throw new Error('Pocket runtime requires a Groovy root build.gradle');
        mod.modResults.contents = mergeContents({
            src: mod.modResults.contents,
            newSrc: `allprojects {
    configurations.configureEach {
        resolutionStrategy.eachDependency { details ->
            if (details.requested.group == 'com.microsoft.onnxruntime' && details.requested.name == 'onnxruntime-android') {
                details.useVersion '1.24.3'
            }
        }
    }
}`,
            tag: 'joy-pocket-runtime', anchor: /^/, offset: mod.modResults.contents.split('\n').length, comment: '//',
        }).contents;
        return mod;
    });
    return withPodfile(config, mod => {
        mod.modResults.contents = mergeContents({
            src: mod.modResults.contents,
            newSrc: "  pod 'onnxruntime-c', '1.24.3'",
            tag: 'joy-pocket-runtime', anchor: /^target .+ do$/, offset: 1, comment: '#',
        }).contents;
        return mod;
    });
};
