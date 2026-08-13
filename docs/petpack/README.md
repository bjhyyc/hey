# Hey PetPack canonical contract

The shared source of truth for the seven-video package is:

- `src/shared/hey-petpack-behavior-v1.json`
- `src/shared/hey-petpack-contract.js`

The cloud packager must call `createHeyPetpackManifest()` and provide the measured duration of every final, post-processed WebM. The nominal prompt durations are test fixtures only; production must replace them with `ffprobe` results rounded to integer milliseconds.

Required files in the archive:

```text
manifest.json
preview.png
assets/idle.webm
assets/sneeze.webm
assets/roll.webm
assets/sleep-transition.webm
assets/sleep-loop.webm
assets/stretch.webm
assets/hover-attention.webm
```

`hover-attention` is the interaction slot. In the recovered stable prompt set its visible action is paw grooming (`舔脚`); the semantic ID describes how it is triggered, not a different unrecovered video.

The idle rule dispatches `sleep-transition` and `sleep-loop` immediately in that order. The animation controller protects the one-shot transition and queues the loop at its boundary, so no artificial delay belongs in the manifest.

The package contains no green-screen configuration. Chroma removal, edge cleanup, normalization and alpha encoding happen before packaging. It also contains no random timer, movement, props, drops, messages or panel action.
