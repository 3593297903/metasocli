# First frames

Read only for `first_frame` assets.

First frames are optional in the project. Generate one only when the upstream handoff marks that exact asset `required: true`, such as a continuation that depends on a supplied previous tail frame or a material/action match that cannot be represented safely by ordinary references.

Unlike a design board, a first frame is a single cinematic image matching the requested framing (9:16 by default). H3 first-frame mode derives the effective aspect ratio from the actual input image (`adaptive`), so do not claim a conflicting video ratio was enforced. It must depict the exact opening physical state of one segment:

- correct people, identities, clothing, poses, eyelines, positions, and occlusion;
- correct location layout, time, light, weather, and prop state;
- correct framing and camera height for the segment opening;
- a single cinematic frame at the segment's opening instant, rather than a multi-panel design board; use the supplied story state and current user requirements.

Use dependency character/scene/prop images as labeled references when available. A previous real tail frame locks physical continuity but does not automatically require copying its camera position unless the handoff says so.

Dependency images may be used by the host image generator to create this frame. They do not automatically become additional H3 inputs. The resulting video segment must use one `first_frame` input without ordinary reference images or narration audio; if the requested segment combines those modes, return `blocked` without changing the plan or dropping bindings.

As with the other asset kinds, save and display the first output and hand it off using technical file/identity/recipe checks. No automatic visual review, text recognition, score, visual receipt, retry, or per-image confirmation is part of this flow; satisfaction is the user's decision.
