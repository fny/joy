# Pocket speech: third-party notices

Joy runs Pocket TTS locally. There is no affiliation with or endorsement by Kyutai, Microsoft, the model exporters or the voice performers.

## Inference code

The tokenizer and shared inference algorithm are adapted from [vlapky/pocket-tts-js](https://github.com/vlapky/pocket-tts-js/tree/7d7a27423b0845eb0425c81a8aa5ed3f3d973eef), copyright (c) 2026 vlapky, MIT. The complete license is in [LICENSE](LICENSE). Joy adds platform adapters, hash-verified caching, resource disposal, cancellation, generation limits and different text chunking. Voice cloning and CDN executable imports have been removed.

The upstream implementation credits the [KevinAHM Pocket TTS ONNX reference implementation](https://huggingface.co/spaces/KevinAHM/pocket-tts). Its Apache 2.0 code license is retained in [LICENSE-APACHE-2.0](LICENSE-APACHE-2.0). Code and model licenses are separate.

## Models

[Pocket TTS](https://huggingface.co/kyutai/pocket-tts) is by Kyutai. Its weights use [Creative Commons Attribution 4.0 International](https://creativecommons.org/licenses/by/4.0/). The Python implementation uses [MIT](https://github.com/kyutai-labs/pocket-tts/blob/main/LICENSE); Joy does not embed Python.

Joy downloads the English April 2026 INT8 [ONNX export](https://huggingface.co/vlapky/pocket-tts-onnx/tree/c469236dbc5f68287fa2fbf175b66de3b80123af) by vlapky, based on the KevinAHM export. That repository declares CC BY 4.0. Export/quantization are modifications to the Kyutai weights. Joy does not modify those model files. `assets.json` records the immutable revision, byte sizes and SHA-256 hashes; `bundle.json` is the accompanying model configuration. The CC BY 4.0 license text is in [LICENSE-CC-BY-4.0](LICENSE-CC-BY-4.0).

## Voices

Voice states are adaptations of recordings distributed by [Kyutai's voice repository](https://huggingface.co/kyutai/tts-voices). Its [per-directory license information](https://huggingface.co/kyutai/tts-voices/blob/main/README.md) takes precedence over a model export's blanket voice-license description.

| Preset | Recording/source | License |
| --- | --- | --- |
| Alba | Alba MacKenna, `alba-mackenna/casual.wav` | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) |
| Marius | Unmute Voice Donation Project, `voice-donations/Selfie.wav` | [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/) |
| Javert | Unmute Voice Donation Project, `voice-donations/Butter.wav` | [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/) |
| Fantine | VCTK, `vctk/p244_023_enhanced.wav` | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) |
| Éponine | VCTK, `vctk/p262_023_enhanced.wav` | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) |
| Azelma | VCTK, `vctk/p303_023_enhanced.wav` | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) |

VCTK: [CSTR VCTK Corpus](https://datashare.ed.ac.uk/handle/10283/3443), Junichi Yamagishi, Christophe Veaux and Kirsten MacDonald, University of Edinburgh (2019). Recordings selected/enhanced by Kyutai, then converted to voice-state tensors in the upstream model export.

Joy fetches only the chosen voice’s individual safetensors file from [Kyutai’s English April 2026 voice states](https://huggingface.co/kyutai/pocket-tts-without-voice-cloning/tree/d29db7978e464fb90cb3359ee0c69a273b9142cc/languages/english_2026-04/embeddings). These contain precomputed conditioning caches, derived from the recordings above. Joy decodes them into ONNX tensors without modifying the downloaded file. Each is pinned by revision, byte size and SHA-256 in `assets.json`.

Jean (EARS) and Cosette (Expresso) are deliberately excluded: their recordings use CC BY-NC 4.0. Joy neither downloads nor synthesizes those voices. Old selections fall back to Alba.

## Runtime

[ONNX Runtime](https://github.com/microsoft/onnxruntime/tree/v1.24.3), copyright Microsoft Corporation, MIT. Joy pins `onnxruntime-web` and `onnxruntime-react-native` to 1.24.3. The web asset preparation script copies the runtime's license alongside its files. Native packages retain their upstream notices.

All software, models and voice assets are provided without warranties, subject to their respective licenses and disclaimers. Attribution does not grant endorsement or personality rights.
