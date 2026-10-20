# Generated media identity audit and repair boundary

The audit traces metadata only; filenames, numeric image IDs and suffixes are not identity evidence.

| Stage | Input / available fields | Output / first loss |
| --- | --- | --- |
| `parseTakeoutHtmlBlocks` | Activity chat link, timestamp, prompt, generated-image count marker; source block order and model message position | Previously `.test()` discarded count; `genBlocks` retained only chatId/time/prompt. Generation ordinal and model position were never recorded. |
| `correlateGeneratedImages` | ZIP filename/fileObj and C2PA time (ZIP date fallback), activity event records | Selects the generation event using the existing time correlation; no stable multi-image ordinal is provided by the source. |
| `linkTakeoutGeneratedImage` | Selected event plus selected image | Previously wrote filename/fileObj/isGenerated and discarded selected event metadata; attached to first model message. |
| `mediaIndex.commitTakeoutData` | mediaMap/globalMedia/convCache | Stores objects directly; it does not strip fields. |
| `supplementTakeoutGeneratedMedia` | Online model media plus committed Takeout media | Previously matched filenames across the entire conversation and appended unmatched media to last model message. |

The smallest identity is chat + event time + prompt + generation ordinal, with source-proven image ordinal. Store it on the media entry as `generation`, and on its associated model message. Preserve count and the exact model position while parsing; assign generation ordinals in chronological event order. A one-image event establishes imageOrdinal=0. ZIP enumeration order is not evidence of a cross-source image ordinal.

The existing cleaned Takeout fixture contains the real astronaut-cat event: chat `1bd028d5c5b0c0e2`, activity time `2026-09-02T18:36:40Z`, one generated image, and the astronaut-cat prompt. The previous online export records `18:36:40.472Z` and the same prompt. The two source filenames are `watermarked_img_4528137010801751197.jpg` and `watermarked_img_45281370108017511-1c81efe352c9ef8a.png`. Regression tests parse the real ZIP and verify metadata reaches MediaIndex and only one Canonical image remains.

Cross-source resolution requires a unique user prompt with the same recorded event second, followed by one model response, or an explicit matching generation identity. Generated status comes from the existing RPC generated-media detector. Single-image events can safely reconcile the two source formats. Multiple images require explicit matching image ordinals; ambiguous or missing metadata retains media. Different event times, repeated same-second prompts, and unknown multi-image ordering never justify suppression. This conservative boundary intentionally leaves unresolved multi-image duplicates visible rather than deleting potentially distinct images.

A reconciled online image keeps the event identity for resource acquisition. AssetPipeline passes that identity to the existing Takeout byte provider, which requires an exact event + image ordinal match before returning bytes. This preserves offline recovery across JPG/PNG filenames without adding a second rendered asset or a filename mapping heuristic.
