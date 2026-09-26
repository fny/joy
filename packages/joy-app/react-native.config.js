module.exports = {
    dependencies: {
        'onnxruntime-react-native': {
            // ORT ships legacy unimodule metadata but implements a ReactPackage.
            // Explicitly select RN autolinking; Expo otherwise skips it on Android.
            platforms: { android: {} },
        },
    },
};
